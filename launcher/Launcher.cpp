// Launcher.exe: the game's start window. Checks GitHub for a newer engine and
// game, installs them (NativeThree-Updater.exe does the work and reports one
// line per step), and only then enables the start button. It stays open with
// "Laen mängu…" until the game window is on screen.
//
// Layout (see the sketch in the v0.36.0 notes): game picture with the name
// and the latest changes, engine and game versions with a red/green ring,
// status text over the download progress, start button.
//
// Options: --autostart (start as soon as everything is current; CI),
//          --self-test (version and protocol checks, no window).
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00 // per-monitor DPI (Windows 10)
#endif
#include <windows.h>
#include <windowsx.h>
#include <d2d1.h>
#include <dwrite.h>
#include <wincodec.h>
#include <wrl/client.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdio>
#include <cwchar>
#include <functional>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#pragma comment(lib, "user32.lib")
#pragma comment(lib, "d2d1.lib")
#pragma comment(lib, "dwrite.lib")
#pragma comment(lib, "windowscodecs.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "shell32.lib")

using Microsoft::WRL::ComPtr;

namespace {

enum class Phase { Checking, UpdatingEngine, UpdatingGame, Ready, Offline, Failed, Starting };

struct NewsItem { std::wstring date, source, text; };

struct State {
    std::wstring name, image, engine, engineLatest, gameVersion, gameLatestVersion, gameCommit, gameLatestCommit;
    bool gameInstalled = false, engineOk = false, gameOk = false, checked = false;
    std::vector<NewsItem> news;
    std::wstring status = L"Kontrollin uuendusi…";
    int progress = -1;   // permille; -1 = working, length unknown (animated)
    Phase phase = Phase::Checking;
};

constexpr UINT WM_APP_REFRESH = WM_APP + 1, WM_APP_IMAGE = WM_APP + 2, WM_APP_RESTART = WM_APP + 3, WM_APP_READY = WM_APP + 4;
constexpr UINT_PTR kAnimationTimer = 1, kGameWindowTimer = 2;
constexpr float kWidth = 1100, kHeight = 680;   // client size in DIPs

std::mutex gMutex;
State gState;
HWND gWindow = nullptr;
std::wstring gRoot, gGameFolder = L"game2";
bool gAutostart = false;
std::atomic<bool> gWorkerRunning{false};
HANDLE gGameProcess = nullptr;
DWORD gGamePid = 0;
ULONGLONG gGameStart = 0;
bool gHover = false;
HANDLE gSingle = nullptr;   // one launcher at a time

// ------------------------------------------------------------ text helpers
std::wstring widen(const std::string& s) {
    if (s.empty()) return {};
    const int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), int(s.size()), nullptr, 0);
    std::wstring w(std::size_t(std::max(0, n)), L'\0');
    if (n > 0) MultiByteToWideChar(CP_UTF8, 0, s.data(), int(s.size()), w.data(), n);
    return w;
}

std::vector<std::wstring> splitTabs(const std::wstring& line) {
    std::vector<std::wstring> out;
    std::size_t start = 0;
    for (;;) {
        const std::size_t tab = line.find(L'\t', start);
        out.push_back(line.substr(start, tab == std::wstring::npos ? std::wstring::npos : tab - start));
        if (tab == std::wstring::npos) break;
        start = tab + 1;
    }
    return out;
}

// "v0.35.0" -> {0, 35, 0}; false when it is not a version.
bool parseVersion(const std::wstring& text, int out[3]) {
    const wchar_t* p = text.c_str();
    if (*p == L'v' || *p == L'V') p++;
    for (int i = 0; i < 3; i++) {
        if (!iswdigit(*p)) return false;
        out[i] = 0;
        while (iswdigit(*p)) out[i] = out[i] * 10 + (*p++ - L'0');
        if (i < 2) { if (*p != L'.') return false; p++; }
    }
    return *p == 0;
}
bool newer(const std::wstring& candidate, const std::wstring& installed) {
    int a[3], b[3];
    if (!parseVersion(candidate, a)) return false;
    if (!parseVersion(installed, b)) return true;
    for (int i = 0; i < 3; i++) if (a[i] != b[i]) return a[i] > b[i];
    return false;
}

void post(UINT message) { if (gWindow) PostMessageW(gWindow, message, 0, 0); }

