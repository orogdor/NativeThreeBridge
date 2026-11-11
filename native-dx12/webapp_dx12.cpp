// Generic DX12 renderer + Win32 window for ordinary Three.js webapps.
// The JS side (js/native-renderer.mjs) sends geometry, instance buffers and
// one packet per render() call; this file turns them into DX12 draws.
#include "webapp_dx12.h"

#include <windowsx.h>
#include <shellapi.h>
#include <d3d12.h>
#include <d3d12sdklayers.h>
#include <dxgi1_6.h>
#include <d3dcompiler.h>
#include <wrl/client.h>
#include <wincodec.h>

#include <algorithm>
#include <chrono>
#include <climits>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <cstdlib>
#include <share.h>
#include <fstream>
#include <map>
#include <regex>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

#include "webapp_host.h"
#include "webapp_dx12_guard.h"
#include "webapp_resources.h"
#include "webapp_shader.h"
#include "webapp_ui.h"
#include "ui_cadence.h"

#pragma comment(lib, "d3d12.lib")
#pragma comment(lib, "dxgi.lib")
#pragma comment(lib, "d3dcompiler.lib")
#pragma comment(lib, "user32.lib")
#pragma comment(lib, "shell32.lib")
#pragma comment(lib, "windowscodecs.lib")
#pragma comment(lib, "ole32.lib")

using Microsoft::WRL::ComPtr;
using native_three::WebappHost;

namespace {

constexpr UINT kFrameCount = 2;
constexpr UINT kVertexFloats = 12;                    // position, normal, colour rgba, uv
constexpr UINT kVertexStride = kVertexFloats * sizeof(float);
constexpr UINT kMaxTextures = 4096;                  // shader-visible SRV slots (slot 0: white)
constexpr UINT kInstanceStride = 19 * sizeof(float); // 4x4 matrix + colour
constexpr UINT kFrameCBBytes = 1280;                 // see cbuffer Frame
constexpr UINT kDrawCBBytes = 256;
// Draw flags (js/native-renderer.mjs DrawFlags)
constexpr UINT F_TRANSPARENT = 1, F_DOUBLE = 2, F_BACK = 4, F_NO_DEPTH_WRITE = 32,
               F_NO_DEPTH_TEST = 64, F_LINES = 128, F_LINE_STRIP = 256, F_MAP = 4096,
               F_DEPTH_ONLY = 2097152, F_ADDITIVE_BLEND = 4194304,
               F_POLYGON_OFFSET = 8388608, F_FRONT_CW = 16777216;
constexpr UINT kMaxOffscreenDepthTargets = 64;
constexpr UINT P_CLEAR_COLOR = 1, P_CLEAR_DEPTH = 2;

std::wstring widen(const std::string& s) {
    if (s.empty()) return {};
    const int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), nullptr, 0);
    std::wstring w(n, L'\0');
    MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), w.data(), n);
    return w;
}

D3D12_HEAP_PROPERTIES heapProps(D3D12_HEAP_TYPE type) {
    D3D12_HEAP_PROPERTIES p{};
    p.Type = type;
    p.CreationNodeMask = 1;
    p.VisibleNodeMask = 1;
    return p;
}
D3D12_RESOURCE_DESC bufferDesc(UINT64 bytes) {
    D3D12_RESOURCE_DESC d{};
    d.Dimension = D3D12_RESOURCE_DIMENSION_BUFFER;
    d.Width = std::max<UINT64>(bytes, 256);
    d.Height = 1;
    d.DepthOrArraySize = 1;
    d.MipLevels = 1;
    d.SampleDesc.Count = 1;
    d.Layout = D3D12_TEXTURE_LAYOUT_ROW_MAJOR;
    return d;
}

struct Geometry {
    ComPtr<ID3D12Resource> vertices, indices;
    D3D12_VERTEX_BUFFER_VIEW vbv{};
    D3D12_INDEX_BUFFER_VIEW ibv{};
    UINT vertexCount = 0, indexCount = 0;
};
struct InstanceSet {
    std::vector<float> cpu;   // count * 19 floats
    UINT count = 0;
    UINT64 version = 0;
    ComPtr<ID3D12Resource> gpu[kFrameCount];
    UINT capacity[kFrameCount] = {};
    UINT64 uploaded[kFrameCount] = {};
};
struct Retired {
    ComPtr<ID3D12Resource> resource;
    UINT64 fence;
};
struct Texture {
    ComPtr<ID3D12Resource> resource;
    UINT slot = 0;
    UINT width = 0, height = 0;
    UINT64 allocationBytes = 0;
    bool float32 = false;
};
struct DepthTarget {
    ComPtr<ID3D12Resource> resource;
    UINT slot = 0;
    UINT width = 0, height = 0;
};
// A texture whose pixels still have to be copied on the GPU timeline.
struct PendingTextureCopy {
    ComPtr<ID3D12Resource> texture, staging;
    std::vector<D3D12_PLACED_SUBRESOURCE_FOOTPRINT> layouts;
};
struct PendingFloatCopy {
    ComPtr<ID3D12Resource> texture, staging;
    D3D12_PLACED_SUBRESOURCE_FOOTPRINT layout{};
    UINT x = 0, y = 0;
};
struct RetiredSlot {
    UINT slot;
    UINT64 fence;
};

// RGBA8 mip chain built on the CPU (box filter, like glGenerateMipmap).
std::vector<std::vector<std::uint8_t>> buildMips(std::vector<std::uint8_t> base, UINT w, UINT h, bool mips) {
    std::vector<std::vector<std::uint8_t>> levels;
    levels.push_back(std::move(base));
    while (mips && (w > 1 || h > 1)) {
        const UINT nw = std::max(1u, w / 2), nh = std::max(1u, h / 2);
        const std::vector<std::uint8_t>& src = levels.back();
        std::vector<std::uint8_t> dst(std::size_t(nw) * nh * 4);
        for (UINT y = 0; y < nh; y++) {
            const UINT y0 = std::min(h - 1, y * 2), y1 = std::min(h - 1, y * 2 + 1);
            for (UINT x = 0; x < nw; x++) {
                const UINT x0 = std::min(w - 1, x * 2), x1 = std::min(w - 1, x * 2 + 1);
                const std::uint8_t* a = &src[(std::size_t(y0) * w + x0) * 4];
                const std::uint8_t* b = &src[(std::size_t(y0) * w + x1) * 4];
                const std::uint8_t* c = &src[(std::size_t(y1) * w + x0) * 4];
                const std::uint8_t* d = &src[(std::size_t(y1) * w + x1) * 4];
                std::uint8_t* o = &dst[(std::size_t(y) * nw + x) * 4];
                // colour weighted by alpha so transparent texels do not darken edges
                const UINT aw = UINT(a[3]) + b[3] + c[3] + d[3];
                for (int k = 0; k < 3; k++) {
                    o[k] = aw ? std::uint8_t((UINT(a[k]) * a[3] + UINT(b[k]) * b[3] + UINT(c[k]) * c[3] + UINT(d[k]) * d[3] + aw / 2) / aw)
                              : std::uint8_t((UINT(a[k]) + b[k] + c[k] + d[k] + 2) / 4);
                }
                o[3] = std::uint8_t((aw + 2) / 4);
            }
        }
        levels.push_back(std::move(dst));
        w = nw;
        h = nh;
    }
    return levels;
}

class WebappWindow final : public native_three::WebappRenderSink {
public:
    explicit WebappWindow(std::filesystem::path root) : root_(std::move(root)) {}
    int run(HINSTANCE instance);

    // ---- WebappRenderSink
    void uploadGeometry(std::uint32_t id, const float* p, const float* n, const float* c,
                        std::uint32_t vertexCount, const std::uint32_t* idx, std::uint32_t indexCount, const float* uv,
                        std::uint32_t colorChannels) override;
    void releaseGeometry(std::uint32_t id) override;
    bool uploadTexture(std::uint32_t id, const std::uint8_t* data, std::size_t bytes, std::uint32_t width,
                       std::uint32_t height, std::uint32_t flags) override;
    bool updateFloatTexture(std::uint32_t id, std::uint32_t x, std::uint32_t y,
                            std::uint32_t w, std::uint32_t h,
                            const std::uint8_t* data, std::size_t bytes) override;
    void releaseTexture(std::uint32_t id) override;
    bool allocateDepthTarget(std::uint32_t id, std::uint32_t width, std::uint32_t height) override;
    void releaseDepthTarget(std::uint32_t id) override;
    bool uploadCanvasTexture(std::uint32_t id, std::uint32_t canvasId, std::uint32_t flags) override;
    void uploadInstances(std::uint32_t id, const float* m, const float* c, std::uint32_t count) override;
    void releaseInstances(std::uint32_t id) override;
    bool registerColorPatch(std::uint32_t id, const std::string& source) override;
    void submitPass(const float* data, std::size_t floats) override {
        if (pendingPasses_.size() >= native_three::safety::kMaxPassesPerFrame ||
            floats > 4'194'304 - pendingPassFloats_ ||
            !native_three::safety::validPass(data, floats,
                native_three::kWebappPassHeaderFloats, native_three::kWebappLightFloats,
                native_three::kWebappDrawFloats, UINT(native_three::kWebappMaxLights))) {
            if (invalidPacketWarnings_++ < 8) log("warn", "[dx12-safety] rejected malformed or oversized render packet");
            return;
        }
        pendingPasses_.emplace_back(data, data + floats);
        pendingPassFloats_ += floats;
    }
    void setTitle(const std::string& title) override { pageTitle_ = widen(title); }
    void log(const std::string& level, const std::string& text) override;
    void reportUi(double styleMs, double layoutMs, double paintMs, int forced, int full, int partial) override {
        perf_.uiStyle += styleMs; perf_.uiLayout += layoutMs; perf_.uiPaint += paintMs;
        perf_.forced += forced; perf_.full += full; perf_.partial += partial;
    }
    void submitUi(const float* data, std::size_t floats, const std::string& strings) override {
        if (uiReady_) ui_.setDisplayList(data, floats, strings);
    }
    void setCursor(const std::string& css) override {
        LPCWSTR id = IDC_ARROW;
        if (css == "pointer") id = IDC_HAND;
        else if (css == "text" || css == "vertical-text") id = IDC_IBEAM;
        else if (css == "move" || css == "all-scroll" || css == "grab" || css == "grabbing") id = IDC_SIZEALL;
        else if (css == "not-allowed" || css == "no-drop") id = IDC_NO;
        else if (css == "wait") id = IDC_WAIT;
        else if (css == "progress") id = IDC_APPSTARTING;
        else if (css == "crosshair" || css == "cell") id = IDC_CROSS;
        else if (css == "help") id = IDC_HELP;
        else if (css == "ew-resize" || css == "col-resize" || css == "e-resize" || css == "w-resize") id = IDC_SIZEWE;
        else if (css == "ns-resize" || css == "row-resize" || css == "n-resize" || css == "s-resize") id = IDC_SIZENS;
        cursorHidden_ = css == "none";
        cursor_ = LoadCursorW(nullptr, id);
        SetCursor(cursorHidden_ ? nullptr : cursor_);
    }
    void canvasCommands(std::uint32_t id, std::uint32_t w, std::uint32_t h, const float* ops, std::size_t floats,
                        const std::string& strings) override {
        if (uiReady_) ui_.canvasCommands(id, w, h, ops, floats, strings);
    }
    bool canvasRead(std::uint32_t id, std::int32_t x, std::int32_t y, std::uint32_t w, std::uint32_t h,
                    std::vector<std::uint8_t>& rgba) override {
        return uiReady_ && ui_.canvasRead(id, x, y, w, h, rgba);
    }
    void canvasWrite(std::uint32_t id, std::uint32_t cw, std::uint32_t ch, std::int32_t x, std::int32_t y, std::uint32_t w,
                     std::uint32_t h, const std::uint8_t* rgba) override {
        if (uiReady_) ui_.canvasWrite(id, cw, ch, x, y, w, h, rgba);
    }
    void registerImage(const std::string& key, const std::uint8_t* bytes, std::size_t n) override {
        if (uiReady_) ui_.registerImage(key, bytes, n);
    }
    double measureText(const std::string& families, double size, int weight, bool italic, const std::string& text) override {
        return uiReady_ ? ui_.measureText(families, size, weight, italic, text) : -1.0;
    }

    LRESULT handle(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp);

private:
    void check(HRESULT hr, const char* what);
    void reportDeviceLoss(const char* stage);
    void waitForFenceValue(UINT64 value, const char* stage);
    void initDevice();
    void createSizeDependent();
    void releaseSizeDependent();
    void resize(UINT width, UINT height);
    void waitForGpu();
    ComPtr<ID3D12Resource> uploadBuffer(const void* data, UINT64 bytes);
    void retire(ComPtr<ID3D12Resource>& resource);
    void collectRetired();
    ID3D12PipelineState* pipeline(UINT flags, UINT patchId);
    void renderFrame();
    void updateTitle(double fps);
    void keyEvent(bool down, WPARAM vk, LPARAM lp);
    void initUi();
    void initTextures();
    void resetTextures();
    void resetPage();
    bool decodeImage(const std::uint8_t* data, std::size_t bytes, std::vector<std::uint8_t>& rgba, UINT& w, UINT& h);
    bool createTexture(std::uint32_t id, std::vector<std::uint8_t> rgba, UINT w, UINT h, std::uint32_t flags);
    void recordTextureCopies();
    D3D12_GPU_DESCRIPTOR_HANDLE textureHandle(std::uint32_t id) const;
    void uploadUi(UINT frame);
    void drawUi(UINT frame);

    std::filesystem::path root_;
    HWND window_ = nullptr;
    UINT width_ = 1280, height_ = 720;
    bool minimized_ = false;
    WebappHost host_;
    std::FILE* log_ = nullptr;
    std::wstring pageTitle_ = L"Three.js webapp";
    std::wstring adapterName_ = L"GPU";
    int logErrors_ = 0;
    unsigned invalidPacketWarnings_ = 0;
    unsigned invalidDrawWarnings_ = 0;
    bool flightLog_ = false;
    UINT64 submissionSerial_ = 0;
    bool bootDialogShown_ = false;

