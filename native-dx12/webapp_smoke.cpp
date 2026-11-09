// Headless Windows CI test: runs a real webapp folder through the embedded
// QuickJS webapp runtime (same resources as the game EXE), drives input and
// 300 frames, validates every packet, and compiles the webapp HLSL.
// Usage: WebappSmoke.exe <webapp folder> <min draws> [expect-boot-error|expect-resize]
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <d3dcompiler.h>
#include <wrl/client.h>
#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <string>
#include <unordered_map>
#include <vector>
#include "webapp_host.h"
#include "webapp_resources.h"
#include "webapp_shader.h"
#include "webapp_ui.h"

using native_three::WebappHost;

namespace {
int failures = 0;
void expect(bool ok, const char* what) {
    std::printf("%s: %s\n", ok ? "PASS" : "FAIL", what);
    if (!ok) failures++;
}

struct RecordingSink final : native_three::WebappRenderSink {
    std::unordered_map<std::uint32_t, std::uint32_t> geometryVertices;
    std::unordered_map<std::uint32_t, std::uint32_t> instanceCounts;
    std::vector<std::vector<float>> framePasses, lastPasses;
    int uploads = 0, passes = 0, badDraws = 0, errors = 0;
    std::string title;
    void uploadGeometry(std::uint32_t id, const float* p, const float*, const float*, std::uint32_t vertexCount,
                        const std::uint32_t*, std::uint32_t, const float*, std::uint32_t) override {
        if (!p || !vertexCount) badDraws++;
        geometryVertices[id] = vertexCount;
        uploads++;
    }
    void releaseGeometry(std::uint32_t id) override { geometryVertices.erase(id); }
    void uploadInstances(std::uint32_t id, const float*, const float*, std::uint32_t count) override { instanceCounts[id] = count; }
    void releaseInstances(std::uint32_t id) override { instanceCounts.erase(id); }
    void submitPass(const float* data, std::size_t floats) override {
        passes++;
        framePasses.emplace_back(data, data + floats);
        const std::size_t lights = std::size_t(data[35]), draws = std::size_t(data[43]);
        const float* d = data + native_three::kWebappPassHeaderFloats + lights * native_three::kWebappLightFloats;
        for (std::size_t i = 0; i < draws; i++, d += native_three::kWebappDrawFloats) {
            if (!geometryVertices.count(std::uint32_t(d[0]))) badDraws++;
            if (d[1] > 0 && !instanceCounts.count(std::uint32_t(d[1]))) badDraws++;
        }
    }
    void setTitle(const std::string& t) override { title = t; }
    int uiSubmits = 0;
    std::size_t uiCommands = 0, uiTexts = 0, uiImages = 0;
    bool uiValid = true;
    void submitUi(const float* data, std::size_t floats, const std::string& strings) override {
        uiSubmits++;
        const auto table = native_three::webappUiSplitStrings(strings);
        const std::size_t header = native_three::webappUiHeaderFloats(data[0]);
        const float* p = data + header;
        std::size_t remaining = floats - header, count = std::size_t(data[3]), texts = 0, images = 0, n = 0;
        for (; n < count; n++) {
            const std::size_t size = native_three::webappUiCommandSize(p, remaining);
            if (!size) { uiValid = false; break; }
            if (int(p[0]) == native_three::kUiText) { texts++; if (std::size_t(p[5]) >= table.size() || std::size_t(p[6]) >= table.size()) uiValid = false; }
            if (int(p[0]) == native_three::kUiImage) { images++; if (std::size_t(p[5]) >= table.size()) uiValid = false; }
            p += size;
            remaining -= size;
        }
        if (remaining != 0) uiValid = false;
        uiCommands = n; uiTexts = texts; uiImages = images;
    }
    void log(const std::string& level, const std::string& text) override {
        if (level == "error") errors++;
        std::printf("[%s] %s\n", level.c_str(), text.c_str());
    }
};

bool compileShaders() {
    for (int stage = 0; stage < 2; stage++) {
        Microsoft::WRL::ComPtr<ID3DBlob> code, error;
        const HRESULT hr = D3DCompile(kWebappShader, std::strlen(kWebappShader), "webapp_shader", nullptr, nullptr,
                                      stage ? "PSMain" : "VSMain", stage ? "ps_5_0" : "vs_5_0",
                                      D3DCOMPILE_ENABLE_STRICTNESS | D3DCOMPILE_OPTIMIZATION_LEVEL3, 0, &code, &error);
        if (FAILED(hr)) {
            std::printf("HLSL %s failed:\n%s\n", stage ? "PSMain" : "VSMain",
                        error ? static_cast<const char*>(error->GetBufferPointer()) : "unknown error");
            return false;
        }
    }
    return true;
}
} // namespace

LONG WINAPI smokeCrashFilter(EXCEPTION_POINTERS* info) {
    std::printf("CRASH: native exception 0x%08lX at %p\n",
                info && info->ExceptionRecord ? (unsigned long)info->ExceptionRecord->ExceptionCode : 0ul,
                info && info->ExceptionRecord ? info->ExceptionRecord->ExceptionAddress : nullptr);
    std::fflush(stdout);
    return EXCEPTION_EXECUTE_HANDLER;
}