// ------------------------------------------------------------ update helper
// Runs NativeThree-Updater.exe <args> --machine and passes every output line on.
int runHelper(const std::wstring& args, const std::function<void(const std::wstring&)>& onLine) {
    SECURITY_ATTRIBUTES sa{sizeof sa, nullptr, TRUE};
    HANDLE readPipe = nullptr, writePipe = nullptr;
    if (!CreatePipe(&readPipe, &writePipe, &sa, 0)) { onLine(L"ERROR\tToru loomine ebaõnnestus."); return -1; }
    SetHandleInformation(readPipe, HANDLE_FLAG_INHERIT, 0);
    STARTUPINFOW si{};
    si.cb = sizeof si;
    si.dwFlags = STARTF_USESTDHANDLES;
    si.hStdOutput = writePipe;
    si.hStdError = writePipe;
    const std::wstring exe = gRoot + L"\\NativeThree-Updater.exe";
    std::wstring command = L"\"" + exe + L"\" " + args + L" --machine";
    PROCESS_INFORMATION pi{};
    if (!CreateProcessW(exe.c_str(), command.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW, nullptr, gRoot.c_str(), &si, &pi)) {
        CloseHandle(readPipe);
        CloseHandle(writePipe);
        onLine(L"ERROR\tNativeThree-Updater.exe puudub või ei käivitu. Paki mängu ZIP uuesti lahti.");
        return -1;
    }
    CloseHandle(writePipe);
    std::string buffer;
    char chunk[4096];
    DWORD read = 0;
    while (ReadFile(readPipe, chunk, sizeof chunk, &read, nullptr) && read) {
        buffer.append(chunk, read);
        for (std::size_t end; (end = buffer.find('\n')) != std::string::npos;) {
            std::string line = buffer.substr(0, end);
            buffer.erase(0, end + 1);
            if (!line.empty() && line.back() == '\r') line.pop_back();
            if (!line.empty()) onLine(widen(line));
        }
    }
    if (!buffer.empty()) onLine(widen(buffer));
    WaitForSingleObject(pi.hProcess, INFINITE);
    DWORD code = 1;
    GetExitCodeProcess(pi.hProcess, &code);
    CloseHandle(pi.hProcess);
    CloseHandle(pi.hThread);
    CloseHandle(readPipe);
    return int(code);
}

// INFO <key> <value> and NEWS <date> <source> <text> lines (under gMutex).
void applyInfo(const std::vector<std::wstring>& f) {
    if (f[0] == L"NEWS" && f.size() >= 4) { gState.news.push_back({f[1], f[2], f[3]}); return; }
    if (f[0] != L"INFO" || f.size() < 3) return;
    const std::wstring& key = f[1];
    const std::wstring& value = f[2];
    if (key == L"NAME") gState.name = value;
    else if (key == L"IMAGE") gState.image = value;
    else if (key == L"ENGINE") gState.engine = value;
    else if (key == L"GAME_INSTALLED") gState.gameInstalled = value == L"1";
    else if (key == L"GAME_VERSION") gState.gameVersion = value;
    else if (key == L"GAME_COMMIT") gState.gameCommit = value;
    else if (key == L"ENGINE_LATEST") gState.engineLatest = value;
    else if (key == L"GAME_LATEST_COMMIT") gState.gameLatestCommit = value;
    else if (key == L"GAME_LATEST_VERSION") gState.gameLatestVersion = value;
}

void setStatus(Phase phase, const std::wstring& text, int progress) {
    {
        std::lock_guard<std::mutex> lock(gMutex);
        gState.phase = phase;
        gState.status = text;
        gState.progress = progress;
    }
    post(WM_APP_REFRESH);
}

// One helper run that reports progress; returns the error text ("" = ok).
std::wstring runStep(const std::wstring& command, bool* restart) {
    std::wstring error;
    const int code = runHelper(command, [&](const std::wstring& line) {
        if (line.rfind(L"PROGRESS ", 0) == 0) {
            const std::vector<std::wstring> f = splitTabs(line);
            const int permille = _wtoi(f[0].c_str() + 9);
            std::lock_guard<std::mutex> lock(gMutex);
            gState.progress = std::clamp(permille, -1, 1000);
            if (f.size() > 1) gState.status = f[1];
            post(WM_APP_REFRESH);
            return;
        }
        const std::vector<std::wstring> f = splitTabs(line);
        if (f[0] == L"STEP" && f.size() > 1) {
            std::lock_guard<std::mutex> lock(gMutex);
            gState.status = f[1];
            post(WM_APP_REFRESH);
        } else if (f[0] == L"ERROR" && f.size() > 1) error = f[1];
        else if (f[0] == L"RESTART" && restart) *restart = true;
        else {
            std::lock_guard<std::mutex> lock(gMutex);
            applyInfo(f);
        }
    });
    if (code != 0 && error.empty()) error = L"tundmatu viga (kood " + std::to_wstring(code) + L")";
    return error;
}

void readLocal() {
    {
        std::lock_guard<std::mutex> lock(gMutex);
        gState.image.clear();
    }
    runStep(L"local", nullptr);
    post(WM_APP_IMAGE);
    post(WM_APP_REFRESH);
}