    D3D12_CPU_DESCRIPTOR_HANDLE depthViewHandle(UINT slot) const {
        D3D12_CPU_DESCRIPTOR_HANDLE view = dsvHeap_->GetCPUDescriptorHandleForHeapStart();
        view.ptr += SIZE_T(slot) * dsvStep_;
        return view;
    }
    ComPtr<IDXGIFactory4> factory_;
    ComPtr<ID3D12Device> device_;
    ComPtr<ID3D12CommandQueue> queue_;
    ComPtr<IDXGISwapChain3> swap_;
    ComPtr<ID3D12DescriptorHeap> rtvHeap_, dsvHeap_;
    UINT rtvStep_ = 0, dsvStep_ = 0;
    UINT nextDepthSlot_ = 1;
    std::vector<UINT> freeDepthSlots_;
    std::unordered_map<std::uint32_t, DepthTarget> depthTargets_;
    ComPtr<ID3D12Resource> targets_[kFrameCount], depth_;
    ComPtr<ID3D12CommandAllocator> allocators_[kFrameCount];
    ComPtr<ID3D12GraphicsCommandList> cmd_;
    ComPtr<ID3D12Fence> fence_;
    HANDLE fenceEvent_ = nullptr;
    UINT64 fenceValue_ = 0;
    UINT64 frameFence_[kFrameCount] = {};
    ComPtr<ID3D12RootSignature> root_sig_;
    ComPtr<ID3DBlob> vs_, ps_;
    std::map<UINT, ComPtr<ID3D12PipelineState>> pipelines_;
    std::map<UINT, ComPtr<ID3DBlob>> colorPatches_;
    ComPtr<ID3D12Resource> ring_[kFrameCount];
    UINT64 ringBytes_[kFrameCount] = {};
    ComPtr<ID3D12Resource> identityInstance_;
    D3D12_VERTEX_BUFFER_VIEW identityView_{};

    std::unordered_map<std::uint32_t, Geometry> geometries_;
    std::unordered_map<std::uint32_t, InstanceSet> instances_;
    std::unordered_map<std::uint32_t, Texture> textures_;
    std::vector<PendingTextureCopy> pendingCopies_;
    std::vector<PendingFloatCopy> pendingFloatCopies_;
    std::vector<UINT> freeSlots_;
    std::vector<RetiredSlot> retiredSlots_;
    ComPtr<ID3D12DescriptorHeap> texHeap_;
    UINT texStep_ = 0;
    ComPtr<IWICImagingFactory> wic_;
    std::size_t textureBytes_ = 0;
    int textureFailures_ = 0;
    std::vector<Retired> retired_;
    std::vector<std::vector<float>> pendingPasses_, passes_;
    std::size_t pendingPassFloats_ = 0;
    UINT lastDraws_ = 0;

    std::chrono::steady_clock::time_point uiStatsAt_ = std::chrono::steady_clock::now();
    // NativeThreeBridge-webapp-frames.csv: one summary row per second.
    struct Perf {
        int frames = 0;
        double frameMs = 0, frameMax = 0, jsMs = 0, rasterMs = 0, renderMs = 0, fenceMs = 0, presentMs = 0;
        double uiStyle = 0, uiLayout = 0, uiPaint = 0;
        int forced = 0, full = 0, partial = 0, rasters = 0, uiTicks = 0;
    } perf_;
    std::FILE* perfCsv_ = nullptr;
    std::chrono::steady_clock::time_point perfAt_ = std::chrono::steady_clock::now();
    double fenceWaitMs_ = 0;
    double presentMs_ = 0;
    void writePerfRow(double atSeconds, double seconds);
    std::string uiLastStats_;
    HCURSOR cursor_ = LoadCursorW(nullptr, IDC_ARROW);
    bool cursorHidden_ = false;
    // HTML/CSS UI overlay: Direct2D raster -> texture -> premultiplied blend.
    native_three::WebappUiRenderer ui_;
    native_three::UiCadence uiCadence_{};
    bool uiReady_ = false, uiUpload_ = false, uiVisible_ = false;
    ComPtr<ID3D12Resource> uiTexture_, uiStaging_[kFrameCount];
    UINT64 uiStagingBytes_[kFrameCount] = {};
    UINT uiTexW_ = 0, uiTexH_ = 0;
    // One SRV slot per back buffer: a slot is rewritten only when the frame
    // that last used it has finished on the GPU.
    UINT64 uiTexVersion_ = 0, uiSrvVersion_[kFrameCount] = {};
    UINT uiSrvStep_ = 0;
    ComPtr<ID3D12DescriptorHeap> uiSrvHeap_;
    ComPtr<ID3D12RootSignature> uiRootSig_;
    ComPtr<ID3D12PipelineState> uiPso_;
};

const char* kUiShader = R"HLSL(
Texture2D gUi : register(t0);
SamplerState gPoint : register(s0);
struct V { float4 pos : SV_Position; float2 uv : TEXCOORD0; };
V VSMain(uint id : SV_VertexID) {
    V o;
    float2 uv = float2((id << 1) & 2, id & 2);
    o.uv = uv;
    o.pos = float4(uv * float2(2, -2) + float2(-1, 1), 0, 1);
    return o;
}
float4 PSMain(V i) : SV_Target { return gUi.Sample(gPoint, i.uv); }
)HLSL";

WebappWindow* gActive = nullptr;
std::FILE* gCrashLog = nullptr;
std::string gCrashPhase = "startup";

// Native crashes (access violation, stack overflow) must not just close the
// window silently: write what happened to the log and tell the user.
LONG WINAPI webappCrashFilter(EXCEPTION_POINTERS* info) {
    char text[512];
    const DWORD code = info && info->ExceptionRecord ? info->ExceptionRecord->ExceptionCode : 0;
    const void* address = info && info->ExceptionRecord ? info->ExceptionRecord->ExceptionAddress : nullptr;
    const char* name = code == EXCEPTION_STACK_OVERFLOW ? "stack overflow"
                     : code == EXCEPTION_ACCESS_VIOLATION ? "access violation"
                     : code == EXCEPTION_INT_DIVIDE_BY_ZERO ? "integer divide by zero" : "native exception";
    std::snprintf(text, sizeof text, "NativeThreeBridge crashed: %s (0x%08lX at %p) during %s.",
                  name, (unsigned long)code, address, gCrashPhase.c_str());
    if (gCrashLog) { std::fprintf(gCrashLog, "[crash] %s\n", text); std::fflush(gCrashLog); }
    if (GetEnvironmentVariableA("CI", nullptr, 0) == 0)
        MessageBoxA(nullptr, text, "NativeThreeBridge webapp", MB_OK | MB_ICONERROR);
    return EXCEPTION_EXECUTE_HANDLER;
}

LRESULT CALLBACK webappWndProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    if (gActive) return gActive->handle(hwnd, msg, wp, lp);
    return DefWindowProcW(hwnd, msg, wp, lp);
}

void WebappWindow::check(HRESULT hr, const char* what) {
    if (SUCCEEDED(hr)) return;
    char text[512];
    std::snprintf(text, sizeof text, "%s failed (HRESULT 0x%08lX)", what, (unsigned long)hr);
    log("error", text);
    if (device_) reportDeviceLoss(what);
    if (GetEnvironmentVariableA("CI", nullptr, 0) == 0)
        MessageBoxA(window_, text, "NativeThreeBridge webapp", MB_OK | MB_ICONERROR);
    ExitProcess(44);
}

void WebappWindow::log(const std::string& level, const std::string& text) {
    if (level == "error") logErrors_++;
    if (log_) {
        std::fprintf(log_, "[%s] %s\n", level.c_str(), text.c_str());
        std::fflush(log_);
    }
    OutputDebugStringA(("[webapp " + level + "] " + text + "\n").c_str());
}

void WebappWindow::reportDeviceLoss(const char* stage) {
    if (!device_) return;
    const HRESULT reason = device_->GetDeviceRemovedReason();
    char message[240];
    std::snprintf(message, sizeof message, "[dx12-safety] %s: GetDeviceRemovedReason=0x%08lX",
                  stage, static_cast<unsigned long>(reason));
    log(FAILED(reason) ? "error" : "warn", message);
    ComPtr<ID3D12DeviceRemovedExtendedData> dred;
    if (FAILED(device_.As(&dred))) {
        log("warn", "[dx12-safety] DRED unavailable on this Windows version");
        return;
    }
    D3D12_DRED_AUTO_BREADCRUMBS_OUTPUT breadcrumbs{};
    if (SUCCEEDED(dred->GetAutoBreadcrumbsOutput(&breadcrumbs))) {
        unsigned count = 0;
        for (auto* node = breadcrumbs.pHeadAutoBreadcrumbNode;
             node && count++ < 16; node = node->pNext) {
            const UINT last = node->pLastBreadcrumbValue ? *node->pLastBreadcrumbValue : 0u;
            std::snprintf(message, sizeof message, "[dx12-dred] queue=%s list=%s completed=%u/%u",
                          node->pCommandQueueDebugNameA ? node->pCommandQueueDebugNameA : "?",
                          node->pCommandListDebugNameA ? node->pCommandListDebugNameA : "?",
                          last, node->BreadcrumbCount);
            log("error", message);
        }
    }
    D3D12_DRED_PAGE_FAULT_OUTPUT fault{};
    if (SUCCEEDED(dred->GetPageFaultAllocationOutput(&fault)) && fault.PageFaultVA != 0) {
        std::snprintf(message, sizeof message, "[dx12-dred] page fault GPU virtual address=0x%llX",
                      static_cast<unsigned long long>(fault.PageFaultVA));
        log("error", message);
    }
}

void WebappWindow::waitForFenceValue(UINT64 value, const char* stage) {
    if (fence_->GetCompletedValue() >= value) return;
    check(fence_->SetEventOnCompletion(value, fenceEvent_), "SetEventOnCompletion");
    const DWORD result = WaitForSingleObject(fenceEvent_, native_three::safety::kFenceTimeoutMs);
    if (result == WAIT_OBJECT_0 && fence_->GetCompletedValue() >= value) return;
    char detail[256];
    std::snprintf(detail, sizeof detail,
                  "[dx12-safety] %s: GPU fence wait failed or exceeded %lu ms (wait=%lu, target=%llu, completed=%llu)",
                  stage, static_cast<unsigned long>(native_three::safety::kFenceTimeoutMs),
                  static_cast<unsigned long>(result), static_cast<unsigned long long>(value),
                  static_cast<unsigned long long>(fence_->GetCompletedValue()));
    log("error", detail);
    reportDeviceLoss(stage);
    // Never spin forever on a dead GPU; allow the OS to reclaim this process.
    ExitProcess(45);
}

