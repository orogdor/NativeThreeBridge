#pragma once
// Portable webapp runtime: runs an ordinary Three.js webapp folder
// (index.html + ES modules) inside QuickJS-NG without a browser.
// No Windows or DX12 dependency; the renderer is supplied as a sink.
#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <memory>
#include <string>
#include <vector>

namespace native_three {

// A module or script embedded in the engine, addressed as "nt:<name>".
struct WebappBuiltin {
    std::string name;   // e.g. "nt:three.core.min.js"
    std::string source;
};

// Receives everything NativeRenderer (js/native-renderer.mjs) sends.
class WebappRenderSink {
public:
    virtual ~WebappRenderSink() = default;
    virtual void uploadGeometry(std::uint32_t id, const float* positions, const float* normals,
                                const float* colors, std::uint32_t vertexCount,
                                const std::uint32_t* indices, std::uint32_t indexCount) = 0;
    virtual void releaseGeometry(std::uint32_t id) = 0;
    virtual void uploadInstances(std::uint32_t id, const float* matrices, const float* colors,
                                 std::uint32_t count) = 0;
    virtual void releaseInstances(std::uint32_t id) = 0;
    // One render() call. Layout: see js/native-renderer.mjs (PASS_HEADER_FLOATS etc).
    virtual void submitPass(const float* data, std::size_t floatCount) = 0;
    virtual void setTitle(const std::string& title) = 0;
    virtual void log(const std::string& level, const std::string& text) = 0;
    // HTML/CSS UI layer (js/webapp-ui.js). Display-list layout: see
    // native-dx12/webapp_ui.h. `strings` are joined with U+001F.
    virtual void submitUi(const float* data, std::size_t floats, const std::string& strings) {
        (void)data; (void)floats; (void)strings;
    }
    // UI layer timings since the last call (ms) and layout counts.
    virtual void reportUi(double styleMs, double layoutMs, double paintMs, int forced, int full, int partial) {
        (void)styleMs; (void)layoutMs; (void)paintMs; (void)forced; (void)full; (void)partial;
    }
    // CSS cursor name under the pointer ("pointer", "text", "auto" ...).
    virtual void setCursor(const std::string& cursor) { (void)cursor; }
    // Width in px of `text` in the first installed family of the comma
    // separated `families`; negative when the sink cannot measure text.
    virtual double measureText(const std::string& families, double sizePx, int weight, bool italic,
                               const std::string& text) {
        (void)families; (void)sizePx; (void)weight; (void)italic; (void)text;
        return -1.0;
    }
};

// UI display-list header size for a version (webapp_ui.h); 0 = unknown.
inline std::size_t webappUiHeaderFloats(float version) {
    return version == 1.0f ? 4 : version == 2.0f ? 8 : 0;
}

// Same numbers as js/native-renderer.mjs.
constexpr std::size_t kWebappPassHeaderFloats = 64;
constexpr std::size_t kWebappLightFloats = 16;
constexpr std::size_t kWebappDrawFloats = 32;
constexpr std::size_t kWebappMaxLights = 16;

// Game-folder path checks shared by the module loader and file reads.
// Returns a normalized relative path ("js/app.js") or an empty string.
std::string webappNormalizeGamePath(const std::string& path);

// Import resolution identical to test/helpers/webapp-node-host.mjs.
// importMap holds key,value pairs. Returns the module name ("main.js",
// "nt:three") or sets `error` and returns an empty string.
std::string webappResolveModule(const std::string& base, const std::string& specifier,
                                const std::vector<std::string>& importMap,
                                const std::vector<std::string>& builtinNames,
                                std::string& error);

// Source of the engine's virtual 'three' module.
const char* webappThreeModuleSource();

// Reads root/<rel> after webappNormalizeGamePath (no escaping the folder).
bool webappReadGameFile(const std::filesystem::path& root, const std::string& rel,
                        std::string& out, std::string& error);
// UTF-8 form of a path (kept in a C++17 file: u8string changes type in C++20).
std::string webappPathUtf8(const std::filesystem::path& path);
// Name of the JavaScript engine this build uses ("QuickJS-NG" or "V8 <version>").
const char* webappEngineName();

class WebappHost {
public:
    WebappHost();
    ~WebappHost();
    WebappHost(const WebappHost&) = delete;
    WebappHost& operator=(const WebappHost&) = delete;

    // Creates the JS runtime, installs the shim and boots root/index.html.
    // Returns false if the runtime could not start (error describes why).
    // JavaScript errors inside the game are logged and counted, not fatal.
    bool start(const std::filesystem::path& root, const std::string& shimSource,
               std::vector<WebappBuiltin> builtins, WebappRenderSink* sink,
               int width, int height, std::string& error);
    void shutdown();

    void resize(int width, int height, double pixelRatio = 1.0);
    void frame(double timeMs);
    void key(bool down, const std::string& key, const std::string& code, bool repeat,
             bool alt, bool ctrl, bool shift, bool meta);
    void pointer(const char* kind, double x, double y, int button);   // "down" | "up" | "move"
    void wheel(double x, double y, double deltaX, double deltaY);
    void focus(bool focused);
    // JSON: {booted, frame, title, errors, errorCount, bootError, unsupported}
    std::string statusJson();
    bool running() const;

    struct Impl;
private:
    std::unique_ptr<Impl> impl_;
};

} // namespace native_three