// Check, update the engine, update the game, then allow starting.
void worker() {
    runHelper(L"cleanup", [](const std::wstring&) {});
    readLocal();
    setStatus(Phase::Checking, L"Kontrollin uuendusi…", -1);
    {
        std::lock_guard<std::mutex> lock(gMutex);
        gState.news.clear();
    }
    const std::wstring checkError = runStep(L"status", nullptr);
    if (!checkError.empty()) {
        bool installed;
        { std::lock_guard<std::mutex> lock(gMutex); installed = gState.gameInstalled; }
        if (installed) setStatus(Phase::Offline, L"Uuendusi ei saanud kontrollida (" + checkError + L"). Saad mängida olemasoleva versiooniga.", 0);
        else setStatus(Phase::Failed, L"Uuendusi ei saanud kontrollida: " + checkError, 0);
        gWorkerRunning = false;
        if (installed) post(WM_APP_READY);
        return;
    }
    bool engineOk, gameOk;
    std::wstring engineFrom, engineTo, gameFrom, gameTo;
    bool gameInstalled;
    {
        std::lock_guard<std::mutex> lock(gMutex);
        gState.checked = true;
        gState.engineOk = !newer(gState.engineLatest, gState.engine);
        gState.gameOk = gState.gameInstalled && !gState.gameLatestCommit.empty() && gState.gameCommit == gState.gameLatestCommit;
        engineOk = gState.engineOk; gameOk = gState.gameOk; gameInstalled = gState.gameInstalled;
        engineFrom = gState.engine; engineTo = gState.engineLatest;
        gameFrom = gState.gameVersion; gameTo = gState.gameLatestVersion;
    }
    post(WM_APP_REFRESH);
    if (!engineOk) {
        setStatus(Phase::UpdatingEngine, L"Uuendan engine'i: " + engineFrom + L" → " + engineTo, -1);
        bool restart = false;
        const std::wstring error = runStep(L"update-engine", &restart);
        if (!error.empty()) {
            setStatus(Phase::Failed, L"Engine'i uuendamine ebaõnnestus: " + error, 0);
            gWorkerRunning = false;
            return;
        }
        if (restart) { setStatus(Phase::UpdatingEngine, L"Uus käivitaja on paigaldatud, käivitan uuesti…", 1000); post(WM_APP_RESTART); return; }
        std::lock_guard<std::mutex> lock(gMutex);
        gState.engine = gState.engineLatest;
        gState.engineOk = true;
    }
    if (!gameOk) {
        setStatus(Phase::UpdatingGame, gameInstalled ? L"Uuendan mängu: " + gameFrom + L" → " + gameTo : L"Laen mängu alla…", -1);
        const std::wstring error = runStep(L"update-game", nullptr);
        if (!error.empty()) {
            setStatus(Phase::Failed, L"Mängu uuendamine ebaõnnestus: " + error, 0);
            gWorkerRunning = false;
            return;
        }
        readLocal();
        std::lock_guard<std::mutex> lock(gMutex);
        gState.gameOk = true;
        gState.gameInstalled = true;
    }
    setStatus(Phase::Ready, L"Kõik on uuendatud. Head mängu!", 1000);
    gWorkerRunning = false;
    post(WM_APP_READY);
}

void startWorker() {
    if (gWorkerRunning.exchange(true)) return;
    std::thread(worker).detach();
}

// ------------------------------------------------------------ the game
BOOL CALLBACK findGameWindow(HWND hwnd, LPARAM found) {
    DWORD pid = 0;
    GetWindowThreadProcessId(hwnd, &pid);
    if (pid == gGamePid && IsWindowVisible(hwnd) && !GetWindow(hwnd, GW_OWNER) && GetWindowTextLengthW(hwnd) > 0) {
        *reinterpret_cast<bool*>(found) = true;
        return FALSE;
    }
    return TRUE;
}

void startGame() {
    const std::wstring engine = gRoot + L"\\NativeThree-Engine.exe";
    std::wstring command = L"\"" + engine + L"\" --webapp \"" + gRoot + L"\\" + gGameFolder + L"\"";
    STARTUPINFOW si{};
    si.cb = sizeof si;
    PROCESS_INFORMATION pi{};
    if (!CreateProcessW(engine.c_str(), command.data(), nullptr, nullptr, FALSE, 0, nullptr, gRoot.c_str(), &si, &pi)) {
        setStatus(Phase::Failed, L"NativeThree-Engine.exe ei käivitunud. Paki mängu ZIP uuesti lahti.", 0);
        return;
    }
    CloseHandle(pi.hThread);
    gGameProcess = pi.hProcess;
    gGamePid = pi.dwProcessId;
    gGameStart = GetTickCount64();
    setStatus(Phase::Starting, L"Laen mängu…", -1);
    SetTimer(gWindow, kGameWindowTimer, 250, nullptr);
}

void checkGameWindow() {
    bool found = false;
    EnumWindows(findGameWindow, reinterpret_cast<LPARAM>(&found));
    if (found) {
        KillTimer(gWindow, kGameWindowTimer);
        CloseHandle(gGameProcess);
        gGameProcess = nullptr;
        DestroyWindow(gWindow); // the game is on screen: the launcher is done
        return;
    }
    if (WaitForSingleObject(gGameProcess, 0) == WAIT_OBJECT_0) {
        KillTimer(gWindow, kGameWindowTimer);
        CloseHandle(gGameProcess);
        gGameProcess = nullptr;
        setStatus(Phase::Failed, L"Mäng sulgus enne akna avanemist. Vaata faili NativeThreeBridge-webapp-log.txt.", 0);
        return;
    }
    const ULONGLONG seconds = (GetTickCount64() - gGameStart) / 1000;
    std::lock_guard<std::mutex> lock(gMutex);
    gState.status = L"Laen mängu… " + std::to_wstring(seconds) + L" s";
}

// ------------------------------------------------------------ drawing
struct Graphics {
    ComPtr<ID2D1Factory> d2d;
    ComPtr<IDWriteFactory> dwrite;
    ComPtr<IWICImagingFactory> wic;
    ComPtr<ID2D1HwndRenderTarget> rt;
    ComPtr<ID2D1SolidColorBrush> brush;
    ComPtr<ID2D1Bitmap> picture;
    ComPtr<IWICFormatConverter> pictureSource;
    std::wstring pictureFile;
    ComPtr<IDWriteTextFormat> title, header, small, body, status, version, button, retry;
    float dpi = 96;
} g;