void WebappWindow::initDevice() {
    // DRED must be configured BEFORE D3D12CreateDevice. It records breadcrumbs
    // and allocation faults if the driver later reports a removed GPU.
    ComPtr<ID3D12DeviceRemovedExtendedDataSettings> dredSettings;
    if (SUCCEEDED(D3D12GetDebugInterface(IID_PPV_ARGS(&dredSettings)))) {
        dredSettings->SetAutoBreadcrumbsEnablement(D3D12_DRED_ENABLEMENT_FORCED_ON);
        dredSettings->SetPageFaultEnablement(D3D12_DRED_ENABLEMENT_FORCED_ON);
    }
    char trace[8] = {};
    flightLog_ = GetEnvironmentVariableA("NATIVETHREE_DX12_FLIGHTLOG", trace, sizeof trace) > 0 &&
                 std::strcmp(trace, "1") == 0;
    if (flightLog_)
        log("info", "[dx12-safety] GPU submission flight recorder enabled (file flush per submission)");
    char warp[8] = {};
    const bool forceWarp = GetEnvironmentVariableA("NATIVETHREE_DX12_WARP", warp, sizeof warp) > 0 &&
                           std::strcmp(warp, "1") == 0;
    char debug[8] = {};
    if (GetEnvironmentVariableA("NATIVETHREE_DX12_DEBUG", debug, sizeof debug) > 0 &&
        std::strcmp(debug, "1") == 0) {
        ComPtr<ID3D12Debug> layer;
        if (SUCCEEDED(D3D12GetDebugInterface(IID_PPV_ARGS(&layer))))
            layer->EnableDebugLayer(); // opt-in: substantial overhead, never auto-enabled
    }
    check(CreateDXGIFactory2(0, IID_PPV_ARGS(&factory_)), "Create DXGI factory");
    ComPtr<IDXGIFactory6> factory6;
    if (!forceWarp && SUCCEEDED(factory_.As(&factory6))) {
        for (UINT i = 0;; i++) {
            ComPtr<IDXGIAdapter1> adapter;
            if (factory6->EnumAdapterByGpuPreference(i, DXGI_GPU_PREFERENCE_HIGH_PERFORMANCE,
                                                     IID_PPV_ARGS(&adapter)) == DXGI_ERROR_NOT_FOUND)
                break;
            DXGI_ADAPTER_DESC1 info{};
            adapter->GetDesc1(&info);
            if (info.Flags & DXGI_ADAPTER_FLAG_SOFTWARE) continue;
            if (SUCCEEDED(D3D12CreateDevice(adapter.Get(), D3D_FEATURE_LEVEL_11_0, IID_PPV_ARGS(&device_)))) {
                adapterName_ = info.Description;
                break;
            }
        }
    }
    if (!device_) {
        if (!forceWarp && SUCCEEDED(D3D12CreateDevice(nullptr, D3D_FEATURE_LEVEL_11_0, IID_PPV_ARGS(&device_)))) {
            adapterName_ = L"Default hardware adapter";
        } else {
            ComPtr<IDXGIAdapter> software;
            check(factory_->EnumWarpAdapter(IID_PPV_ARGS(&software)), "Find WARP adapter");
            check(D3D12CreateDevice(software.Get(), D3D_FEATURE_LEVEL_11_0, IID_PPV_ARGS(&device_)),
                  "Create WARP DX12 device");
            adapterName_ = L"WARP (software)";
        }
    }
    if (forceWarp) log("info", "[dx12-safety] WARP software rendering enabled (no dedicated GPU adapter)");
    D3D12_COMMAND_QUEUE_DESC q{};
    q.Type = D3D12_COMMAND_LIST_TYPE_DIRECT;
    check(device_->CreateCommandQueue(&q, IID_PPV_ARGS(&queue_)), "Create command queue");

    DXGI_SWAP_CHAIN_DESC1 sd{};
    sd.Width = width_;
    sd.Height = height_;
    sd.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
    sd.SampleDesc.Count = 1;
    sd.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
    sd.BufferCount = kFrameCount;
    sd.SwapEffect = DXGI_SWAP_EFFECT_FLIP_DISCARD;
    ComPtr<IDXGISwapChain1> swap1;
    check(factory_->CreateSwapChainForHwnd(queue_.Get(), window_, &sd, nullptr, nullptr, &swap1), "Create swap chain");
    check(swap1.As(&swap_), "Swap chain v3");
    factory_->MakeWindowAssociation(window_, DXGI_MWA_NO_ALT_ENTER);

    D3D12_DESCRIPTOR_HEAP_DESC heap{};
    heap.NumDescriptors = kFrameCount;
    heap.Type = D3D12_DESCRIPTOR_HEAP_TYPE_RTV;
    check(device_->CreateDescriptorHeap(&heap, IID_PPV_ARGS(&rtvHeap_)), "RTV heap");
    rtvStep_ = device_->GetDescriptorHandleIncrementSize(D3D12_DESCRIPTOR_HEAP_TYPE_RTV);
    heap.NumDescriptors = 1 + kMaxOffscreenDepthTargets;
    heap.Type = D3D12_DESCRIPTOR_HEAP_TYPE_DSV;
    check(device_->CreateDescriptorHeap(&heap, IID_PPV_ARGS(&dsvHeap_)), "DSV heap");
    dsvStep_ = device_->GetDescriptorHandleIncrementSize(D3D12_DESCRIPTOR_HEAP_TYPE_DSV);

    for (UINT i = 0; i < kFrameCount; i++)
        check(device_->CreateCommandAllocator(D3D12_COMMAND_LIST_TYPE_DIRECT, IID_PPV_ARGS(&allocators_[i])), "Command allocator");
    check(device_->CreateCommandList(0, D3D12_COMMAND_LIST_TYPE_DIRECT, allocators_[0].Get(), nullptr,
                                     IID_PPV_ARGS(&cmd_)), "Command list");
    cmd_->Close();
    check(device_->CreateFence(0, D3D12_FENCE_FLAG_NONE, IID_PPV_ARGS(&fence_)), "Fence");
    fenceEvent_ = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    if (!fenceEvent_) check(HRESULT_FROM_WIN32(GetLastError()), "Create GPU fence event");

    // Root signature: b0 = frame constants, b1 = per-draw constants,
    // t0 = colour map; s0 repeat, s1 clamp, s2 mirrored repeat.
    D3D12_ROOT_PARAMETER params[3]{};
    for (UINT i = 0; i < 2; i++) {
        params[i].ParameterType = D3D12_ROOT_PARAMETER_TYPE_CBV;
        params[i].Descriptor.ShaderRegister = i;
        params[i].ShaderVisibility = D3D12_SHADER_VISIBILITY_ALL;
    }
    D3D12_DESCRIPTOR_RANGE texRange{};
    texRange.RangeType = D3D12_DESCRIPTOR_RANGE_TYPE_SRV;
    texRange.NumDescriptors = 1;
    texRange.OffsetInDescriptorsFromTableStart = D3D12_DESCRIPTOR_RANGE_OFFSET_APPEND;
    params[2].ParameterType = D3D12_ROOT_PARAMETER_TYPE_DESCRIPTOR_TABLE;
    params[2].DescriptorTable.NumDescriptorRanges = 1;
    params[2].DescriptorTable.pDescriptorRanges = &texRange;
    params[2].ShaderVisibility = D3D12_SHADER_VISIBILITY_PIXEL;
    D3D12_STATIC_SAMPLER_DESC samplers[3]{};
    const D3D12_TEXTURE_ADDRESS_MODE modes[3] = {D3D12_TEXTURE_ADDRESS_MODE_WRAP, D3D12_TEXTURE_ADDRESS_MODE_CLAMP,
                                                  D3D12_TEXTURE_ADDRESS_MODE_MIRROR};
    for (UINT i = 0; i < 3; i++) {
        samplers[i].Filter = D3D12_FILTER_ANISOTROPIC;
        samplers[i].MaxAnisotropy = 4;
        samplers[i].AddressU = samplers[i].AddressV = samplers[i].AddressW = modes[i];
        samplers[i].MaxLOD = D3D12_FLOAT32_MAX;
        samplers[i].ShaderRegister = i;
        samplers[i].ShaderVisibility = D3D12_SHADER_VISIBILITY_PIXEL;
    }
    D3D12_ROOT_SIGNATURE_DESC rs{};
    rs.NumParameters = 3;
    rs.pParameters = params;
    rs.NumStaticSamplers = 3;
    rs.pStaticSamplers = samplers;
    rs.Flags = D3D12_ROOT_SIGNATURE_FLAG_ALLOW_INPUT_ASSEMBLER_INPUT_LAYOUT;
    ComPtr<ID3DBlob> blob, error;
    check(D3D12SerializeRootSignature(&rs, D3D_ROOT_SIGNATURE_VERSION_1, &blob, &error), "Serialize root signature");
    check(device_->CreateRootSignature(0, blob->GetBufferPointer(), blob->GetBufferSize(), IID_PPV_ARGS(&root_sig_)), "Root signature");

    for (int stage = 0; stage < 2; stage++) {
        ComPtr<ID3DBlob> err;
        ID3DBlob** out = stage ? ps_.ReleaseAndGetAddressOf() : vs_.ReleaseAndGetAddressOf();
        HRESULT hr = D3DCompile(kWebappShader, std::strlen(kWebappShader), "webapp_shader", nullptr, nullptr,
                                stage ? "PSMain" : "VSMain", stage ? "ps_5_0" : "vs_5_0",
                                D3DCOMPILE_OPTIMIZATION_LEVEL3, 0, out, err.GetAddressOf());
        if (FAILED(hr) && err) log("error", static_cast<const char*>(err->GetBufferPointer()));
        check(hr, stage ? "Compile webapp pixel shader" : "Compile webapp vertex shader");
    }

    const float identity[19] = {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 1, 1};
    identityInstance_ = uploadBuffer(identity, sizeof identity);
    identityView_.BufferLocation = identityInstance_->GetGPUVirtualAddress();
    identityView_.SizeInBytes = sizeof identity;
    identityView_.StrideInBytes = kInstanceStride;
    createSizeDependent();
    initTextures();
    initUi();
}

// ------------------------------------------------------------- textures
void WebappWindow::initTextures() {
    D3D12_DESCRIPTOR_HEAP_DESC heap{};
    heap.NumDescriptors = kMaxTextures;
    heap.Type = D3D12_DESCRIPTOR_HEAP_TYPE_CBV_SRV_UAV;
    heap.Flags = D3D12_DESCRIPTOR_HEAP_FLAG_SHADER_VISIBLE;
    check(device_->CreateDescriptorHeap(&heap, IID_PPV_ARGS(&texHeap_)), "Texture descriptor heap");
    texStep_ = device_->GetDescriptorHandleIncrementSize(D3D12_DESCRIPTOR_HEAP_TYPE_CBV_SRV_UAV);
    resetTextures();
    const HRESULT co = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    (void)co; // S_FALSE / RPC_E_CHANGED_MODE: COM is already usable on this thread
    if (FAILED(CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&wic_))))
        log("warn", "WIC is not available: image textures cannot be decoded");
}

void WebappWindow::resetTextures() {
    pendingCopies_.clear();
    retired_.clear();
    retiredSlots_.clear();
    textures_.clear();
    textureBytes_ = 0;
    textureFailures_ = 0;
    freeSlots_.clear();
    for (UINT slot = kMaxTextures - 1; slot >= 1; slot--) freeSlots_.push_back(slot);
    // slot 0: 1x1 white, bound for untextured draws
    createTexture(0, std::vector<std::uint8_t>(4, 255), 1, 1, 0);
}

void WebappWindow::resetPage() {
    host_.shutdown();
    waitForGpu();
    pendingPasses_.clear();
    pendingPassFloats_ = 0;
    passes_.clear();
    geometries_.clear();
    instances_.clear();
    resetTextures();
    pipelines_.clear();
    colorPatches_.clear();
    ui_.resetPage();
    uiCadence_.reset();
    uiUpload_ = uiVisible_ = false;
    lastDraws_ = 0;
    logErrors_ = 0;
    bootDialogShown_ = false;
    pageTitle_ = L"Three.js webapp";
    setCursor("auto");
}

bool WebappWindow::decodeImage(const std::uint8_t* data, std::size_t bytes, std::vector<std::uint8_t>& rgba, UINT& w, UINT& h) {
    if (!wic_ || !data || !bytes || bytes > 0x7fffffff) return false;
    ComPtr<IWICStream> stream;
    ComPtr<IWICBitmapDecoder> decoder;
    ComPtr<IWICBitmapFrameDecode> frame;
    ComPtr<IWICFormatConverter> converter;
    if (FAILED(wic_->CreateStream(&stream)) ||
        FAILED(stream->InitializeFromMemory(const_cast<BYTE*>(data), DWORD(bytes))) ||
        FAILED(wic_->CreateDecoderFromStream(stream.Get(), nullptr, WICDecodeMetadataCacheOnDemand, &decoder)) ||
        FAILED(decoder->GetFrame(0, &frame)) || FAILED(wic_->CreateFormatConverter(&converter)) ||
        FAILED(converter->Initialize(frame.Get(), GUID_WICPixelFormat32bppRGBA, WICBitmapDitherTypeNone, nullptr, 0,
                                     WICBitmapPaletteTypeCustom)))
        return false;
    if (FAILED(converter->GetSize(&w, &h)) ||
        !native_three::safety::validTextureDimensions(w, h, 4)) return false;
    rgba.resize(std::size_t(w) * h * 4);
    return SUCCEEDED(converter->CopyPixels(nullptr, w * 4, UINT(rgba.size()), rgba.data()));
}

bool WebappWindow::createTexture(std::uint32_t id, std::vector<std::uint8_t> rgba, UINT w, UINT h, std::uint32_t flags) {
    const bool inputFloat = (flags & native_three::kWebappTextureFloat32) != 0;
    const unsigned inputBpp = inputFloat ? 16u : 4u;
    if (!native_three::safety::validTextureDimensions(w, h, inputBpp) ||
        rgba.size() != std::size_t(w) * h * inputBpp) {
        if (textureFailures_++ < 8) log("warn", "[dx12-safety] rejected oversized or incomplete texture");
        return false;
    }
    UINT slot = 0;
    if (id != 0) {
        if (freeSlots_.empty()) {
            collectRetired();
            if (freeSlots_.empty()) {
                if (textureFailures_++ < 3) log("warn", "Too many textures at once (" + std::to_string(kMaxTextures) + "): some draws stay untextured");
                return false;
            }
        }
        slot = freeSlots_.back();
        freeSlots_.pop_back();
    }
    const bool float32 = (flags & native_three::kWebappTextureFloat32) != 0;
    const bool srgb = !float32 && (flags & native_three::kWebappTextureSrgb) != 0;
    const UINT bytesPerPixel = float32 ? 16 : 4;
    std::vector<std::vector<std::uint8_t>> levels;
    if (float32) levels.push_back(std::move(rgba)); // float data: no mips or quantisation
    else levels = buildMips(std::move(rgba), w, h, (flags & native_three::kWebappTextureMipmaps) != 0);
    D3D12_RESOURCE_DESC td{};
    td.Dimension = D3D12_RESOURCE_DIMENSION_TEXTURE2D;
    td.Width = w;
    td.Height = h;
    td.DepthOrArraySize = 1;
    td.MipLevels = UINT16(levels.size());
    td.Format = float32 ? DXGI_FORMAT_R32G32B32A32_FLOAT :
        srgb ? DXGI_FORMAT_R8G8B8A8_UNORM_SRGB : DXGI_FORMAT_R8G8B8A8_UNORM;
    td.SampleDesc.Count = 1;
    PendingTextureCopy copy;
    auto heap = heapProps(D3D12_HEAP_TYPE_DEFAULT);
    check(device_->CreateCommittedResource(&heap, D3D12_HEAP_FLAG_NONE, &td, D3D12_RESOURCE_STATE_COPY_DEST, nullptr,
                                           IID_PPV_ARGS(&copy.texture)), "Texture");
    copy.layouts.resize(levels.size());
    std::vector<UINT> rows(levels.size());
    std::vector<UINT64> rowBytes(levels.size());
    UINT64 total = 0;
    device_->GetCopyableFootprints(&td, 0, UINT(levels.size()), 0, copy.layouts.data(), rows.data(), rowBytes.data(), &total);
    UINT64 replacingBytes = 0;
    const auto replaced = textures_.find(id);
    if (replaced != textures_.end()) replacingBytes = replaced->second.allocationBytes;
    if (!native_three::safety::validBufferBytes(total) ||
        !native_three::safety::reserveTextureBudget(textureBytes_, replacingBytes, total)) {
        if (id != 0) freeSlots_.push_back(slot);
        if (textureFailures_++ < 8) log("warn", "[dx12-safety] rejected texture exceeding staging or 1 GiB live budget");
        return false;
    }
    copy.staging = uploadBuffer(nullptr, total);
    std::uint8_t* mapped = nullptr;
    D3D12_RANGE none{0, 0};
    check(copy.staging->Map(0, &none, reinterpret_cast<void**>(&mapped)), "Map texture staging");
    for (std::size_t m = 0; m < levels.size(); m++) {
        const auto& L = copy.layouts[m];
        const UINT lw = L.Footprint.Width;
        for (UINT y = 0; y < rows[m]; y++)
            std::memcpy(mapped + L.Offset + std::size_t(y) * L.Footprint.RowPitch, levels[m].data() + std::size_t(y) * lw * bytesPerPixel, std::size_t(lw) * bytesPerPixel);
    }
    copy.staging->Unmap(0, nullptr);

    D3D12_SHADER_RESOURCE_VIEW_DESC srv{};
    srv.Format = td.Format;
    srv.ViewDimension = D3D12_SRV_DIMENSION_TEXTURE2D;
    srv.Shader4ComponentMapping = D3D12_DEFAULT_SHADER_4_COMPONENT_MAPPING;
    srv.Texture2D.MipLevels = td.MipLevels;
    D3D12_CPU_DESCRIPTOR_HANDLE cpu = texHeap_->GetCPUDescriptorHandleForHeapStart();
    cpu.ptr += SIZE_T(slot) * texStep_;
    device_->CreateShaderResourceView(copy.texture.Get(), &srv, cpu);

    if (id != 0) releaseTexture(id);
    Texture& t = textures_[id];
    t.resource = copy.texture;
    t.slot = slot;
    t.width = w;
    t.height = h;
    t.allocationBytes = total;
    t.float32 = float32;
    textureBytes_ += std::size_t(total);
    pendingCopies_.push_back(std::move(copy));
    return true;
}