int wmain(int argc, wchar_t** argv) {
    ULONG guarantee = 128 * 1024;
    SetThreadStackGuarantee(&guarantee);
    SetUnhandledExceptionFilter(smokeCrashFilter);
    setvbuf(stdout, nullptr, _IONBF, 0);
    if (argc < 3) {
        std::printf("Usage: WebappSmoke <webapp folder> <min draws> [expect-boot-error|expect-resize]\n");
        return 2;
    }
    const std::filesystem::path root = argv[1];
    const int minDraws = _wtoi(argv[2]);
    const bool expectBootError = argc > 3 && std::wcscmp(argv[3], L"expect-boot-error") == 0;
    const bool expectResize = argc > 3 && std::wcscmp(argv[3], L"expect-resize") == 0;
    const bool expectUi = argc > 3 && std::wcscmp(argv[3], L"expect-ui") == 0;
    expect(compileShaders(), "webapp HLSL (VSMain/PSMain) compiles");

    std::string shim, error;
    std::vector<native_three::WebappBuiltin> builtins;
    expect(NativeWebapp_LoadBuiltins(shim, builtins, error), "embedded Three.js, shim and NativeRenderer resources");
    if (!error.empty()) std::printf("%s\n", error.c_str());

    RecordingSink sink;
    WebappHost host;
    const auto bootStart = std::chrono::steady_clock::now();
    const bool started = host.start(root, shim, builtins, &sink, 1280, 720, error);
    const double bootSeconds = std::chrono::duration<double>(std::chrono::steady_clock::now() - bootStart).count();
    std::printf("JavaScript engine: %s, boot %.2f s\n", native_three::webappEngineName(), bootSeconds);
    expect(started, "QuickJS webapp runtime starts and boots index.html");
    if (!started) { std::printf("%s\n", error.c_str()); return 1; }

    double t = 0;
    std::size_t maxDraws = 0;
    for (int frame = 0; frame < 300; frame++) {
        sink.framePasses.clear();
        if (frame < 3 || frame % 50 == 0) std::printf("frame %d\n", frame);
        host.frame(t);
        if (!sink.framePasses.empty()) sink.lastPasses = sink.framePasses;
        for (const auto& p : sink.framePasses) maxDraws = std::max<std::size_t>(maxDraws, std::size_t(p[43]));
        if (frame == 30) { host.pointer("down", 400, 300, 0); host.pointer("move", 470, 330, 0); host.pointer("up", 470, 330, 0); }
        if (frame == 40) host.wheel(400, 300, 0, 100);
        if (frame == 50) { host.key(true, " ", "Space", false, false, false, false, false); host.key(false, " ", "Space", false, false, false, false, false); }
        if (frame == 60) host.resize(960, 540, 1.0);
        if (frame == 61) { host.key(true, " ", "Space", false, false, false, false, false); host.key(false, " ", "Space", false, false, false, false, false); }
        t += 1000.0 / 60.0;
    }
    const double totalSeconds = std::chrono::duration<double>(std::chrono::steady_clock::now() - bootStart).count();
    std::printf("300 frames (JavaScript only, no GPU): %.2f s\n", totalSeconds - bootSeconds);
    const std::string status = host.statusJson();
    std::printf("status: %s\n", status.c_str());
    std::printf("geometry uploads: %d, passes: %d, max draws in a pass: %zu, title: %s\n",
                sink.uploads, sink.passes, maxDraws, sink.title.c_str());
    std::printf("HTML/CSS UI: %d submits, last list %zu commands (%zu text, %zu images)\n",
                sink.uiSubmits, sink.uiCommands, sink.uiTexts, sink.uiImages);
    expect(sink.uiValid, "every UI display list is well-formed");
    if (expectBootError) {
        expect(status.find("\"bootError\":null") == std::string::npos, "broken import is reported as a boot error");
        expect(sink.passes == 0, "nothing was rendered by the failed module");
    } else {
        expect(status.find("\"booted\":true") != std::string::npos, "webapp finished booting (DOMContentLoaded/load)");
        expect(status.find("\"bootError\":null") != std::string::npos, "no module failed to load");
        expect(status.find("\"errorCount\":0") != std::string::npos, "no JavaScript errors in 300 frames with input");
        expect(sink.errors == 0, "no errors logged by the runtime");
        expect(sink.passes >= 290, "render() reached native almost every frame");
        expect(maxDraws >= std::size_t(minDraws), "expected number of draws per frame");
        expect(sink.badDraws == 0, "every draw references uploaded geometry/instances");
        expect(minDraws == 0 || sink.uploads > 0, "geometry reached native");
        if (expectUi) {
            expect(sink.uiSubmits >= 1, "HTML/CSS UI reached native");
            expect(sink.uiTexts >= 10 && sink.uiImages >= 2, "UI text and images in the display list");
        }
        if (expectResize && !sink.lastPasses.empty()) {
            const auto& p = sink.lastPasses.back();
            expect(p[45] == 960.f && p[46] == 540.f, "resize event reached the webapp's renderer");
        }
    }
    host.shutdown();
    std::printf(failures ? "WEBAPP SMOKE FAILED (%d)\n" : "WEBAPP SMOKE PASSED\n", failures);
    return failures ? 1 : 0;
}