ComPtr<IDWriteTextFormat> font(float size, DWRITE_FONT_WEIGHT weight, DWRITE_TEXT_ALIGNMENT align = DWRITE_TEXT_ALIGNMENT_LEADING) {
    ComPtr<IDWriteTextFormat> f;
    g.dwrite->CreateTextFormat(L"Segoe UI", nullptr, weight, DWRITE_FONT_STYLE_NORMAL, DWRITE_FONT_STRETCH_NORMAL, size, L"et-ee", &f);
    if (f) {
        f->SetTextAlignment(align);
        f->SetParagraphAlignment(DWRITE_PARAGRAPH_ALIGNMENT_NEAR);
    }
    return f;
}
void ellipsis(IDWriteTextFormat* f) {
    ComPtr<IDWriteInlineObject> sign;
    g.dwrite->CreateEllipsisTrimmingSign(f, &sign);
    DWRITE_TRIMMING trimming{DWRITE_TRIMMING_GRANULARITY_CHARACTER, 0, 0};
    f->SetTrimming(&trimming, sign.Get());
    f->SetWordWrapping(DWRITE_WORD_WRAPPING_NO_WRAP);
}

void initGraphics() {
    D2D1CreateFactory(D2D1_FACTORY_TYPE_SINGLE_THREADED, g.d2d.GetAddressOf());
    DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED, __uuidof(IDWriteFactory), reinterpret_cast<IUnknown**>(g.dwrite.GetAddressOf()));
    CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&g.wic));
    g.title = font(46, DWRITE_FONT_WEIGHT_SEMI_BOLD, DWRITE_TEXT_ALIGNMENT_CENTER);
    g.header = font(16, DWRITE_FONT_WEIGHT_SEMI_BOLD);
    g.small = font(11.5f, DWRITE_FONT_WEIGHT_SEMI_BOLD);
    g.body = font(13.5f, DWRITE_FONT_WEIGHT_NORMAL);
    g.status = font(14, DWRITE_FONT_WEIGHT_NORMAL);
    g.version = font(13, DWRITE_FONT_WEIGHT_SEMI_BOLD);
    g.button = font(22, DWRITE_FONT_WEIGHT_BOLD, DWRITE_TEXT_ALIGNMENT_CENTER);
    g.retry = font(15, DWRITE_FONT_WEIGHT_BOLD, DWRITE_TEXT_ALIGNMENT_CENTER);
    g.retry->SetParagraphAlignment(DWRITE_PARAGRAPH_ALIGNMENT_CENTER);
    ellipsis(g.status.Get());
    ellipsis(g.version.Get());
    ellipsis(g.title.Get());
    g.button->SetParagraphAlignment(DWRITE_PARAGRAPH_ALIGNMENT_CENTER);
}

void loadPicture(const std::wstring& file) {
    g.picture.Reset();
    g.pictureSource.Reset();
    g.pictureFile = file;
    if (file.empty() || !g.wic) return;
    ComPtr<IWICBitmapDecoder> decoder;
    ComPtr<IWICBitmapFrameDecode> frame;
    // WebP needs the Windows WebP codec (installed with Windows 10/11).
    if (FAILED(g.wic->CreateDecoderFromFilename(file.c_str(), nullptr, GENERIC_READ, WICDecodeMetadataCacheOnLoad, &decoder)) ||
        FAILED(decoder->GetFrame(0, &frame)) || FAILED(g.wic->CreateFormatConverter(&g.pictureSource)) ||
        FAILED(g.pictureSource->Initialize(frame.Get(), GUID_WICPixelFormat32bppPBGRA, WICBitmapDitherTypeNone, nullptr, 0, WICBitmapPaletteTypeMedianCut)))
        g.pictureSource.Reset();
}

void createTarget() {
    if (g.rt) return;
    RECT rc;
    GetClientRect(gWindow, &rc);
    D2D1_RENDER_TARGET_PROPERTIES props = D2D1::RenderTargetProperties();
    props.dpiX = props.dpiY = g.dpi;
    g.d2d->CreateHwndRenderTarget(props, D2D1::HwndRenderTargetProperties(gWindow, D2D1::SizeU(rc.right, rc.bottom)), &g.rt);
    if (g.rt) g.rt->CreateSolidColorBrush(D2D1::ColorF(1, 1, 1), &g.brush);
}

ID2D1SolidColorBrush* color(UINT32 rgb, float alpha = 1) {
    g.brush->SetColor(D2D1::ColorF(rgb, alpha));
    return g.brush.Get();
}

void text(const std::wstring& s, IDWriteTextFormat* f, D2D1_RECT_F r, UINT32 rgb, float alpha = 1) {
    g.rt->DrawTextW(s.c_str(), UINT32(s.size()), f, r, color(rgb, alpha), D2D1_DRAW_TEXT_OPTIONS_CLIP);
}