bool WebappWindow::allocateDepthTarget(std::uint32_t id, std::uint32_t width, std::uint32_t height) {
    if (!id || !device_ || width < 1 || height < 1 || width > 4096 || height > 4096) return false;
    auto existing = depthTargets_.find(id);
    if (existing != depthTargets_.end()) {
        if (existing->second.width == width && existing->second.height == height) return true;
        releaseDepthTarget(id);
    }
    UINT slot = 0;
    if (!freeDepthSlots_.empty()) {
        slot = freeDepthSlots_.back(); freeDepthSlots_.pop_back();
    } else if (nextDepthSlot_ <= kMaxOffscreenDepthTargets) {
        slot = nextDepthSlot_++;
    } else {
        log("warn", "[depth] maximum offscreen targets reached");
        return false;
    }
    D3D12_RESOURCE_DESC desc{};
    desc.Dimension = D3D12_RESOURCE_DIMENSION_TEXTURE2D;
    desc.Width = width; desc.Height = height;
    desc.DepthOrArraySize = 1; desc.MipLevels = 1;
    // WebGL2 DEPTH_COMPONENT24 minimum precision is fulfilled by D32_FLOAT.
    // HLSL sampler2DShadow PCF sampling still requires a separate shader stage.
    desc.Format = DXGI_FORMAT_D32_FLOAT;
    desc.SampleDesc.Count = 1;
    desc.Flags = D3D12_RESOURCE_FLAG_ALLOW_DEPTH_STENCIL;
    D3D12_CLEAR_VALUE clear{};
    clear.Format = DXGI_FORMAT_D32_FLOAT;
    clear.DepthStencil.Depth = 1.0f;
    ComPtr<ID3D12Resource> texture;
    auto heap = heapProps(D3D12_HEAP_TYPE_DEFAULT);
    HRESULT hr = device_->CreateCommittedResource(&heap, D3D12_HEAP_FLAG_NONE,
        &desc, D3D12_RESOURCE_STATE_DEPTH_WRITE, &clear, IID_PPV_ARGS(&texture));
    if (FAILED(hr)) {
        freeDepthSlots_.push_back(slot);
        log("warn", "[depth] D32_FLOAT allocation failed");
        return false;
    }
    device_->CreateDepthStencilView(texture.Get(), nullptr, depthViewHandle(slot));
    DepthTarget target{};
    target.resource = texture;
    target.slot = slot; target.width = width; target.height = height;
    depthTargets_.emplace(id, std::move(target));
    log("info", "[depth] allocated DX12 D32_FLOAT target " + std::to_string(id) +
        " " + std::to_string(width) + "x" + std::to_string(height));
    return true;
}

void WebappWindow::releaseDepthTarget(std::uint32_t id) {
    auto it = depthTargets_.find(id);
    if (it == depthTargets_.end()) return;
    // Reuse DSV descriptors only after all in-flight GPU consumers finish.
    waitForGpu();
    freeDepthSlots_.push_back(it->second.slot);
    depthTargets_.erase(it);
}

bool WebappWindow::updateFloatTexture(std::uint32_t id, std::uint32_t x, std::uint32_t y,
                                         std::uint32_t w, std::uint32_t h,
                                         const std::uint8_t* data, std::size_t bytes) {
    auto it = textures_.find(id);
    if (it == textures_.end() || !it->second.float32 || !it->second.resource ||
        !w || !h || !data || x > it->second.width || y > it->second.height ||
        w > it->second.width - x || h > it->second.height - y ||
        bytes != std::size_t(w) * h * 16) return false;
    // D3D12 requires the row pitch of an upload buffer to be 256-aligned.
    const UINT rowPitch = (w * 16u + D3D12_TEXTURE_DATA_PITCH_ALIGNMENT - 1u) &
                          ~(D3D12_TEXTURE_DATA_PITCH_ALIGNMENT - 1u);
    PendingFloatCopy copy;
    copy.texture = it->second.resource;
    copy.x = x; copy.y = y;
    copy.layout.Offset = 0;
    copy.layout.Footprint.Format = DXGI_FORMAT_R32G32B32A32_FLOAT;
    copy.layout.Footprint.Width = w;
    copy.layout.Footprint.Height = h;
    copy.layout.Footprint.Depth = 1;
    copy.layout.Footprint.RowPitch = rowPitch;
    copy.staging = uploadBuffer(nullptr, UINT64(rowPitch) * h);
    std::uint8_t* mapped = nullptr;
    D3D12_RANGE none{0, 0};
    check(copy.staging->Map(0, &none, reinterpret_cast<void**>(&mapped)), "Map RGBA32F staging");
    for (UINT row = 0; row < h; row++)
        std::memcpy(mapped + UINT64(row) * rowPitch,
                    data + std::size_t(row) * w * 16, std::size_t(w) * 16);
    copy.staging->Unmap(0, nullptr);
    pendingFloatCopies_.push_back(std::move(copy));
    return true;
}

void WebappWindow::releaseTexture(std::uint32_t id) {
    auto it = textures_.find(id);
    if (it == textures_.end() || id == 0) return;
    retire(it->second.resource);
    retiredSlots_.push_back({it->second.slot, fenceValue_ + kFrameCount});
    textureBytes_ -= std::size_t(it->second.allocationBytes);
    textures_.erase(it);
}

bool WebappWindow::uploadTexture(std::uint32_t id, const std::uint8_t* data, std::size_t bytes, std::uint32_t width,
                                 std::uint32_t height, std::uint32_t flags) {
    if (id == 0) return false;
    std::vector<std::uint8_t> rgba;
    UINT w = width, h = height;
    if (width) {
        const bool float32 = (flags & native_three::kWebappTextureFloat32) != 0;
        const std::size_t bpp = float32 ? 16u : 4u;
        if (!native_three::safety::validTextureDimensions(width, height, unsigned(bpp)) ||
            (float32 && (width > 4096 || height > 1024)) ||
            bytes < std::size_t(width) * height * bpp) return false;
        rgba.assign(data, data + std::size_t(width) * height * bpp);
    } else if (!decodeImage(data, bytes, rgba, w, h)) {
        if (textureFailures_++ < 5) log("warn", "Texture image could not be decoded (" + std::to_string(bytes) + " bytes; WebP needs the Windows WebP Image Extension)");
        return false;
    }
    return createTexture(id, std::move(rgba), w, h, flags);
}

bool WebappWindow::uploadCanvasTexture(std::uint32_t id, std::uint32_t canvasId, std::uint32_t flags) {
    if (id == 0 || !uiReady_) return false;
    std::vector<std::uint8_t> rgba;
    UINT w = 0, h = 0;
    if (!ui_.canvasPixelsRgba(canvasId, rgba, w, h)) return false;
    return createTexture(id, std::move(rgba), w, h, flags);
}

// Copies queued texture pixels; runs at the start of a frame's command list.
void WebappWindow::recordTextureCopies() {
    if (pendingCopies_.empty() && pendingFloatCopies_.empty()) return;
    std::vector<D3D12_RESOURCE_BARRIER> barriers;
    for (auto& c : pendingCopies_) {
        for (UINT m = 0; m < UINT(c.layouts.size()); m++) {
            D3D12_TEXTURE_COPY_LOCATION dst{}, src{};
            dst.pResource = c.texture.Get();
            dst.Type = D3D12_TEXTURE_COPY_TYPE_SUBRESOURCE_INDEX;
            dst.SubresourceIndex = m;
            src.pResource = c.staging.Get();
            src.Type = D3D12_TEXTURE_COPY_TYPE_PLACED_FOOTPRINT;
            src.PlacedFootprint = c.layouts[m];
            cmd_->CopyTextureRegion(&dst, 0, 0, 0, &src, nullptr);
        }
        D3D12_RESOURCE_BARRIER b{};
        b.Type = D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;
        b.Transition.pResource = c.texture.Get();
        b.Transition.Subresource = D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES;
        b.Transition.StateBefore = D3D12_RESOURCE_STATE_COPY_DEST;
        b.Transition.StateAfter = D3D12_RESOURCE_STATE_PIXEL_SHADER_RESOURCE;
        barriers.push_back(b);
    }
    if (!barriers.empty())
        cmd_->ResourceBarrier(UINT(barriers.size()), barriers.data());
    for (auto& c : pendingCopies_) {
        retire(c.staging);
        // the texture itself stays referenced by textures_ (or is retired there)
        ComPtr<ID3D12Resource> keep = c.texture;
        retire(keep);
    }
    pendingCopies_.clear();
    // Update an existing float texture without replacing its SRV descriptor
    // (critical for many animated bone rows per frame).
    for (auto& c : pendingFloatCopies_) {
        D3D12_RESOURCE_BARRIER barrier{};
        barrier.Type = D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;
        barrier.Transition.pResource = c.texture.Get();
        barrier.Transition.Subresource = D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES;
        barrier.Transition.StateBefore = D3D12_RESOURCE_STATE_PIXEL_SHADER_RESOURCE;
        barrier.Transition.StateAfter = D3D12_RESOURCE_STATE_COPY_DEST;
        cmd_->ResourceBarrier(1, &barrier);
        D3D12_TEXTURE_COPY_LOCATION dst{}, src{};
        dst.pResource = c.texture.Get();
        dst.Type = D3D12_TEXTURE_COPY_TYPE_SUBRESOURCE_INDEX;
        dst.SubresourceIndex = 0;
        src.pResource = c.staging.Get();
        src.Type = D3D12_TEXTURE_COPY_TYPE_PLACED_FOOTPRINT;
        src.PlacedFootprint = c.layout;
        cmd_->CopyTextureRegion(&dst, c.x, c.y, 0, &src, nullptr);
        std::swap(barrier.Transition.StateBefore, barrier.Transition.StateAfter);
        cmd_->ResourceBarrier(1, &barrier);
        retire(c.staging);
    }
    pendingFloatCopies_.clear();
}

D3D12_GPU_DESCRIPTOR_HANDLE WebappWindow::textureHandle(std::uint32_t id) const {
    D3D12_GPU_DESCRIPTOR_HANDLE gpu = texHeap_->GetGPUDescriptorHandleForHeapStart();
    auto it = textures_.find(id);
    const UINT slot = it == textures_.end() ? textures_.at(0).slot : it->second.slot;
    gpu.ptr += UINT64(slot) * texStep_;
    return gpu;
}

void WebappWindow::initUi() {
    std::string error;
    uiReady_ = ui_.init(root_, error);
    if (!error.empty()) log(uiReady_ ? "warn" : "error", "HTML/CSS UI layer: " + error);
    if (!uiReady_) return;
    D3D12_DESCRIPTOR_HEAP_DESC heap{};
    heap.NumDescriptors = kFrameCount;
    heap.Type = D3D12_DESCRIPTOR_HEAP_TYPE_CBV_SRV_UAV;
    heap.Flags = D3D12_DESCRIPTOR_HEAP_FLAG_SHADER_VISIBLE;
    check(device_->CreateDescriptorHeap(&heap, IID_PPV_ARGS(&uiSrvHeap_)), "UI descriptor heap");
    uiSrvStep_ = device_->GetDescriptorHandleIncrementSize(D3D12_DESCRIPTOR_HEAP_TYPE_CBV_SRV_UAV);

    D3D12_DESCRIPTOR_RANGE range{};
    range.RangeType = D3D12_DESCRIPTOR_RANGE_TYPE_SRV;
    range.NumDescriptors = 1;
    range.OffsetInDescriptorsFromTableStart = D3D12_DESCRIPTOR_RANGE_OFFSET_APPEND;
    D3D12_ROOT_PARAMETER param{};
    param.ParameterType = D3D12_ROOT_PARAMETER_TYPE_DESCRIPTOR_TABLE;
    param.DescriptorTable.NumDescriptorRanges = 1;
    param.DescriptorTable.pDescriptorRanges = &range;
    param.ShaderVisibility = D3D12_SHADER_VISIBILITY_PIXEL;
    D3D12_STATIC_SAMPLER_DESC sampler{};
    sampler.Filter = D3D12_FILTER_MIN_MAG_MIP_POINT;
    sampler.AddressU = sampler.AddressV = sampler.AddressW = D3D12_TEXTURE_ADDRESS_MODE_CLAMP;
    sampler.MaxLOD = D3D12_FLOAT32_MAX;
    sampler.ShaderVisibility = D3D12_SHADER_VISIBILITY_PIXEL;
    D3D12_ROOT_SIGNATURE_DESC rs{};
    rs.NumParameters = 1;
    rs.pParameters = &param;
    rs.NumStaticSamplers = 1;
    rs.pStaticSamplers = &sampler;
    ComPtr<ID3DBlob> blob, err;
    check(D3D12SerializeRootSignature(&rs, D3D_ROOT_SIGNATURE_VERSION_1, &blob, &err), "Serialize UI root signature");
    check(device_->CreateRootSignature(0, blob->GetBufferPointer(), blob->GetBufferSize(), IID_PPV_ARGS(&uiRootSig_)), "UI root signature");

    ComPtr<ID3DBlob> vs, ps;
    for (int stage = 0; stage < 2; stage++) {
        ComPtr<ID3DBlob> e;
        const HRESULT hr = D3DCompile(kUiShader, std::strlen(kUiShader), "webapp_ui_shader", nullptr, nullptr,
                                      stage ? "PSMain" : "VSMain", stage ? "ps_5_0" : "vs_5_0", D3DCOMPILE_OPTIMIZATION_LEVEL3, 0,
                                      stage ? ps.GetAddressOf() : vs.GetAddressOf(), e.GetAddressOf());
        if (FAILED(hr) && e) log("error", static_cast<const char*>(e->GetBufferPointer()));
        check(hr, stage ? "Compile UI pixel shader" : "Compile UI vertex shader");
    }
    D3D12_GRAPHICS_PIPELINE_STATE_DESC d{};
    d.pRootSignature = uiRootSig_.Get();
    d.VS = {vs->GetBufferPointer(), vs->GetBufferSize()};
    d.PS = {ps->GetBufferPointer(), ps->GetBufferSize()};
    d.PrimitiveTopologyType = D3D12_PRIMITIVE_TOPOLOGY_TYPE_TRIANGLE;
    d.RasterizerState.FillMode = D3D12_FILL_MODE_SOLID;
    d.RasterizerState.CullMode = D3D12_CULL_MODE_NONE;
    d.RasterizerState.DepthClipEnable = TRUE;
    auto& bt = d.BlendState.RenderTarget[0];
    bt.BlendEnable = TRUE;                       // premultiplied alpha
    bt.SrcBlend = D3D12_BLEND_ONE;
    bt.DestBlend = D3D12_BLEND_INV_SRC_ALPHA;
    bt.BlendOp = D3D12_BLEND_OP_ADD;
    bt.SrcBlendAlpha = D3D12_BLEND_ONE;
    bt.DestBlendAlpha = D3D12_BLEND_INV_SRC_ALPHA;
    bt.BlendOpAlpha = D3D12_BLEND_OP_ADD;
    bt.LogicOp = D3D12_LOGIC_OP_NOOP;
    bt.RenderTargetWriteMask = D3D12_COLOR_WRITE_ENABLE_ALL;
    d.DepthStencilState.DepthEnable = FALSE;
    d.DepthStencilState.DepthWriteMask = D3D12_DEPTH_WRITE_MASK_ZERO;
    d.DepthStencilState.DepthFunc = D3D12_COMPARISON_FUNC_ALWAYS;
    d.SampleMask = UINT_MAX;
    d.NumRenderTargets = 1;
    d.RTVFormats[0] = DXGI_FORMAT_R8G8B8A8_UNORM;
    d.DSVFormat = DXGI_FORMAT_D32_FLOAT;
    d.SampleDesc.Count = 1;
    check(device_->CreateGraphicsPipelineState(&d, IID_PPV_ARGS(&uiPso_)), "Create UI overlay pipeline");
    log("info", "HTML/CSS UI layer ready (Direct2D + DirectWrite + WIC)");
}

