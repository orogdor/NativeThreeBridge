#pragma once
// Native side of the HTML/CSS UI layer (js/webapp-ui.js).
//
// The JS layer sends a display list: Float32Array
//   [2 (version), width, height, commandCount, dirtyX, dirtyY, dirtyW, dirtyH, commands...]
// (dirtyW < 0: redraw everything; version 1 has a 4-float header and no
// dirty rectangle)
// and a string table (UTF-8, joined with U+001F) for text, font families and
// image sources. WebappUiRenderer rasterises it with Direct2D, DirectWrite
// and WIC into a premultiplied BGRA bitmap that the DX12 webapp window
// composites over the 3D scene. No browser or HTML renderer is involved.
//
// Commands (all coordinates in window px, colours straight RGBA 0..1):
//   1 CLIP   x y w h r                     (w < 0: no clip)
//   2 RECT   x y w h r0 r1 r2 r3 rgba      (r = corner radii TL TR BR BL)
//   3 BORDER x y w h r0..r3 wT wR wB wL rgbaT rgbaR rgbaB rgbaL
//   4 IMAGE  x y w h src sx sy sw sh alpha unused smooth   (sw <= 0: whole image)
//   5 TEXT   x y w h text family size weight italic rgba decoFlags letterSpacing
//   6 LGRAD  x y w h r0..r3 x0 y0 x1 y1 n (pos rgba)*n
//   7 RGRAD  x y w h r0..r3 cx cy rx ry n (pos rgba)*n
//   8 SHADOW x y w h r0..r3 blur rgba
#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <memory>
#include <string>
#include <vector>

namespace native_three {

enum WebappUiOp : int {
    kUiClip = 1, kUiRect = 2, kUiBorder = 3, kUiImage = 4, kUiText = 5,
    kUiLinearGradient = 6, kUiRadialGradient = 7, kUiShadow = 8,
};

// Number of floats (including the op) of a command starting at `p`;
// 0 for an unknown op or a truncated command.
inline std::size_t webappUiCommandSize(const float* p, std::size_t remaining) {
    if (remaining < 1) return 0;
    std::size_t n = 0;
    switch (int(p[0])) {
    case kUiClip: n = 6; break;
    case kUiRect: n = 13; break;
    case kUiBorder: n = 29; break;
    case kUiImage: n = 13; break;
    case kUiText: n = 16; break;
    case kUiShadow: n = 14; break;
    case kUiLinearGradient: case kUiRadialGradient:
        if (remaining < 14 || p[13] < 0 || p[13] > 256) return 0;
        n = 14 + std::size_t(p[13]) * 5;
        break;
    default: return 0;
    }
    return n <= remaining ? n : 0;
}

// Splits the U+001F-joined string table.
inline std::vector<std::string> webappUiSplitStrings(const std::string& joined) {
    std::vector<std::string> out;
    std::size_t start = 0;
    for (std::size_t i = 0; i <= joined.size(); i++) {
        if (i == joined.size() || joined[i] == '\x1f') {
            out.push_back(joined.substr(start, i - start));
            start = i + 1;
        }
    }
    return out;
}

class WebappUiRenderer {
public:
    WebappUiRenderer();
    ~WebappUiRenderer();
    WebappUiRenderer(const WebappUiRenderer&) = delete;
    WebappUiRenderer& operator=(const WebappUiRenderer&) = delete;

    // Creates the Direct2D/DirectWrite/WIC factories. Returns false (and the
    // UI simply stays invisible) if they are unavailable.
    bool init(const std::filesystem::path& gameRoot, std::string& error);
    bool ready() const;

    // Replaces the display list (copied).
    void setDisplayList(const float* data, std::size_t floats, const std::string& strings);
    bool empty() const;

    // Width of `text` in px (first installed family of `families`), or -1.
    double measureText(const std::string& families, double sizePx, int weight, bool italic, const std::string& text);

    // Rasterises the current list at width x height if it or the size
    // changed. Returns true when new pixels are available.
    bool render(unsigned width, unsigned height);

    // Premultiplied BGRA8 pixels of the last render (top-down rows).
    const std::uint8_t* pixels() const;
    unsigned stride() const;
    unsigned width() const;
    unsigned height() const;

    // Diagnostics for the log: commands drawn, images failed, last ms.
    std::string stats() const;

    struct Impl;
private:
    std::unique_ptr<Impl> impl_;
};

} // namespace native_three