const D2D1_RECT_F kPanel{20, 20, 1080, 556};
const D2D1_RECT_F kNews{742, 92, 1062, 540};
const D2D1_RECT_F kEngineBox{20, 570, 214, 604};
const D2D1_RECT_F kGameBox{20, 612, 214, 646};
const D2D1_RECT_F kStatus{228, 572, 926, 598};
const D2D1_RECT_F kBar{228, 610, 926, 634};
const D2D1_RECT_F kButton{940, 570, 1080, 646};

bool startAllowed(const State& s) { return s.phase == Phase::Ready || s.phase == Phase::Offline || s.phase == Phase::Failed; }

void versionBox(D2D1_RECT_F r, const std::wstring& label, const std::wstring& installed, const std::wstring& latest, bool checked, bool ok) {
    g.rt->FillRoundedRectangle(D2D1::RoundedRect(r, 6, 6), color(0x1b2129));
    g.rt->DrawRoundedRectangle(D2D1::RoundedRect(r, 6, 6), color(0x323b47), 1);
    std::wstring value = installed.empty() ? L"puudub" : installed;
    if (checked && !ok && !latest.empty() && latest != installed) value += L" → " + latest;
    text(label + L"  " + value, g.version.Get(), D2D1::RectF(r.left + 10, r.top + 8, r.right - 30, r.bottom), 0xe8e6df);
    // red until current, green when current, grey before the check
    const UINT32 ring = !checked ? 0x8a9099 : ok ? 0x3ccf6e : 0xe0504a;
    const D2D1_ELLIPSE e = D2D1::Ellipse(D2D1::Point2F(r.right - 16, (r.top + r.bottom) / 2), 7, 7);
    g.rt->FillEllipse(e, color(ring, 0.25f));
    g.rt->DrawEllipse(e, color(ring), 2.5f);
}

void drawNews(const State& s) {
    g.rt->FillRoundedRectangle(D2D1::RoundedRect(kNews, 8, 8), color(0x0b0f14, 0.68f));
    text(L"Viimased uuendused", g.header.Get(), D2D1::RectF(kNews.left + 14, kNews.top + 10, kNews.right - 14, kNews.top + 34), 0xf2e6c4);
    float y = kNews.top + 42;
    const float width = kNews.right - kNews.left - 28;
    if (s.news.empty()) {
        const wchar_t* note = s.phase == Phase::Checking ? L"Laen uudiseid…" : L"Uudiseid ei saanud laadida.";
        text(note, g.body.Get(), D2D1::RectF(kNews.left + 14, y, kNews.right - 14, y + 40), 0xa8b0ba);
        return;
    }
    for (const NewsItem& item : s.news) {
        ComPtr<IDWriteTextLayout> layout;
        g.dwrite->CreateTextLayout(item.text.c_str(), UINT32(item.text.size()), g.body.Get(), width, 400, &layout);
        if (!layout) break;
        DWRITE_TEXT_METRICS m{};
        layout->GetMetrics(&m);
        const float height = 17 + m.height;
        if (y + height > kNews.bottom - 10) break; // as many as fit
        text(item.date, g.small.Get(), D2D1::RectF(kNews.left + 14, y, kNews.left + 100, y + 16), 0x8c96a3);
        const bool engine = item.source == L"Engine";
        text(item.source, g.small.Get(), D2D1::RectF(kNews.left + 96, y, kNews.right - 14, y + 16), engine ? 0x6fb3ff : 0xe8b95a);
        g.rt->DrawTextLayout(D2D1::Point2F(kNews.left + 14, y + 16), layout.Get(), color(0xe9e6de), D2D1_DRAW_TEXT_OPTIONS_CLIP);
        y += height + 6;
        g.rt->DrawLine(D2D1::Point2F(kNews.left + 14, y - 3), D2D1::Point2F(kNews.right - 14, y - 3), color(0xffffff, 0.08f), 1);
    }
}