// Copies the last Direct2D raster into the overlay texture (this frame's
// staging buffer is free: renderFrame waited for its fence).
void WebappWindow::uploadUi(UINT frame) {
    const std::uint8_t* px = ui_.pixels();
    const UINT w = ui_.width(), h = ui_.height();
    uiUpload_ = false;
    if (!px || !w || !h) return;
    D3D12_RESOURCE_BARRIER barrier{};
    barrier.Type = D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;
    barrier.Transition.Subresource = D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES;
    if (!uiTexture_ || uiTexW_ != w || uiTexH_ != h) {
        retire(uiTexture_);
        D3D12_RESOURCE_DESC td{};
        td.Dimension = D3D12_RESOURCE_DIMENSION_TEXTURE2D;
        td.Width = w;
        td.Height = h;
        td.DepthOrArraySize = 1;
        td.MipLevels = 1;
        td.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
        td.SampleDesc.Count = 1;
        auto heap = heapProps(D3D12_HEAP_TYPE_DEFAULT);
        check(device_->CreateCommittedResource(&heap, D3D12_HEAP_FLAG_NONE, &td, D3D12_RESOURCE_STATE_COPY_DEST, nullptr,
                                               IID_PPV_ARGS(&uiTexture_)), "UI texture");
        uiTexVersion_++;
        uiTexW_ = w;
        uiTexH_ = h;
    } else {
        barrier.Transition.pResource = uiTexture_.Get();
        barrier.Transition.StateBefore = D3D12_RESOURCE_STATE_PIXEL_SHADER_RESOURCE;
        barrier.Transition.StateAfter = D3D12_RESOURCE_STATE_COPY_DEST;
        cmd_->ResourceBarrier(1, &barrier);
    }
    const UINT pitch = (w * 4 + D3D12_TEXTURE_DATA_PITCH_ALIGNMENT - 1) & ~(D3D12_TEXTURE_DATA_PITCH_ALIGNMENT - 1);
    const UINT64 bytes = UINT64(pitch) * h;
    if (uiStagingBytes_[frame] < bytes || !uiStaging_[frame]) {
        retire(uiStaging_[frame]);
        uiStaging_[frame] = uploadBuffer(nullptr, bytes);
        uiStagingBytes_[frame] = bytes;
    }
    std::uint8_t* mapped = nullptr;
    D3D12_RANGE none{0, 0};
    check(uiStaging_[frame]->Map(0, &none, reinterpret_cast<void**>(&mapped)), "Map UI staging buffer");
    const UINT srcStride = ui_.stride();
    for (UINT y = 0; y < h; y++) std::memcpy(mapped + std::size_t(y) * pitch, px + std::size_t(y) * srcStride, std::size_t(w) * 4);
    uiStaging_[frame]->Unmap(0, nullptr);
    D3D12_TEXTURE_COPY_LOCATION dst{}, src{};
    dst.pResource = uiTexture_.Get();
    dst.Type = D3D12_TEXTURE_COPY_TYPE_SUBRESOURCE_INDEX;
    dst.SubresourceIndex = 0;
    src.pResource = uiStaging_[frame].Get();
    src.Type = D3D12_TEXTURE_COPY_TYPE_PLACED_FOOTPRINT;
    src.PlacedFootprint.Offset = 0;
    src.PlacedFootprint.Footprint.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    src.PlacedFootprint.Footprint.Width = w;
    src.PlacedFootprint.Footprint.Height = h;
    src.PlacedFootprint.Footprint.Depth = 1;
    src.PlacedFootprint.Footprint.RowPitch = pitch;
    cmd_->CopyTextureRegion(&dst, 0, 0, 0, &src, nullptr);
    barrier.Transition.pResource = uiTexture_.Get();
    barrier.Transition.StateBefore = D3D12_RESOURCE_STATE_COPY_DEST;
    barrier.Transition.StateAfter = D3D12_RESOURCE_STATE_PIXEL_SHADER_RESOURCE;
    cmd_->ResourceBarrier(1, &barrier);
}

