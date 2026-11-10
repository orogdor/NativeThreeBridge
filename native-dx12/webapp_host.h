#pragma once
// Portable webapp runtime: runs an ordinary Three.js webapp folder
// (index.html + ES modules) inside QuickJS-NG without a browser.
// No Windows or DX12 dependency; the renderer is supplied as a sink.
#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <memory>
#include <optional>
#include <string>
#include <vector>

namespace native_three {

// A module or script embedded in the engine, addressed as "nt:<name>".
struct WebappBuiltin {
    std::string name;   // e.g. "nt:three.core.min.js"
    std::string source;
};

// Same-entry navigation is applied only after the current JS call returns.
struct WebappPage {
    std::string url;
    std::string storage;
};

// Receives everything NativeRenderer (js/native-renderer.mjs) sends.
class WebappRenderSink {
public:
    virtual ~WebappRenderSink() = default;
    // colors: colorChannels (3 rgb or 4 rgba) floats per vertex or nullptr; uvs: 2 floats per vertex or nullptr.
    virtual void uploadGeometry(std::uint32_t id, const float* positions, const float* normals,
                                const float* colors, std::uint32_t vertexCount,
                                const std::uint32_t* indices, std::uint32_t indexCount, const float* uvs,
                                std::uint32_t colorChannels) = 0;
    virtual void releaseGeometry(std::uint32_t id) = 0;
    // Texture `id` from encoded image bytes (width == 0: PNG/JPEG/WebP/...)
    // or tightly packed RGBA8 pixels. flags: kWebappTexture*. Returns false
    // when the image cannot be decoded (the draw stays untextured).
    virtual bool uploadTexture(std::uint32_t id, const std::uint8_t* data, std::size_t bytes,
                               std::uint32_t width, std::uint32_t height, std::uint32_t flags) {
        (void)id; (void)data; (void)bytes; (void)width; (void)height; (void)flags;
        return false;
    }
    virtual void releaseTexture(std::uint32_t id) { (void)id; }
    // Update RGBA32F subrectangle. data is tightly packed width*height*16 bytes.
    // Keep the underlying D3D12 texture and SRV slot stable across frames.
    virtual bool updateFloatTexture(std::uint32_t id, std::uint32_t x, std::uint32_t y,
                                    std::uint32_t w, std::uint32_t h,
                                    const std::uint8_t* data, std::size_t bytes) {
        (void)id; (void)x; (void)y; (void)w; (void)h; (void)data; (void)bytes;
        return false;
    }
    // Allocate an independent offscreen DX12 depth-stencil target. WebGL2
    // DEPTH_COMPONENT24 is stored as D32_FLOAT; sampling is a later stage.
    virtual bool allocateDepthTarget(std::uint32_t id, std::uint32_t width, std::uint32_t height) {
        (void)id; (void)width; (void)height;
        return false;
    }
    virtual void releaseDepthTarget(std::uint32_t id) { (void)id; }
    // Texture `id` from the current pixels of Canvas 2D surface `canvasId`.
    virtual bool uploadCanvasTexture(std::uint32_t id, std::uint32_t canvasId, std::uint32_t flags) {
        (void)id; (void)canvasId; (void)flags;
        return false;
    }
    virtual void uploadInstances(std::uint32_t id, const float* matrices, const float* colors,
                                 std::uint32_t count) = 0;
    virtual void releaseInstances(std::uint32_t id) = 0;
    virtual bool registerColorPatch(std::uint32_t id, const std::string& source) {
        (void)id; (void)source;
        return false;
    }
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
    // Canvas 2D (js/webapp-shim.js): one batch of drawing commands for canvas
    // `id`, see WebappUiRenderer::canvasCommands. `strings` joined with U+001F.
    virtual void canvasCommands(std::uint32_t id, std::uint32_t width, std::uint32_t height, const float* ops,
                                std::size_t floats, const std::string& strings) {
        (void)id; (void)width; (void)height; (void)ops; (void)floats; (void)strings;
    }
    // getImageData: straight RGBA8 of a rectangle. false = not available.
    virtual bool canvasRead(std::uint32_t id, std::int32_t x, std::int32_t y, std::uint32_t w, std::uint32_t h,
                            std::vector<std::uint8_t>& rgba) {
        (void)id; (void)x; (void)y; (void)w; (void)h; (void)rgba;
        return false;
    }
    // putImageData: straight RGBA8 written into a canvas of canvasW x canvasH.
    virtual void canvasWrite(std::uint32_t id, std::uint32_t canvasW, std::uint32_t canvasH, std::int32_t x, std::int32_t y,
                             std::uint32_t w, std::uint32_t h, const std::uint8_t* rgba) {
        (void)id; (void)canvasW; (void)canvasH; (void)x; (void)y; (void)w; (void)h; (void)rgba;
    }
    // Encoded image bytes (Blob images) usable as an image source named `key`.
    virtual void registerImage(const std::string& key, const std::uint8_t* bytes, std::size_t n) {
        (void)key; (void)bytes; (void)n;
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
constexpr std::size_t kWebappDrawFloats = 56;
constexpr std::uint32_t kWebappTextureSrgb = 1, kWebappTextureMipmaps = 2, kWebappTextureFloat32 = 4;
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
               int width, int height, std::string& error, const WebappPage& page = {});
    void shutdown();
    std::optional<WebappPage> takeReload();

    void resize(int width, int height, double pixelRatio = 1.0);
    // uiTick controls CSS/UI layout and submit cadence; timers and game rAF still run every frame.
    void frame(double timeMs, bool uiTick = true);
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