void paint() {
    createTarget();
    if (!g.rt) return;
    State s;
    {
        std::lock_guard<std::mutex> lock(gMutex);
        s = gState;
    }
    if (!g.picture && g.pictureSource) g.rt->CreateBitmapFromWicBitmap(g.pictureSource.Get(), nullptr, &g.picture);
    g.rt->BeginDraw();
    g.rt->SetTransform(D2D1::IdentityMatrix());
    g.rt->Clear(D2D1::ColorF(0x10141a));

    // picture (cover) or a plain gradient
    g.rt->PushAxisAlignedClip(kPanel, D2D1_ANTIALIAS_MODE_ALIASED);
    const float pw = kPanel.right - kPanel.left, ph = kPanel.bottom - kPanel.top;
    if (g.picture) {
        const D2D1_SIZE_F size = g.picture->GetSize();
        const float scale = std::max(pw / size.width, ph / size.height);
        const float w = size.width * scale, h = size.height * scale;
        const float x = kPanel.left + (pw - w) / 2, y = kPanel.top + (ph - h) / 2;
        g.rt->DrawBitmap(g.picture.Get(), D2D1::RectF(x, y, x + w, y + h), 1, D2D1_BITMAP_INTERPOLATION_MODE_LINEAR);
    }
    ComPtr<ID2D1GradientStopCollection> stops;
    const D2D1_GRADIENT_STOP shade[3] = {{0, D2D1::ColorF(0, g.picture ? 0.55f : 0)}, {0.35f, D2D1::ColorF(0, 0)}, {1, D2D1::ColorF(0, g.picture ? 0.35f : 0)}};
    const D2D1_GRADIENT_STOP plain[2] = {{0, D2D1::ColorF(0x2a3d52)}, {1, D2D1::ColorF(0x0f151c)}};
    g.rt->CreateGradientStopCollection(g.picture ? shade : plain, g.picture ? 3 : 2, &stops);
    ComPtr<ID2D1LinearGradientBrush> gradient;
    if (stops) g.rt->CreateLinearGradientBrush(D2D1::LinearGradientBrushProperties(D2D1::Point2F(0, kPanel.top), D2D1::Point2F(0, kPanel.bottom)), stops.Get(), &gradient);
    if (gradient) g.rt->FillRectangle(kPanel, gradient.Get());
    // game name
    const std::wstring name = s.name.empty() ? L"Mäng" : s.name;
    text(name, g.title.Get(), D2D1::RectF(kPanel.left + 22, kPanel.top + 22, kPanel.right - 18, kPanel.top + 90), 0x000000, 0.7f);
    text(name, g.title.Get(), D2D1::RectF(kPanel.left + 20, kPanel.top + 20, kPanel.right - 20, kPanel.top + 88), 0xfff6dc);
    drawNews(s);
    g.rt->PopAxisAlignedClip();
    g.rt->DrawRoundedRectangle(D2D1::RoundedRect(kPanel, 4, 4), color(0x3a4452), 2);

    // versions
    versionBox(kEngineBox, L"Engine", s.engine, s.engineLatest, s.checked, s.engineOk);
    versionBox(kGameBox, L"Mäng", s.gameInstalled ? (s.gameVersion.empty() ? L"paigaldatud" : s.gameVersion) : L"",
               s.gameLatestVersion, s.checked, s.gameOk);

    // status and progress
    const bool failed = s.phase == Phase::Failed;
    text(s.status, g.status.Get(), kStatus, failed ? 0xff8a80 : s.phase == Phase::Offline ? 0xf2c46b : 0xe8e6df);
    g.rt->FillRoundedRectangle(D2D1::RoundedRect(kBar, 6, 6), color(0x1f262f));
    if (s.progress >= 0) {
        const float w = (kBar.right - kBar.left) * float(s.progress) / 1000.0f;
        if (w > 1) g.rt->FillRoundedRectangle(D2D1::RoundedRect(D2D1::RectF(kBar.left, kBar.top, kBar.left + w, kBar.bottom), 6, 6),
                                              color(failed ? 0xb34a42 : 0x38b26a));
    } else { // working: a moving block
        const float span = kBar.right - kBar.left, block = span * 0.22f;
        const float t = float(GetTickCount64() % 1600) / 1600.0f;
        const float x = kBar.left - block + (span + block) * t;
        g.rt->PushAxisAlignedClip(kBar, D2D1_ANTIALIAS_MODE_ALIASED);
        g.rt->FillRoundedRectangle(D2D1::RoundedRect(D2D1::RectF(x, kBar.top, x + block, kBar.bottom), 6, 6), color(0x4c8fd6));
        g.rt->PopAxisAlignedClip();
    }
    g.rt->DrawRoundedRectangle(D2D1::RoundedRect(kBar, 6, 6), color(0x323b47), 1);

    // start button
    const bool enabled = startAllowed(s) && (s.phase != Phase::Failed || !gWorkerRunning);
    const UINT32 fill = !enabled ? 0x363d46 : failed ? (gHover ? 0xc0603a : 0xa85232) : (gHover ? 0x3cc271 : 0x2f9e57);
    g.rt->FillRoundedRectangle(D2D1::RoundedRect(kButton, 8, 8), color(fill));
    g.rt->DrawRoundedRectangle(D2D1::RoundedRect(kButton, 8, 8), color(0xffffff, enabled ? 0.25f : 0.08f), 1.5f);
    const wchar_t* label = s.phase == Phase::Starting ? L"…" : failed ? L"PROOVI\nUUESTI" : L"MÄNGI";
    text(label, failed ? g.retry.Get() : g.button.Get(), kButton, enabled ? 0xffffff : 0x8a9099);

    if (g.rt->EndDraw() == D2DERR_RECREATE_TARGET) { g.rt.Reset(); g.picture.Reset(); g.brush.Reset(); }
}

bool overButton(LPARAM lp) {
    const float k = 96.0f / g.dpi;
    const float x = float(GET_X_LPARAM(lp)) * k, y = float(GET_Y_LPARAM(lp)) * k;
    return x >= kButton.left && x <= kButton.right && y >= kButton.top && y <= kButton.bottom;
}

void press() {
    State s;
    {
        std::lock_guard<std::mutex> lock(gMutex);
        s = gState;
    }
    if (!startAllowed(s)) return;
    if (s.phase == Phase::Failed) { if (!gWorkerRunning) startWorker(); return; }
    startGame();
}