void WebappWindow::drawUi(UINT frame) {
    if (!uiTexture_ || !uiPso_) return;
    D3D12_CPU_DESCRIPTOR_HANDLE cpu = uiSrvHeap_->GetCPUDescriptorHandleForHeapStart();
    D3D12_GPU_DESCRIPTOR_HANDLE gpu = uiSrvHeap_->GetGPUDescriptorHandleForHeapStart();
    cpu.ptr += SIZE_T(frame) * uiSrvStep_;
    gpu.ptr += UINT64(frame) * uiSrvStep_;
    if (uiSrvVersion_[frame] != uiTexVersion_) {
        D3D12_SHADER_RESOURCE_VIEW_DESC srv{};
        srv.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
        srv.ViewDimension = D3D12_SRV_DIMENSION_TEXTURE2D;
        srv.Shader4ComponentMapping = D3D12_DEFAULT_SHADER_4_COMPONENT_MAPPING;
        srv.Texture2D.MipLevels = 1;
        device_->CreateShaderResourceView(uiTexture_.Get(), &srv, cpu);
        uiSrvVersion_[frame] = uiTexVersion_;
    }
    cmd_->SetGraphicsRootSignature(uiRootSig_.Get());
    ID3D12DescriptorHeap* heaps[] = {uiSrvHeap_.Get()};
    cmd_->SetDescriptorHeaps(1, heaps);
    cmd_->SetGraphicsRootDescriptorTable(0, gpu);
    cmd_->SetPipelineState(uiPso_.Get());
    cmd_->IASetPrimitiveTopology(D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
    cmd_->DrawInstanced(3, 1, 0, 0);
}

void WebappWindow::createSizeDependent() {
    for (UINT i = 0; i < kFrameCount; i++) {
        check(swap_->GetBuffer(i, IID_PPV_ARGS(&targets_[i])), "Get back buffer");
        D3D12_CPU_DESCRIPTOR_HANDLE rtv = rtvHeap_->GetCPUDescriptorHandleForHeapStart();
        rtv.ptr += SIZE_T(i) * rtvStep_;
        device_->CreateRenderTargetView(targets_[i].Get(), nullptr, rtv);
    }
    D3D12_RESOURCE_DESC d{};
    d.Dimension = D3D12_RESOURCE_DIMENSION_TEXTURE2D;
    d.Width = width_;
    d.Height = height_;
    d.DepthOrArraySize = 1;
    d.MipLevels = 1;
    d.Format = DXGI_FORMAT_D32_FLOAT;
    d.SampleDesc.Count = 1;
    d.Flags = D3D12_RESOURCE_FLAG_ALLOW_DEPTH_STENCIL;
    D3D12_CLEAR_VALUE clear{};
    clear.Format = DXGI_FORMAT_D32_FLOAT;
    clear.DepthStencil.Depth = 1.0f;
    auto heap = heapProps(D3D12_HEAP_TYPE_DEFAULT);
    check(device_->CreateCommittedResource(&heap, D3D12_HEAP_FLAG_NONE, &d, D3D12_RESOURCE_STATE_DEPTH_WRITE,
                                           &clear, IID_PPV_ARGS(&depth_)), "Depth buffer");
    device_->CreateDepthStencilView(depth_.Get(), nullptr, dsvHeap_->GetCPUDescriptorHandleForHeapStart());
}

void WebappWindow::releaseSizeDependent() {
    for (auto& t : targets_) t.Reset();
    depth_.Reset();
}

void WebappWindow::waitForGpu() {
    if (!queue_ || !fence_) return;
    const UINT64 value = ++fenceValue_;
    check(queue_->Signal(fence_.Get(), value), "Signal GPU fence");
    waitForFenceValue(value, "waitForGpu/resize");
    collectRetired();
}

void WebappWindow::resize(UINT width, UINT height) {
    width = std::max<UINT>(1, width);
    height = std::max<UINT>(1, height);
    if (width == width_ && height == height_) return;
    width_ = width;
    height_ = height;
    if (swap_) {
        waitForGpu();
        releaseSizeDependent();
        check(swap_->ResizeBuffers(kFrameCount, width_, height_, DXGI_FORMAT_R8G8B8A8_UNORM, 0), "Resize swap chain");
        createSizeDependent();
    }
    host_.resize((int)width_, (int)height_, 1.0);
}

ComPtr<ID3D12Resource> WebappWindow::uploadBuffer(const void* data, UINT64 bytes) {
    if (!native_three::safety::validBufferBytes(bytes))
        check(E_INVALIDARG, "DX12 upload buffer size limit");
    ComPtr<ID3D12Resource> buffer;
    auto heap = heapProps(D3D12_HEAP_TYPE_UPLOAD);
    auto desc = bufferDesc(bytes);
    check(device_->CreateCommittedResource(&heap, D3D12_HEAP_FLAG_NONE, &desc, D3D12_RESOURCE_STATE_GENERIC_READ,
                                           nullptr, IID_PPV_ARGS(&buffer)), "Upload buffer");
    if (data && bytes) {
        void* mapped = nullptr;
        D3D12_RANGE none{0, 0};
        check(buffer->Map(0, &none, &mapped), "Map upload buffer");
        std::memcpy(mapped, data, (size_t)bytes);
        buffer->Unmap(0, nullptr);
    }
    return buffer;
}

void WebappWindow::retire(ComPtr<ID3D12Resource>& resource) {
    if (resource) retired_.push_back({resource, fenceValue_ + kFrameCount});
    resource.Reset();
}

void WebappWindow::releaseInstances(std::uint32_t id) {
    auto it = instances_.find(id);
    if (it == instances_.end()) return;
    for (auto& buffer : it->second.gpu) retire(buffer);
    instances_.erase(it);
}
void WebappWindow::collectRetired() {
    const UINT64 done = fence_ ? fence_->GetCompletedValue() : ~0ull;
    retired_.erase(std::remove_if(retired_.begin(), retired_.end(),
                                  [done](const Retired& r) { return r.fence <= done; }),
                   retired_.end());
    for (auto it = retiredSlots_.begin(); it != retiredSlots_.end();) {
        if (it->fence <= done) { freeSlots_.push_back(it->slot); it = retiredSlots_.erase(it); }
        else ++it;
    }
}

void WebappWindow::uploadGeometry(std::uint32_t id, const float* p, const float* n, const float* c,
                                  std::uint32_t vertexCount, const std::uint32_t* idx, std::uint32_t indexCount, const float* uv,
                                  std::uint32_t colorChannels) {
    if (!native_three::safety::validGeometry(p, vertexCount, idx, indexCount)) {
        if (invalidDrawWarnings_++ < 8) log("warn", "[dx12-safety] rejected oversized or invalid geometry");
        return;
    }
    if (idx) {
        for (std::uint32_t i = 0; i < indexCount; ++i) {
            if (idx[i] >= vertexCount) {
                if (invalidDrawWarnings_++ < 8) log("warn", "[dx12-safety] rejected out-of-range geometry index");
                return;
            }
        }
    }
    const std::uint32_t cc = colorChannels == 4 ? 4 : 3;
    std::vector<float> interleaved(size_t(vertexCount) * kVertexFloats);
    for (std::uint32_t v = 0; v < vertexCount; v++) {
        float* o = &interleaved[size_t(v) * kVertexFloats];
        o[0] = p[v * 3]; o[1] = p[v * 3 + 1]; o[2] = p[v * 3 + 2];
        o[3] = n ? n[v * 3] : 0; o[4] = n ? n[v * 3 + 1] : 1; o[5] = n ? n[v * 3 + 2] : 0;
        o[6] = c ? c[v * cc] : 1; o[7] = c ? c[v * cc + 1] : 1; o[8] = c ? c[v * cc + 2] : 1;
        o[9] = c && cc == 4 ? c[v * 4 + 3] : 1;
        o[10] = uv ? uv[v * 2] : 0; o[11] = uv ? uv[v * 2 + 1] : 0;
    }
    Geometry& g = geometries_[id];
    retire(g.vertices);
    retire(g.indices);
    g.vertexCount = vertexCount;
    g.indexCount = idx ? indexCount : 0;
    g.vertices = uploadBuffer(interleaved.data(), interleaved.size() * sizeof(float));
    g.vbv.BufferLocation = g.vertices->GetGPUVirtualAddress();
    g.vbv.SizeInBytes = UINT(interleaved.size() * sizeof(float));
    g.vbv.StrideInBytes = kVertexStride;
    if (idx && indexCount) {
        g.indices = uploadBuffer(idx, UINT64(indexCount) * sizeof(std::uint32_t));
        g.ibv.BufferLocation = g.indices->GetGPUVirtualAddress();
        g.ibv.SizeInBytes = indexCount * sizeof(std::uint32_t);
        g.ibv.Format = DXGI_FORMAT_R32_UINT;
    }
}

void WebappWindow::releaseGeometry(std::uint32_t id) {
    auto it = geometries_.find(id);
    if (it == geometries_.end()) return;
    retire(it->second.vertices);
    retire(it->second.indices);
    geometries_.erase(it);
}

void WebappWindow::uploadInstances(std::uint32_t id, const float* m, const float* c, std::uint32_t count) {
    if (!native_three::safety::validInstances(m, count)) {
        if (invalidDrawWarnings_++ < 8) log("warn", "[dx12-safety] rejected excessive instance upload");
        return;
    }
    InstanceSet& set = instances_[id];
    set.count = count;
    set.cpu.resize(size_t(count) * 19);
    for (std::uint32_t i = 0; i < count; i++) {
        float* o = &set.cpu[size_t(i) * 19];
        std::memcpy(o, m + size_t(i) * 16, 16 * sizeof(float));
        o[16] = c ? c[i * 3] : 1;
        o[17] = c ? c[i * 3 + 1] : 1;
        o[18] = c ? c[i * 3 + 2] : 1;
    }
    set.version++;
}

bool WebappWindow::registerColorPatch(std::uint32_t id, const std::string& source) {
    if (!id || id > 16 || source.size() > 16000 || colorPatches_.count(id)) return false;
    if (source.find_first_of("#[]\\\"'") != std::string::npos) return false;
    static const std::regex control(R"(\b(for|while|do|goto|register|cbuffer|discard|clip)\b)");
    if (std::regex_search(source, control)) return false;
    std::string shader = std::string("#define NT_COLOR_PATCH 1\n") + kWebappShader;
    const std::string marker = "// NT_COLOR_PATCH_FUNCTION";
    shader.replace(shader.find(marker), marker.size(), source);
    ComPtr<ID3DBlob> code, errors;
    const auto hr = D3DCompile(shader.data(), shader.size(), "webapp_color_patch", nullptr, nullptr,
                               "PSMain", "ps_5_0", D3DCOMPILE_ENABLE_STRICTNESS | D3DCOMPILE_OPTIMIZATION_LEVEL3, 0,
                               &code, &errors);
    if (FAILED(hr)) {
        log("warn", "[material-color] shader patch skipped: " + std::string(errors ? static_cast<const char*>(errors->GetBufferPointer()) : "compilation failed"));
        return false;
    }
    colorPatches_.emplace(id, std::move(code));
    log("info", "[material-color] compiled GLSL color stage " + std::to_string(id));
    return true;
}

ID3D12PipelineState* WebappWindow::pipeline(UINT flags, UINT patchId) {
    const auto patch = colorPatches_.find(patchId);
    if (patch == colorPatches_.end()) patchId = 0;
    const bool lines = (flags & (F_LINES | F_LINE_STRIP)) != 0;
    const UINT cull = (flags & F_DOUBLE) || lines ? 1 : (flags & F_BACK) ? 2 : 0;
    const UINT key = (patchId << 6) | (lines ? 1u : 0u) | (cull << 1) | ((flags & F_TRANSPARENT) ? 8u : 0u) |
                     ((flags & F_NO_DEPTH_WRITE) ? 16u : 0u) | ((flags & F_NO_DEPTH_TEST) ? 32u : 0u) |
                     ((flags & F_DEPTH_ONLY) ? (1u << 30) : 0u) |
                     ((flags & F_ADDITIVE_BLEND) ? (1u << 29) : 0u) |
                     ((flags & F_POLYGON_OFFSET) ? (1u << 28) : 0u) |
                     ((flags & F_FRONT_CW) ? (1u << 27) : 0u);
    auto found = pipelines_.find(key);
    if (found != pipelines_.end()) return found->second.Get();

    const D3D12_INPUT_ELEMENT_DESC layout[] = {
        {"POSITION", 0, DXGI_FORMAT_R32G32B32_FLOAT, 0, 0, D3D12_INPUT_CLASSIFICATION_PER_VERTEX_DATA, 0},
        {"NORMAL", 0, DXGI_FORMAT_R32G32B32_FLOAT, 0, 12, D3D12_INPUT_CLASSIFICATION_PER_VERTEX_DATA, 0},
        {"COLOR", 0, DXGI_FORMAT_R32G32B32A32_FLOAT, 0, 24, D3D12_INPUT_CLASSIFICATION_PER_VERTEX_DATA, 0},
        {"TEXCOORD", 0, DXGI_FORMAT_R32G32_FLOAT, 0, 40, D3D12_INPUT_CLASSIFICATION_PER_VERTEX_DATA, 0},
        {"IROW", 0, DXGI_FORMAT_R32G32B32A32_FLOAT, 1, 0, D3D12_INPUT_CLASSIFICATION_PER_INSTANCE_DATA, 1},
        {"IROW", 1, DXGI_FORMAT_R32G32B32A32_FLOAT, 1, 16, D3D12_INPUT_CLASSIFICATION_PER_INSTANCE_DATA, 1},
        {"IROW", 2, DXGI_FORMAT_R32G32B32A32_FLOAT, 1, 32, D3D12_INPUT_CLASSIFICATION_PER_INSTANCE_DATA, 1},
        {"IROW", 3, DXGI_FORMAT_R32G32B32A32_FLOAT, 1, 48, D3D12_INPUT_CLASSIFICATION_PER_INSTANCE_DATA, 1},
        {"ICOLOR", 0, DXGI_FORMAT_R32G32B32_FLOAT, 1, 64, D3D12_INPUT_CLASSIFICATION_PER_INSTANCE_DATA, 1},
    };
    D3D12_GRAPHICS_PIPELINE_STATE_DESC d{};
    d.pRootSignature = root_sig_.Get();
    d.VS = {vs_->GetBufferPointer(), vs_->GetBufferSize()};
    ID3DBlob* pixel = patchId ? patch->second.Get() : ps_.Get();
    d.PS = (flags & F_DEPTH_ONLY) ? D3D12_SHADER_BYTECODE{} :
           D3D12_SHADER_BYTECODE{pixel->GetBufferPointer(), pixel->GetBufferSize()};
    d.InputLayout = {layout, UINT(sizeof layout / sizeof layout[0])};
    d.PrimitiveTopologyType = lines ? D3D12_PRIMITIVE_TOPOLOGY_TYPE_LINE : D3D12_PRIMITIVE_TOPOLOGY_TYPE_TRIANGLE;
    d.RasterizerState.FillMode = D3D12_FILL_MODE_SOLID;
    d.RasterizerState.CullMode = cull == 1 ? D3D12_CULL_MODE_NONE : cull == 2 ? D3D12_CULL_MODE_FRONT : D3D12_CULL_MODE_BACK;
    d.RasterizerState.FrontCounterClockwise = (flags & F_FRONT_CW) ? FALSE : TRUE;
    d.RasterizerState.DepthClipEnable = TRUE;
    if (flags & F_POLYGON_OFFSET) {
        // K73 shadow pass calls gl.polygonOffset(1.6, 3.0).
        d.RasterizerState.DepthBias = 3;
        d.RasterizerState.SlopeScaledDepthBias = 1.6f;
    }
    auto& rt = d.BlendState.RenderTarget[0];
    rt.RenderTargetWriteMask = D3D12_COLOR_WRITE_ENABLE_ALL;
    if (flags & F_TRANSPARENT) {
        rt.BlendEnable = TRUE;
        rt.SrcBlend = (flags & F_ADDITIVE_BLEND) ? D3D12_BLEND_ONE : D3D12_BLEND_SRC_ALPHA;
        rt.DestBlend = (flags & F_ADDITIVE_BLEND) ? D3D12_BLEND_ONE : D3D12_BLEND_INV_SRC_ALPHA;
        rt.BlendOp = D3D12_BLEND_OP_ADD;
        rt.SrcBlendAlpha = D3D12_BLEND_ONE;
        rt.DestBlendAlpha = (flags & F_ADDITIVE_BLEND) ? D3D12_BLEND_ONE : D3D12_BLEND_INV_SRC_ALPHA;
        rt.BlendOpAlpha = D3D12_BLEND_OP_ADD;
    } else {
        rt.SrcBlend = D3D12_BLEND_ONE;
        rt.DestBlend = D3D12_BLEND_ZERO;
        rt.BlendOp = D3D12_BLEND_OP_ADD;
        rt.SrcBlendAlpha = D3D12_BLEND_ONE;
        rt.DestBlendAlpha = D3D12_BLEND_ZERO;
        rt.BlendOpAlpha = D3D12_BLEND_OP_ADD;
    }
    rt.LogicOp = D3D12_LOGIC_OP_NOOP;
    d.DepthStencilState.DepthEnable = (flags & F_DEPTH_ONLY) ? TRUE : ((flags & F_NO_DEPTH_TEST) ? FALSE : TRUE);
    d.DepthStencilState.DepthWriteMask = (flags & F_DEPTH_ONLY) ? D3D12_DEPTH_WRITE_MASK_ALL :
        ((flags & F_NO_DEPTH_WRITE) ? D3D12_DEPTH_WRITE_MASK_ZERO : D3D12_DEPTH_WRITE_MASK_ALL);
    d.DepthStencilState.DepthFunc = D3D12_COMPARISON_FUNC_LESS_EQUAL;
    d.SampleMask = UINT_MAX;
    d.NumRenderTargets = (flags & F_DEPTH_ONLY) ? 0 : 1;
    d.RTVFormats[0] = (flags & F_DEPTH_ONLY) ? DXGI_FORMAT_UNKNOWN : DXGI_FORMAT_R8G8B8A8_UNORM;
    d.DSVFormat = DXGI_FORMAT_D32_FLOAT;
    d.SampleDesc.Count = 1;
    ComPtr<ID3D12PipelineState> pso;
    const auto hr = device_->CreateGraphicsPipelineState(&d, IID_PPV_ARGS(&pso));
    if (FAILED(hr) && patchId) {
        log("warn", "[material-color] pipeline could not use shader patch " + std::to_string(patchId));
        pipelines_[key] = pipeline(flags, 0);
        return pipelines_[key].Get();
    }
    check(hr, "Create webapp pipeline");
    ID3D12PipelineState* raw = pso.Get();
    pipelines_[key] = pso;
    return raw;
}

void WebappWindow::renderFrame() {
    const UINT frame = swap_->GetCurrentBackBufferIndex();
    if (fence_->GetCompletedValue() < frameFence_[frame]) {
        const auto waitStart = std::chrono::steady_clock::now();
        waitForFenceValue(frameFence_[frame], "renderFrame/backbuffer reuse");
        fenceWaitMs_ += std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - waitStart).count();
    }
    collectRetired();

    // Size the per-frame constant ring for this frame's passes and draws.
    UINT64 needed = 0;
    for (const auto& pass : passes_)
        needed += kFrameCBBytes + UINT64(pass[43]) * kDrawCBBytes;
    if (ringBytes_[frame] < needed || !ring_[frame]) {
        retire(ring_[frame]);
        ringBytes_[frame] = std::max<UINT64>(needed * 3 / 2, 1u << 20);
        ring_[frame] = uploadBuffer(nullptr, ringBytes_[frame]);
    }
    std::uint8_t* ring = nullptr;
    D3D12_RANGE none{0, 0};
    check(ring_[frame]->Map(0, &none, reinterpret_cast<void**>(&ring)), "Map constant ring");
    const D3D12_GPU_VIRTUAL_ADDRESS ringGpu = ring_[frame]->GetGPUVirtualAddress();
    UINT64 ringOffset = 0;

    check(allocators_[frame]->Reset(), "Reset allocator");
    check(cmd_->Reset(allocators_[frame].Get(), nullptr), "Reset command list");
    recordTextureCopies();
    D3D12_RESOURCE_BARRIER barrier{};
    barrier.Type = D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;
    barrier.Transition.pResource = targets_[frame].Get();
    barrier.Transition.StateBefore = D3D12_RESOURCE_STATE_PRESENT;
    barrier.Transition.StateAfter = D3D12_RESOURCE_STATE_RENDER_TARGET;
    barrier.Transition.Subresource = D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES;
    cmd_->ResourceBarrier(1, &barrier);
    D3D12_CPU_DESCRIPTOR_HANDLE rtv = rtvHeap_->GetCPUDescriptorHandleForHeapStart();
    rtv.ptr += SIZE_T(frame) * rtvStep_;
    const D3D12_CPU_DESCRIPTOR_HANDLE dsv = dsvHeap_->GetCPUDescriptorHandleForHeapStart();
    cmd_->OMSetRenderTargets(1, &rtv, FALSE, &dsv);
    // A browser canvas starts every frame cleared (preserveDrawingBuffer=false).
    const float black[4] = {0, 0, 0, 1};
    cmd_->ClearRenderTargetView(rtv, black, 0, nullptr);
    cmd_->ClearDepthStencilView(dsv, D3D12_CLEAR_FLAG_DEPTH, 1.0f, 0, 0, nullptr);
    D3D12_VIEWPORT viewport{0, 0, float(width_), float(height_), 0, 1};
    D3D12_RECT scissor{0, 0, LONG(width_), LONG(height_)};
    cmd_->RSSetViewports(1, &viewport);
    cmd_->RSSetScissorRects(1, &scissor);
    cmd_->SetGraphicsRootSignature(root_sig_.Get());
    ID3D12DescriptorHeap* texHeaps[] = {texHeap_.Get()};
    cmd_->SetDescriptorHeaps(1, texHeaps);
    const D3D12_GPU_DESCRIPTOR_HANDLE whiteTexture = textureHandle(0);
    UINT64 boundTexture = ~0ull;

    UINT drawsThisFrame = 0;
    UINT64 vertexWorkThisFrame = 0;
    for (const auto& pass : passes_) {
        const float* p = pass.data();
        const UINT lightCount = UINT(p[35]);
        const UINT drawCount = UINT(p[43]);
        const UINT flags = UINT(p[44]);
        const std::uint32_t offscreenId = std::uint32_t(p[55]);
        const bool offscreen = offscreenId != 0;
        D3D12_CPU_DESCRIPTOR_HANDLE passDsv = dsv;
        if (offscreen) {
            auto target = depthTargets_.find(offscreenId);
            if (target == depthTargets_.end() || !target->second.resource) {
                log("warn", "[depth] draw skipped: missing offscreen depth target");
                continue;
            }
            passDsv = depthViewHandle(target->second.slot);
            cmd_->OMSetRenderTargets(0, nullptr, FALSE, &passDsv);
            D3D12_VIEWPORT pv{0, 0, float(target->second.width), float(target->second.height), 0, 1};
            D3D12_RECT pr{0, 0, LONG(target->second.width), LONG(target->second.height)};
            cmd_->RSSetViewports(1, &pv);
            cmd_->RSSetScissorRects(1, &pr);
        } else {
            cmd_->OMSetRenderTargets(1, &rtv, FALSE, &dsv);
            cmd_->RSSetViewports(1, &viewport);
            cmd_->RSSetScissorRects(1, &scissor);
        }
        if ((flags & P_CLEAR_COLOR) && !offscreen) {
            const float clear[4] = {p[36], p[37], p[38], p[39]};
            cmd_->ClearRenderTargetView(rtv, clear, 0, nullptr);
        }
        if (flags & P_CLEAR_DEPTH) cmd_->ClearDepthStencilView(passDsv, D3D12_CLEAR_FLAG_DEPTH, 1.0f, 0, 0, nullptr);

        // cbuffer Frame: view, projection, camera+lightCount, ambient+exposure, lights.
        float* fcb = reinterpret_cast<float*>(ring + ringOffset);
        std::memset(fcb, 0, kFrameCBBytes);
        std::memcpy(fcb, p, 32 * sizeof(float));
        fcb[32] = p[32]; fcb[33] = p[33]; fcb[34] = p[34]; fcb[35] = float(lightCount);
        fcb[36] = p[40]; fcb[37] = p[41]; fcb[38] = p[42]; fcb[39] = p[47] > 0 ? p[47] : 1.0f;
        std::memcpy(fcb + 40, p + native_three::kWebappPassHeaderFloats,
                    lightCount * native_three::kWebappLightFloats * sizeof(float));
        fcb[296] = p[48]; fcb[297] = p[47] > 0 ? p[47] : 1.0f; // tone mapping curve, exposure
        std::memcpy(fcb + 300, p + 49, 3 * sizeof(float)); // fog RGB in framebuffer space
        std::memcpy(fcb + 304, p + 52, 3 * sizeof(float)); // mode, near or density, far
        cmd_->SetGraphicsRootConstantBufferView(0, ringGpu + ringOffset);
        ringOffset += kFrameCBBytes;

        const float* d = p + native_three::kWebappPassHeaderFloats + lightCount * native_three::kWebappLightFloats;
        ID3D12PipelineState* current = nullptr;
        D3D_PRIMITIVE_TOPOLOGY topology = D3D_PRIMITIVE_TOPOLOGY_UNDEFINED;
        for (UINT i = 0; i < drawCount; i++, d += native_three::kWebappDrawFloats) {
            if (!native_three::safety::wholeNumber(d[0], 16'777'216) ||
                !native_three::safety::wholeNumber(d[1], 16'777'216) ||
                !native_three::safety::wholeNumber(d[2], native_three::safety::kMaxInstances) ||
                !native_three::safety::wholeNumber(d[4], native_three::safety::kMaxGeometryIndices) ||
                !native_three::safety::wholeNumber(d[5], native_three::safety::kMaxGeometryIndices) ||
                !native_three::safety::wholeNumber(d[32], 16'777'216) ||
                !native_three::safety::wholeNumber(d[48], 16)) {
                if (invalidDrawWarnings_++ < 8) log("warn", "[dx12-safety] rejected malformed draw parameters");
                continue;
            }
            auto g = geometries_.find(std::uint32_t(d[0]));
            if (g == geometries_.end() || !g->second.vertices) continue;
            const UINT drawFlags = UINT(d[3]) | (offscreen ? F_DEPTH_ONLY : 0u);
            const UINT start = UINT(d[4]);
            const UINT count = UINT(d[5]);
            UINT instanceCount = std::max<UINT>(1, UINT(d[2]));
            const UINT available = g->second.indexCount ? g->second.indexCount : g->second.vertexCount;
            if (!native_three::safety::validDraw(start, count, available, instanceCount)) {
                if (invalidDrawWarnings_++ < 8) log("warn", "[dx12-safety] skipped draw beyond vertex/index buffer");
                continue;
            }
            D3D12_VERTEX_BUFFER_VIEW views[2] = {g->second.vbv, identityView_};
            if (d[1] > 0) {
                auto it = instances_.find(std::uint32_t(d[1]));
                if (it == instances_.end() || it->second.count == 0) continue;
                InstanceSet& set = it->second;
                instanceCount = std::min(instanceCount, set.count);
                if (set.uploaded[frame] != set.version || !set.gpu[frame]) {
                    if (set.capacity[frame] < set.count || !set.gpu[frame]) {
                        retire(set.gpu[frame]);
                        set.capacity[frame] = set.count;
                        set.gpu[frame] = uploadBuffer(nullptr, UINT64(set.count) * kInstanceStride);
                    }
                    void* mapped = nullptr;
                    check(set.gpu[frame]->Map(0, &none, &mapped), "Map instances");
                    std::memcpy(mapped, set.cpu.data(), set.cpu.size() * sizeof(float));
                    set.gpu[frame]->Unmap(0, nullptr);
                    set.uploaded[frame] = set.version;
                }
                views[1].BufferLocation = set.gpu[frame]->GetGPUVirtualAddress();
                views[1].SizeInBytes = set.count * kInstanceStride;
                views[1].StrideInBytes = kInstanceStride;
            }
            if (!native_three::safety::chargeDrawWork(vertexWorkThisFrame, count, instanceCount)) {
                if (invalidDrawWarnings_++ < 8)
                    log("warn", "[dx12-safety] skipped excessive per-frame vertex/instance workload");
                continue;
            }
            ID3D12PipelineState* pso = pipeline(drawFlags, UINT(d[48]));
            if (pso != current) { cmd_->SetPipelineState(pso); current = pso; }
            const D3D_PRIMITIVE_TOPOLOGY wanted = (drawFlags & F_LINE_STRIP) ? D3D_PRIMITIVE_TOPOLOGY_LINESTRIP
                                                  : (drawFlags & F_LINES)    ? D3D_PRIMITIVE_TOPOLOGY_LINELIST
                                                                             : D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST;
            if (wanted != topology) { cmd_->IASetPrimitiveTopology(wanted); topology = wanted; }

            // cbuffer Draw: model, colour+opacity, emissive+shininess, params.
            float* dcb = reinterpret_cast<float*>(ring + ringOffset);
            std::memcpy(dcb, d + 16, 16 * sizeof(float));
            dcb[16] = d[8]; dcb[17] = d[9]; dcb[18] = d[10]; dcb[19] = d[11];
            dcb[20] = d[12]; dcb[21] = d[13]; dcb[22] = d[14]; dcb[23] = d[15];
            dcb[24] = d[6]; dcb[25] = d[7]; dcb[26] = float(drawFlags); dcb[27] = 0;
            // uv transform rows (a c e | b d f) and alphaTest
            dcb[28] = d[34]; dcb[29] = d[36]; dcb[30] = d[38]; dcb[31] = d[33];
            dcb[32] = d[35]; dcb[33] = d[37]; dcb[34] = d[39]; dcb[35] = 0;
            std::memcpy(dcb + 44, d + 49, 4 * sizeof(float)); // translated color stage uniforms
            std::memcpy(dcb + 36, d + 40, 8 * sizeof(float)); // sky reflection and view-angle parameters
            cmd_->SetGraphicsRootConstantBufferView(1, ringGpu + ringOffset);
            ringOffset += kDrawCBBytes;
            const D3D12_GPU_DESCRIPTOR_HANDLE tex = (drawFlags & F_MAP) ? textureHandle(std::uint32_t(d[32])) : whiteTexture;
            if (tex.ptr != boundTexture) { cmd_->SetGraphicsRootDescriptorTable(2, tex); boundTexture = tex.ptr; }

            cmd_->IASetVertexBuffers(0, 2, views);
            if (g->second.indexCount) {
                const UINT n = std::min(count, g->second.indexCount > start ? g->second.indexCount - start : 0u);
                if (!n) continue;
                cmd_->IASetIndexBuffer(&g->second.ibv);
                cmd_->DrawIndexedInstanced(n, instanceCount, start, 0, 0);
            } else {
                const UINT n = std::min(count, g->second.vertexCount > start ? g->second.vertexCount - start : 0u);
                if (!n) continue;
                cmd_->DrawInstanced(n, instanceCount, start, 0);
            }
            drawsThisFrame++;
        }
    }
    ring_[frame]->Unmap(0, nullptr);
    lastDraws_ = drawsThisFrame;
    // A depth-only K73 shadow pass binds zero colour targets. Restore the
    // swap-chain RTV, viewport and scissor before composing HTML/CSS.
    // Otherwise drawUi() executes with no colour target bound and the
    // entire menu/HUD disappears as soon as shadow rendering succeeds.
    cmd_->OMSetRenderTargets(1, &rtv, FALSE, &dsv);
    cmd_->RSSetViewports(1, &viewport);
    cmd_->RSSetScissorRects(1, &scissor);
    if (uiReady_) {
        if (uiUpload_) uploadUi(frame);
        if (uiVisible_) drawUi(frame);
    }

    std::swap(barrier.Transition.StateBefore, barrier.Transition.StateAfter);
    cmd_->ResourceBarrier(1, &barrier);
    check(cmd_->Close(), "Close command list");
    ID3D12CommandList* lists[] = {cmd_.Get()};
    const UINT64 serial = ++submissionSerial_;
    if (flightLog_) {
        char state[280];
        std::snprintf(state, sizeof state,
            "[dx12-flight] before-submit #%llu: backbuffer=%u passes=%zu draws=%u vertexWork=%llu geometries=%zu instances=%zu textureUploadMiB=%zu",
            static_cast<unsigned long long>(serial), frame, passes_.size(), drawsThisFrame,
            static_cast<unsigned long long>(vertexWorkThisFrame),
            geometries_.size(), instances_.size(), textureBytes_ / (1024 * 1024));
        log("info", state);
    }
    queue_->ExecuteCommandLists(1, lists);
    const auto presentStart = std::chrono::steady_clock::now();
    const HRESULT present = swap_->Present(1, 0);
    presentMs_ = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - presentStart).count();
    check(present, "Present swap chain");
    frameFence_[frame] = ++fenceValue_;
    check(queue_->Signal(fence_.Get(), frameFence_[frame]), "Signal frame fence");
    const HRESULT removed = device_->GetDeviceRemovedReason();
    if (FAILED(removed)) check(removed, "GPU device lost after submission");
    if (flightLog_) {
        char state[160];
        std::snprintf(state, sizeof state,
                      "[dx12-flight] submitted #%llu: fence=%llu Present OK (GPU completion not implied)",
                      static_cast<unsigned long long>(serial),
                      static_cast<unsigned long long>(frameFence_[frame]));
        log("info", state);
    }
}

void WebappWindow::updateTitle(double fps) {
    wchar_t text[512];
    swprintf_s(text, L"%s \u2014 NativeThreeBridge webapp | %.0f FPS | %u draws | %s | %s%s",
               pageTitle_.c_str(), fps, lastDraws_, widen(native_three::webappEngineName()).c_str(), adapterName_.c_str(),
               logErrors_ ? L" | JS errors: see NativeThreeBridge-webapp-log.txt" : L"");
    SetWindowTextW(window_, text);
}

// Win32 virtual key -> DOM KeyboardEvent.key / .code
void WebappWindow::keyEvent(bool down, WPARAM vk, LPARAM lp) {
    const bool shift = GetKeyState(VK_SHIFT) < 0, ctrl = GetKeyState(VK_CONTROL) < 0,
               alt = GetKeyState(VK_MENU) < 0;
    const bool repeat = down && (lp & (1 << 30));
    const bool extended = (lp & (1 << 24)) != 0;
    std::string key, code;
    if (vk >= 'A' && vk <= 'Z') {
        code = std::string("Key") + char(vk);
        key = std::string(1, char(shift != (GetKeyState(VK_CAPITAL) & 1) ? vk : vk + 32));
    } else if (vk >= '0' && vk <= '9') {
        code = std::string("Digit") + char(vk);
        static const char* shifted = ")!@#$%^&*(";
        key = shift ? std::string(1, shifted[vk - '0']) : std::string(1, char(vk));
    } else if (vk >= VK_NUMPAD0 && vk <= VK_NUMPAD9) {
        code = "Numpad" + std::to_string(vk - VK_NUMPAD0);
        key = std::to_string(vk - VK_NUMPAD0);
    } else if (vk >= VK_F1 && vk <= VK_F24) {
        key = code = "F" + std::to_string(vk - VK_F1 + 1);
    } else {
        struct Named { WPARAM vk; const char* key; const char* code; };
        static const Named named[] = {
            {VK_SPACE, " ", "Space"}, {VK_RETURN, "Enter", "Enter"}, {VK_ESCAPE, "Escape", "Escape"},
            {VK_TAB, "Tab", "Tab"}, {VK_BACK, "Backspace", "Backspace"}, {VK_DELETE, "Delete", "Delete"},
            {VK_LEFT, "ArrowLeft", "ArrowLeft"}, {VK_RIGHT, "ArrowRight", "ArrowRight"},
            {VK_UP, "ArrowUp", "ArrowUp"}, {VK_DOWN, "ArrowDown", "ArrowDown"},
            {VK_HOME, "Home", "Home"}, {VK_END, "End", "End"}, {VK_PRIOR, "PageUp", "PageUp"},
            {VK_NEXT, "PageDown", "PageDown"}, {VK_INSERT, "Insert", "Insert"},
            {VK_CAPITAL, "CapsLock", "CapsLock"}, {VK_OEM_MINUS, "-", "Minus"}, {VK_OEM_PLUS, "=", "Equal"},
            {VK_OEM_COMMA, ",", "Comma"}, {VK_OEM_PERIOD, ".", "Period"}, {VK_OEM_2, "/", "Slash"},
            {VK_OEM_1, ";", "Semicolon"}, {VK_OEM_7, "'", "Quote"}, {VK_OEM_4, "[", "BracketLeft"},
            {VK_OEM_6, "]", "BracketRight"}, {VK_OEM_5, "\\", "Backslash"}, {VK_OEM_3, "`", "Backquote"},
            {VK_ADD, "+", "NumpadAdd"}, {VK_SUBTRACT, "-", "NumpadSubtract"},
            {VK_MULTIPLY, "*", "NumpadMultiply"}, {VK_DIVIDE, "/", "NumpadDivide"},
        };
        for (const Named& n : named)
            if (n.vk == vk) { key = n.key; code = n.code; break; }
        if (vk == VK_SHIFT) {
            key = "Shift";
            code = MapVirtualKeyW((lp >> 16) & 0xff, MAPVK_VSC_TO_VK_EX) == VK_RSHIFT ? "ShiftRight" : "ShiftLeft";
        } else if (vk == VK_CONTROL) { key = "Control"; code = extended ? "ControlRight" : "ControlLeft"; }
        else if (vk == VK_MENU) { key = "Alt"; code = extended ? "AltRight" : "AltLeft"; }
    }
    if (key.empty()) return;
    host_.key(down, key, code, repeat, alt, ctrl, shift, false);
}