void restartLauncher() {
    const std::wstring exe = gRoot + L"\\Launcher.exe";
    std::wstring command = L"\"" + exe + L"\"" + (gAutostart ? L" --autostart" : L"");
    STARTUPINFOW si{};
    si.cb = sizeof si;
    PROCESS_INFORMATION pi{};
    if (gSingle) { CloseHandle(gSingle); gSingle = nullptr; } // the new launcher takes over
    if (CreateProcessW(exe.c_str(), command.data(), nullptr, nullptr, FALSE, 0, nullptr, gRoot.c_str(), &si, &pi)) {
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
        DestroyWindow(gWindow);
    } else setStatus(Phase::Failed, L"Uuendatud käivitaja ei käivitunud. Ava Launcher.exe uuesti.", 0);
}

LRESULT CALLBACK windowProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    switch (msg) {
    case WM_PAINT: {
        PAINTSTRUCT ps;
        BeginPaint(hwnd, &ps);
        paint();
        EndPaint(hwnd, &ps);
        return 0;
    }
    case WM_ERASEBKGND: return 1;
    case WM_SIZE:
        if (g.rt) g.rt->Resize(D2D1::SizeU(LOWORD(lp), HIWORD(lp)));
        return 0;
    case WM_DPICHANGED: {
        g.dpi = float(HIWORD(wp));
        g.rt.Reset();
        g.picture.Reset();
        const RECT* r = reinterpret_cast<const RECT*>(lp);
        SetWindowPos(hwnd, nullptr, r->left, r->top, r->right - r->left, r->bottom - r->top, SWP_NOZORDER | SWP_NOACTIVATE);
        InvalidateRect(hwnd, nullptr, FALSE);
        return 0;
    }
    case WM_MOUSEMOVE: {
        const bool hover = overButton(lp);
        if (hover != gHover) { gHover = hover; InvalidateRect(hwnd, nullptr, FALSE); }
        TRACKMOUSEEVENT t{sizeof t, TME_LEAVE, hwnd, 0};
        TrackMouseEvent(&t);
        return 0;
    }
    case WM_MOUSELEAVE:
        if (gHover) { gHover = false; InvalidateRect(hwnd, nullptr, FALSE); }
        return 0;
    case WM_SETCURSOR:
        if (LOWORD(lp) == HTCLIENT && gHover) { SetCursor(LoadCursor(nullptr, IDC_HAND)); return TRUE; }
        break;
    case WM_LBUTTONUP:
        if (overButton(lp)) press();
        return 0;
    case WM_KEYDOWN:
        if (wp == VK_RETURN) press();
        else if (wp == VK_ESCAPE) {
            std::lock_guard<std::mutex> lock(gMutex);
            if (gState.phase != Phase::UpdatingEngine && gState.phase != Phase::UpdatingGame) PostMessageW(hwnd, WM_CLOSE, 0, 0);
        }
        return 0;
    case WM_TIMER: {
        if (wp == kGameWindowTimer && gGameProcess) checkGameWindow();
        bool animate;
        { std::lock_guard<std::mutex> lock(gMutex); animate = gState.progress < 0 || gState.phase == Phase::Starting; }
        if (animate && IsWindow(hwnd)) InvalidateRect(hwnd, nullptr, FALSE);
        return 0;
    }
    case WM_APP_IMAGE: {
        std::wstring file;
        { std::lock_guard<std::mutex> lock(gMutex); file = gState.image; }
        if (file != g.pictureFile || !g.pictureSource) loadPicture(file);
        std::wstring caption;
        { std::lock_guard<std::mutex> lock(gMutex); caption = (gState.name.empty() ? L"Mäng" : gState.name) + L" – käivitaja"; }
        SetWindowTextW(hwnd, caption.c_str());
        InvalidateRect(hwnd, nullptr, FALSE);
        return 0;
    }
    case WM_APP_REFRESH:
        InvalidateRect(hwnd, nullptr, FALSE);
        return 0;
    case WM_APP_READY:
        if (gAutostart) {
            std::lock_guard<std::mutex> lock(gMutex);
            if (gState.phase == Phase::Ready) PostMessageW(hwnd, WM_KEYDOWN, VK_RETURN, 0);
        }
        return 0;
    case WM_APP_RESTART:
        restartLauncher();
        return 0;
    case WM_CLOSE: {
        bool busy;
        { std::lock_guard<std::mutex> lock(gMutex); busy = gState.phase == Phase::UpdatingEngine || gState.phase == Phase::UpdatingGame; }
        if (busy && MessageBoxW(hwnd, L"Uuendamine on pooleli. Kui sulged nüüd, jääb eelmine versioon alles ja uuendus tehakse järgmisel korral.\n\nSulgen?",
                                L"Käivitaja", MB_YESNO | MB_ICONQUESTION) != IDYES)
            return 0;
        DestroyWindow(hwnd);
        return 0;
    }
    case WM_DESTROY:
        PostQuitMessage(0);
        return 0;
    }
    return DefWindowProcW(hwnd, msg, wp, lp);
}