LRESULT WebappWindow::handle(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    switch (msg) {
    case WM_SIZE:
        uiCadence_.force();
        minimized_ = wp == SIZE_MINIMIZED;
        if (!minimized_) resize(LOWORD(lp), HIWORD(lp));
        return 0;
    case WM_KEYDOWN: case WM_SYSKEYDOWN:
        uiCadence_.force();
        if (wp == VK_F4 && GetKeyState(VK_MENU) < 0) break; // Alt+F4 closes
        keyEvent(true, wp, lp);
        return 0;
    case WM_KEYUP: case WM_SYSKEYUP:
        uiCadence_.force();
        keyEvent(false, wp, lp);
        return 0;
    case WM_LBUTTONDOWN: case WM_RBUTTONDOWN: case WM_MBUTTONDOWN: {
        uiCadence_.force();
        SetCapture(hwnd);
        const auto start = std::chrono::steady_clock::now();
        host_.pointer("down", GET_X_LPARAM(lp), GET_Y_LPARAM(lp), msg == WM_LBUTTONDOWN ? 0 : msg == WM_MBUTTONDOWN ? 1 : 2);
        const double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - start).count();
        if (ms >= 35.0) log("warn", "[input-perf] pointer down dispatch " + std::to_string(ms) + " ms");
        return 0;
    }
    case WM_LBUTTONUP: case WM_RBUTTONUP: case WM_MBUTTONUP: {
        uiCadence_.force();
        const auto start = std::chrono::steady_clock::now();
        host_.pointer("up", GET_X_LPARAM(lp), GET_Y_LPARAM(lp), msg == WM_LBUTTONUP ? 0 : msg == WM_MBUTTONUP ? 1 : 2);
        const double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - start).count();
        if (ms >= 35.0) log("warn", "[input-perf] pointer up dispatch " + std::to_string(ms) + " ms");
        if (!(wp & (MK_LBUTTON | MK_RBUTTON | MK_MBUTTON))) ReleaseCapture();
        return 0;
    }
    case WM_MOUSEMOVE:
        host_.pointer("move", GET_X_LPARAM(lp), GET_Y_LPARAM(lp), 0);
        return 0;
    case WM_MOUSEWHEEL: case WM_MOUSEHWHEEL: {
        uiCadence_.force();
        POINT pt{GET_X_LPARAM(lp), GET_Y_LPARAM(lp)};
        ScreenToClient(hwnd, &pt);
        const double delta = -double(GET_WHEEL_DELTA_WPARAM(wp)) / WHEEL_DELTA * 100.0;
        if (msg == WM_MOUSEWHEEL) host_.wheel(pt.x, pt.y, 0, delta);
        else host_.wheel(pt.x, pt.y, -delta, 0);
        return 0;
    }
    case WM_CONTEXTMENU:
        return 0;
    case WM_SETCURSOR:
        if (LOWORD(lp) == HTCLIENT) { SetCursor(cursorHidden_ ? nullptr : cursor_); return TRUE; }
        break;
    case WM_SETFOCUS: uiCadence_.force(); host_.focus(true); return 0;
    case WM_KILLFOCUS: uiCadence_.force(); host_.focus(false); return 0;
    case WM_DESTROY:
        PostQuitMessage(0);
        return 0;
    }
    return DefWindowProcW(hwnd, msg, wp, lp);
}

void WebappWindow::writePerfRow(double atSeconds, double seconds) {
    Perf& p = perf_;
    if (perfCsv_ && p.frames > 0) {
        const double n = p.frames;
        std::fprintf(perfCsv_, "%.1f,%.1f,%.2f,%.2f,%.2f,%.2f,%.2f,%.2f,%d,%d,%d,%d,%.2f,%.2f,%.2f,%u,%.2f,%d\n",
                     atSeconds, n / seconds, p.frameMs / n, p.frameMax, p.jsMs / n, p.uiStyle / n, p.uiLayout / n, p.uiPaint / n,
                     p.full, p.partial, p.forced, p.rasters, p.rasterMs / n, p.renderMs / n, p.fenceMs / n, lastDraws_, p.presentMs / n, p.uiTicks);
        std::fflush(perfCsv_);
    }
    p = Perf{};
}

int WebappWindow::run(HINSTANCE instance) {
    wchar_t exePath[MAX_PATH] = {};
    GetModuleFileNameW(nullptr, exePath, MAX_PATH);
    const std::filesystem::path logPath = std::filesystem::path(exePath).parent_path() / L"NativeThreeBridge-webapp-log.txt";
    log_ = _wfsopen(logPath.c_str(), L"wb", _SH_DENYWR);
    gCrashLog = log_;
    const std::filesystem::path perfPath = std::filesystem::path(exePath).parent_path() / L"NativeThreeBridge-webapp-frames.csv";
    perfCsv_ = _wfsopen(perfPath.c_str(), L"wb", _SH_DENYWR);
    if (perfCsv_) {
        std::fputs("time_s,fps,frame_ms_avg,frame_ms_max,js_ms_avg,ui_style_ms_avg,ui_layout_ms_avg,ui_paint_ms_avg,"
                   "ui_full_layouts,ui_partial_layouts,ui_forced_layouts,ui_rasters,ui_raster_ms_avg,render_ms_avg,gpu_wait_ms_avg,draws,present_ms_avg,ui_ticks\n",
                   perfCsv_);
        std::fflush(perfCsv_);
    }
    ULONG guarantee = 128 * 1024; // room for the crash handler after a stack overflow
    SetThreadStackGuarantee(&guarantee);
    SetUnhandledExceptionFilter(webappCrashFilter);
    log("info", "Opening webapp: " + root_.u8string());

    std::string shim, error;
    std::vector<native_three::WebappBuiltin> builtins;
    if (!NativeWebapp_LoadBuiltins(shim, builtins, error)) {
        log("error", error);
        MessageBoxA(nullptr, error.c_str(), "NativeThreeBridge webapp", MB_OK | MB_ICONERROR);
        return 43;
    }
    if (!std::filesystem::exists(root_ / L"index.html")) {
        const std::string text = "No index.html in " + root_.u8string();
        log("error", text);
        MessageBoxA(nullptr, text.c_str(), "NativeThreeBridge webapp", MB_OK | MB_ICONWARNING);
        return 43;
    }

    WNDCLASSW wc{};
    wc.lpfnWndProc = webappWndProc;
    wc.hInstance = instance;
    wc.lpszClassName = L"NativeThreeWebappWindow";
    wc.hCursor = LoadCursor(nullptr, IDC_ARROW);
    wc.hIcon = LoadIcon(nullptr, IDI_APPLICATION);
    RegisterClassW(&wc);
    RECT rc{0, 0, LONG(width_), LONG(height_)};
    AdjustWindowRect(&rc, WS_OVERLAPPEDWINDOW, FALSE);
    gActive = this;
    window_ = CreateWindowW(wc.lpszClassName, L"NativeThreeBridge webapp", WS_OVERLAPPEDWINDOW,
                            CW_USEDEFAULT, CW_USEDEFAULT, rc.right - rc.left, rc.bottom - rc.top,
                            nullptr, nullptr, instance, nullptr);
    if (!window_) return 1;
    RECT client{};
    GetClientRect(window_, &client);
    width_ = std::max<LONG>(1, client.right);
    height_ = std::max<LONG>(1, client.bottom);
    initDevice();

    // Experimental UI/3D decoupling: 0 restores the exact legacy UI cadence.
    // The 3D frame, timers and game rAF remain unrestricted by this setting.
    double uiHz = 30.0;
    char uiHzText[32] = {};
    const DWORD uiHzChars = GetEnvironmentVariableA("NATIVE_THREE_UI_HZ", uiHzText, DWORD(sizeof(uiHzText)));
    if (uiHzChars > 0 && uiHzChars < sizeof(uiHzText)) {
        char* tail = nullptr;
        const double value = std::strtod(uiHzText, &tail);
        if (tail && tail != uiHzText && !*tail && std::isfinite(value) && value >= 0.0 && value <= 240.0)
            uiHz = value;
    }
    uiCadence_.setHz(uiHz);
    log("info", "[ui-cadence] " + std::to_string(uiHz) + " Hz (0 = legacy, input events force refresh)");

    gCrashPhase = "loading index.html and the game's JavaScript";
    log("info", "Starting JavaScript");
    if (!host_.start(root_, shim, builtins, this, int(width_), int(height_), error)) {
        log("error", error);
        MessageBoxA(window_, error.c_str(), "NativeThreeBridge webapp", MB_OK | MB_ICONERROR);
        return 45;
    }
    log("info", "index.html parsed, scripts started");
    ShowWindow(window_, SW_SHOW);
    SetForegroundWindow(window_);

    const auto start = std::chrono::steady_clock::now();
    auto pageStart = start;
    auto statStart = start;
    int statFrames = 0, frameNumber = 0;
    MSG msg{};
    auto reload = host_.takeReload();
    for (;;) {
        if (reload) {
            gCrashPhase = "reloading index.html and the game's JavaScript";
            log("info", "Reloading the webapp");
            resetPage();
            if (!host_.start(root_, shim, builtins, this, int(width_), int(height_), error, *reload)) {
                log("error", error);
                if (GetEnvironmentVariableA("CI", nullptr, 0) == 0)
                    MessageBoxA(window_, error.c_str(), "NativeThreeBridge webapp", MB_OK | MB_ICONERROR);
                PostQuitMessage(45);
            }
            reload.reset();
            pageStart = statStart = std::chrono::steady_clock::now();
            frameNumber = statFrames = 0;
        }
        while (PeekMessageW(&msg, nullptr, 0, 0, PM_REMOVE)) {
            if (msg.message == WM_QUIT) {
                waitForGpu();
                host_.shutdown();
                gActive = nullptr;
                if (log_) std::fclose(log_);
                if (perfCsv_) std::fclose(perfCsv_);
                return int(msg.wParam);
            }
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
            reload = host_.takeReload();
            if (reload) break;
        }
        if (!reload) reload = host_.takeReload();
        if (reload) continue;
        if (minimized_) { Sleep(16); continue; } // like a hidden browser tab: no rAF
        const auto now = std::chrono::steady_clock::now();
        const double ms = std::chrono::duration<double, std::milli>(now - pageStart).count();
        pendingPasses_.clear();
        pendingPassFloats_ = 0;
        gCrashPhase = "JavaScript frame " + std::to_string(frameNumber);
        const bool uiTick = uiCadence_.due(ms);
        host_.frame(ms, uiTick);
        reload = host_.takeReload();
        if (reload) continue;
        const auto tJs = std::chrono::steady_clock::now();
        gCrashPhase = "DX12 rendering of frame " + std::to_string(frameNumber);
        if (!pendingPasses_.empty()) passes_.swap(pendingPasses_); // otherwise keep the last image
        if (uiReady_ && uiTick) {
            perf_.uiTicks++;
            gCrashPhase = "HTML/CSS UI raster of frame " + std::to_string(frameNumber);
            if (ui_.render(width_, height_)) { uiUpload_ = true; perf_.rasters++; }
            uiVisible_ = !ui_.empty();
            gCrashPhase = "DX12 rendering of frame " + std::to_string(frameNumber);
        }
        const auto tRaster = std::chrono::steady_clock::now();
        renderFrame();
        const auto tEnd = std::chrono::steady_clock::now();
        {
            using msd = std::chrono::duration<double, std::milli>;
            const double frameMs = msd(tEnd - now).count();
            perf_.frames++;
            perf_.frameMs += frameMs;
            perf_.frameMax = std::max(perf_.frameMax, frameMs);
            perf_.jsMs += msd(tJs - now).count();
            perf_.rasterMs += msd(tRaster - tJs).count();
            perf_.renderMs += msd(tEnd - tRaster).count();
            perf_.fenceMs += fenceWaitMs_;
            perf_.presentMs += presentMs_;
            // Attribute visible stalls to JavaScript, UI rasterisation or DX12.
            // Throttle warnings so an already slow scene cannot flood the log.
            static auto lastSlowFrameLog = std::chrono::steady_clock::time_point{};
            if (frameMs >= 120.0 && tEnd - lastSlowFrameLog >= std::chrono::seconds(1)) {
                log("warn", "[frame-perf] total " + std::to_string(frameMs) +
                    " ms; JS " + std::to_string(msd(tJs - now).count()) +
                    " ms; UI " + std::to_string(msd(tRaster - tJs).count()) +
                    " ms; DX12 " + std::to_string(msd(tEnd - tRaster).count()) + " ms");
                lastSlowFrameLog = tEnd;
            }
            fenceWaitMs_ = 0;
            const double since = std::chrono::duration<double>(tEnd - perfAt_).count();
            if (since >= 1.0) {
                writePerfRow(std::chrono::duration<double>(tEnd - start).count(), since);
                perfAt_ = tEnd;
            }
        }
        frameNumber++;
        statFrames++;
        const double elapsed = std::chrono::duration<double>(now - statStart).count();
        if (elapsed >= 0.5) {
            updateTitle(statFrames / elapsed);
            statFrames = 0;
            statStart = now;
        }
        if (uiReady_ && std::chrono::duration<double>(now - uiStatsAt_).count() >= 5.0) {
            uiStatsAt_ = now;
            const std::string stats = ui_.stats();
            if (stats != uiLastStats_) { log("info", stats); uiLastStats_ = stats; }
        }
        if (frameNumber == 1 || frameNumber == 60 || frameNumber % 600 == 0) {
            char line[160];
            std::snprintf(line, sizeof line, "frame %d: %u draws, %zu geometries, %zu instance sets",
                          frameNumber, lastDraws_, geometries_.size(), instances_.size());
            log("info", line);
            if (uiReady_) log("info", ui_.stats());
        }
        if (frameNumber == 30 && !bootDialogShown_) {
            const std::string status = host_.statusJson();
            if (status.find("\"bootError\":null") == std::string::npos) {
                bootDialogShown_ = true;
                log("error", "Webapp failed to start: " + status);
                if (GetEnvironmentVariableA("CI", nullptr, 0) == 0)
                    MessageBoxW(window_, L"The webapp's JavaScript failed to start.\n"
                                         L"Details: NativeThreeBridge-webapp-log.txt beside the EXE.",
                                L"NativeThreeBridge webapp", MB_OK | MB_ICONWARNING);
            }
        }
    }
}

} // namespace

bool NativeWebapp_FindRoot(const wchar_t* commandLine, const std::filesystem::path& exeDir,
                           std::filesystem::path& root, std::filesystem::path* missing) {
    int argc = 0;
    LPWSTR* argv = CommandLineToArgvW(commandLine && *commandLine ? commandLine : L"", &argc);
    std::vector<std::wstring> args;
    // CommandLineToArgvW("") returns the EXE path; wWinMain's lpCmdLine excludes it.
    if (argv && commandLine && *commandLine)
        for (int i = 0; i < argc; i++) args.emplace_back(argv[i]);
    if (argv) LocalFree(argv);
    std::error_code ec;
    for (const std::wstring& a : args)
        if (a == L"--scene") return false; // classic scene.js game requested explicitly
    for (size_t i = 0; i < args.size(); i++) {
        std::filesystem::path candidate;
        if (args[i] == L"--webapp" && i + 1 < args.size()) candidate = args[++i];
        else if (args.size() == 1) candidate = args[i]; // folder or index.html dropped on the EXE
        else continue;
        if (candidate.filename() == L"index.html") candidate = candidate.parent_path();
        if (candidate.is_relative()) candidate = std::filesystem::current_path(ec) / candidate;
        if (std::filesystem::exists(candidate / L"index.html", ec)) {
            root = std::filesystem::weakly_canonical(candidate, ec);
            if (ec) root = candidate;
            return true;
        }
        if (missing && i > 0 && args[i - 1] == L"--webapp") *missing = candidate;
    }
    if (missing && !missing->empty()) return false;
    if (std::filesystem::exists(exeDir / L"game" / L"index.html", ec)) {
        root = exeDir / L"game";
        return true;
    }
    return false;
}

int NativeWebapp_Run(HINSTANCE instance, const std::filesystem::path& webappRoot) {
    auto window = std::make_unique<WebappWindow>(webappRoot);
    return window->run(instance);
}