int selfTest() {
    int failures = 0;
    auto expect = [&](bool ok, const char* what) { if (!ok) { std::fprintf(stderr, "FAIL: %s\n", what); failures++; } };
    expect(newer(L"v0.36.0", L"v0.35.0"), "newer minor");
    expect(!newer(L"v0.35.0", L"v0.35.0"), "same version");
    expect(!newer(L"v0.34.9", L"v0.35.0"), "older");
    expect(newer(L"v1.0.0", L"v0.99.99"), "major");
    expect(newer(L"v0.35.0", L"v0.0.0"), "fresh install");
    expect(!newer(L"", L"v0.35.0"), "unknown latest is not newer");
    const std::vector<std::wstring> f = splitTabs(L"NEWS\t21.11.2026\tMäng\tUus kindlus");
    expect(f.size() == 4 && f[3] == L"Uus kindlus", "tab split");
    expect(widen("M\xC3\xA4ng") == L"Mäng", "utf-8");
    return failures ? 1 : 0;
}

} // namespace

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE, LPWSTR, int show) {
    int argc = 0;
    LPWSTR* argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    for (int i = 1; i < argc; i++) {
        if (std::wcscmp(argv[i], L"--self-test") == 0) return selfTest();
        if (std::wcscmp(argv[i], L"--autostart") == 0) gAutostart = true;
    }
    LocalFree(argv);

    wchar_t path[MAX_PATH];
    const DWORD length = GetModuleFileNameW(nullptr, path, MAX_PATH);
    if (!length || length >= MAX_PATH) return 40;
    gRoot = path;
    gRoot.erase(gRoot.find_last_of(L'\\'));
    // launcher.json may name another game folder ({"gameFolder": "game2", ...}).
    if (FILE* f = _wfopen((gRoot + L"\\launcher.json").c_str(), L"rb")) {
        std::string json(4096, '\0');
        json.resize(std::fread(json.data(), 1, json.size(), f));
        std::fclose(f);
        const std::size_t key = json.find("\"gameFolder\"");
        const std::size_t open = key == std::string::npos ? key : json.find('"', json.find(':', key) + 1);
        const std::size_t close = open == std::string::npos ? open : json.find('"', open + 1);
        if (close != std::string::npos) {
            const std::wstring folder = widen(json.substr(open + 1, close - open - 1));
            if (!folder.empty() && folder.find_first_of(L"\\/:.") == std::wstring::npos) gGameFolder = folder;
        }
    }

    // Only one launcher at a time (updates must not run twice).
    gSingle = CreateMutexW(nullptr, TRUE, L"NativeThreeBridge-Launcher");
    if (GetLastError() == ERROR_ALREADY_EXISTS) {
        // Just restarted after an update: the old launcher is closing.
        const DWORD wait = WaitForSingleObject(gSingle, 5000);
        if (wait == WAIT_OBJECT_0 || wait == WAIT_ABANDONED) goto owned;
        if (HWND other = FindWindowW(L"NativeThreeLauncher", nullptr)) { ShowWindow(other, SW_RESTORE); SetForegroundWindow(other); }
        return 0;
    }
owned:

    using SetContext = BOOL(WINAPI*)(DPI_AWARENESS_CONTEXT);
    if (auto set = reinterpret_cast<SetContext>(GetProcAddress(GetModuleHandleW(L"user32.dll"), "SetProcessDpiAwarenessContext")))
        set(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    initGraphics();

    WNDCLASSW wc{};
    wc.lpfnWndProc = windowProc;
    wc.hInstance = instance;
    wc.hCursor = LoadCursor(nullptr, IDC_ARROW);
    wc.hIcon = LoadIcon(nullptr, IDI_APPLICATION);
    wc.lpszClassName = L"NativeThreeLauncher";
    RegisterClassW(&wc);
    const DWORD style = WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX;
    const UINT dpi = GetDpiForSystem();
    g.dpi = float(dpi);
    RECT r{0, 0, LONG(std::lround(kWidth * dpi / 96.0f)), LONG(std::lround(kHeight * dpi / 96.0f))};
    AdjustWindowRectExForDpi(&r, style, FALSE, 0, dpi);
    gWindow = CreateWindowExW(0, wc.lpszClassName, L"Käivitaja", style, CW_USEDEFAULT, CW_USEDEFAULT,
                              r.right - r.left, r.bottom - r.top, nullptr, nullptr, instance, nullptr);
    if (!gWindow) return 41;
    const UINT windowDpi = GetDpiForWindow(gWindow);
    if (windowDpi != dpi) { // another monitor: size for its DPI
        g.dpi = float(windowDpi);
        RECT w{0, 0, LONG(std::lround(kWidth * windowDpi / 96.0f)), LONG(std::lround(kHeight * windowDpi / 96.0f))};
        AdjustWindowRectExForDpi(&w, style, FALSE, 0, windowDpi);
        SetWindowPos(gWindow, nullptr, 0, 0, w.right - w.left, w.bottom - w.top, SWP_NOMOVE | SWP_NOZORDER);
    }
    ShowWindow(gWindow, show);
    UpdateWindow(gWindow);
    SetTimer(gWindow, kAnimationTimer, 33, nullptr);
    startWorker();

    MSG message;
    while (GetMessageW(&message, nullptr, 0, 0) > 0) {
        TranslateMessage(&message);
        DispatchMessageW(&message);
    }
    if (gSingle) CloseHandle(gSingle);
    // An update may still be finishing: wait briefly so files are not left half written.
    for (int i = 0; i < 100 && gWorkerRunning; i++) Sleep(100);
    return 0;
}
