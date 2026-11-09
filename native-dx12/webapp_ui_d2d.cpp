// Direct2D/DirectWrite/WIC rasteriser for the HTML/CSS UI display list.
// See webapp_ui.h for the command layout and js/webapp-ui.js for the
// producer. Renders on the CPU into a premultiplied BGRA bitmap only when the
// list or the window size changes; the DX12 window uploads it as a texture.
#define WIN32_LEAN_AND_MEAN
#ifndef NOMINMAX
#define NOMINMAX
#endif
// ID2D1DeviceContext5 (SVG documents) needs the Windows 10 1703 headers.
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif
#ifndef NTDDI_VERSION
#define NTDDI_VERSION 0x0A000003
#endif
#include <windows.h>
#include <d2d1_3.h>
#include <dwrite_1.h>
#include <wincodec.h>
#include <shlwapi.h>
#include <wrl/client.h>

#include <algorithm>
#include <cctype>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <map>
#include <tuple>
#include <unordered_map>

#include "webapp_ui.h"
#include "webapp_host.h"

#pragma comment(lib, "d2d1.lib")
#pragma comment(lib, "dwrite.lib")
#pragma comment(lib, "windowscodecs.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "shlwapi.lib")

using Microsoft::WRL::ComPtr;

namespace native_three {

namespace {

std::wstring wide(const std::string& s) {
    if (s.empty()) return {};
    const int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), int(s.size()), nullptr, 0);
    std::wstring w(std::size_t(std::max(0, n)), L'\0');
    if (n > 0) MultiByteToWideChar(CP_UTF8, 0, s.data(), int(s.size()), w.data(), n);
    return w;
}
float clamp01(float v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
D2D1_COLOR_F colorOf(const float* c) { return D2D1::ColorF(clamp01(c[0]), clamp01(c[1]), clamp01(c[2]), clamp01(c[3])); }
bool finite(float v) { return std::isfinite(v); }

bool decodeBase64(const std::string& in, std::string& out) {
    static int table[256];
    static bool init = false;
    if (!init) {
        for (int& t : table) t = -1;
        const char* a = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        for (int i = 0; i < 64; i++) table[(unsigned char)a[i]] = i;
        table[(unsigned char)'-'] = 62;
        table[(unsigned char)'_'] = 63;
        init = true;
    }
    out.clear();
    unsigned acc = 0;
    int bits = 0;
    for (unsigned char c : in) {
        if (c == '=') break;
        const int v = table[c];
        if (v < 0) continue; // whitespace
        acc = (acc << 6) | unsigned(v);
        bits += 6;
        if (bits >= 8) { bits -= 8; out.push_back(char((acc >> bits) & 0xff)); }
    }
    return !out.empty();
}
std::string percentDecode(const std::string& in) {
    std::string out;
    for (std::size_t i = 0; i < in.size(); i++) {
        if (in[i] == '%' && i + 2 < in.size() && std::isxdigit((unsigned char)in[i + 1]) && std::isxdigit((unsigned char)in[i + 2])) {
            out.push_back(char(std::stoi(in.substr(i + 1, 2), nullptr, 16)));
            i += 2;
        } else out.push_back(in[i]);
    }
    return out;
}

} // namespace

struct WebappUiRenderer::Impl {
    std::filesystem::path root;
    bool comInit = false;
    ComPtr<ID2D1Factory1> d2d;
    ComPtr<IDWriteFactory> dwrite;
    ComPtr<IDWriteFontCollection> fonts;
    ComPtr<IWICImagingFactory> wic;

    std::vector<float> list;
    std::vector<std::string> strings;
    bool dirty = true;

    ComPtr<IWICBitmap> target;
    ComPtr<ID2D1RenderTarget> rt;
    ComPtr<ID2D1DeviceContext5> dc5;
    ComPtr<ID2D1SolidColorBrush> brush;
    ComPtr<ID2D1Layer> layer;
    unsigned w = 0, h = 0;
    std::vector<std::uint8_t> pixels;
    unsigned stride = 0;

    struct Image {
        bool failed = false, svg = false;
        ComPtr<IWICBitmapSource> source; // decoded, PBGRA
        ComPtr<ID2D1Bitmap> bitmap;      // per render target
        std::string svgBytes;
        ComPtr<ID2D1SvgDocument> svgDoc; // per render target
    };
    std::unordered_map<std::string, Image> images;
    std::unordered_map<std::string, std::wstring> families;
    std::map<std::tuple<std::wstring, int, int, bool>, ComPtr<IDWriteTextFormat>> formats;
    int lastCommands = 0, failedImages = 0;
    double lastMs = 0;
    std::string lastFailure;

    enum class Clip { None, Axis, Layer } clip = Clip::None;

    // ---- fonts
    const std::wstring& family(const std::string& list) {
        auto it = families.find(list);
        if (it != families.end()) return it->second;
        std::wstring chosen = L"Segoe UI";
        std::size_t start = 0;
        for (std::size_t i = 0; i <= list.size(); i++) {
            if (i != list.size() && list[i] != ',') continue;
            std::string name = list.substr(start, i - start);
            start = i + 1;
            while (!name.empty() && (name.front() == ' ' || name.front() == '"' || name.front() == '\'')) name.erase(name.begin());
            while (!name.empty() && (name.back() == ' ' || name.back() == '"' || name.back() == '\'')) name.pop_back();
            if (name.empty()) continue;
            UINT32 index = 0;
            BOOL exists = FALSE;
            const std::wstring wname = wide(name);
            if (fonts && SUCCEEDED(fonts->FindFamilyName(wname.c_str(), &index, &exists)) && exists) { chosen = wname; break; }
        }
        return families.emplace(list, chosen).first->second;
    }
    IDWriteTextFormat* format(const std::string& familyList, float size, int weight, bool italic) {
        const std::wstring& fam = family(familyList);
        const int sizeKey = int(std::lround(size * 64));
        weight = std::clamp(weight, 100, 950);
        auto key = std::make_tuple(fam, sizeKey, weight, italic);
        auto it = formats.find(key);
        if (it != formats.end()) return it->second.Get();
        ComPtr<IDWriteTextFormat> f;
        if (FAILED(dwrite->CreateTextFormat(fam.c_str(), nullptr, DWRITE_FONT_WEIGHT(weight),
                                            italic ? DWRITE_FONT_STYLE_ITALIC : DWRITE_FONT_STYLE_NORMAL,
                                            DWRITE_FONT_STRETCH_NORMAL, std::max(1.0f, size), L"", &f)))
            return nullptr;
        f->SetWordWrapping(DWRITE_WORD_WRAPPING_NO_WRAP);
        f->SetTextAlignment(DWRITE_TEXT_ALIGNMENT_LEADING);
        f->SetParagraphAlignment(DWRITE_PARAGRAPH_ALIGNMENT_CENTER);
        if (formats.size() > 512) formats.clear();
        formats.emplace(key, f);
        return f.Get();
    }

    // ---- images
    Image& image(const std::string& src) {
        auto it = images.find(src);
        if (it != images.end()) return it->second;
        Image& img = images[src];
        std::string bytes, error;
        bool isSvg = false;
        if (src.rfind("data:", 0) == 0) {
            const std::size_t comma = src.find(',');
            const std::string meta = comma == std::string::npos ? "" : src.substr(5, comma - 5);
            const std::string payload = comma == std::string::npos ? "" : src.substr(comma + 1);
            isSvg = meta.find("svg") != std::string::npos;
            if (meta.find(";base64") != std::string::npos) decodeBase64(payload, bytes);
            else bytes = percentDecode(payload);
        } else if (!webappReadGameFile(root, src, bytes, error)) {
            img.failed = true;
            failedImages++;
            lastFailure = src + ": " + error;
            return img;
        }
        std::string lower = src;
        std::transform(lower.begin(), lower.end(), lower.begin(), [](unsigned char c) { return char(std::tolower(c)); });
        if (!isSvg && lower.size() > 4 && lower.compare(lower.size() - 4, 4, ".svg") == 0) isSvg = true;
        if (!isSvg && bytes.find("<svg") != std::string::npos && bytes.find("<svg") < 512) isSvg = true;
        if (isSvg) { img.svg = true; img.svgBytes = std::move(bytes); return img; }
        ComPtr<IStream> stream;
        stream.Attach(SHCreateMemStream(reinterpret_cast<const BYTE*>(bytes.data()), UINT(bytes.size())));
        ComPtr<IWICBitmapDecoder> decoder;
        ComPtr<IWICBitmapFrameDecode> frame;
        ComPtr<IWICFormatConverter> converter;
        ComPtr<IWICBitmap> copy;
        if (!stream || !wic ||
            FAILED(wic->CreateDecoderFromStream(stream.Get(), nullptr, WICDecodeMetadataCacheOnLoad, &decoder)) ||
            FAILED(decoder->GetFrame(0, &frame)) || FAILED(wic->CreateFormatConverter(&converter)) ||
            FAILED(converter->Initialize(frame.Get(), GUID_WICPixelFormat32bppPBGRA, WICBitmapDitherTypeNone, nullptr, 0,
                                         WICBitmapPaletteTypeMedianCut)) ||
            FAILED(wic->CreateBitmapFromSource(converter.Get(), WICBitmapCacheOnLoad, &copy))) {
            img.failed = true;
            failedImages++;
            lastFailure = src + ": Windows Imaging Component could not decode it (for WebP install the WebP Image Extension)";
            return img;
        }
        img.source = copy;
        return img;
    }

    // ---- geometry helpers
    static bool square(const float* r) { return r[0] < 0.25f && r[1] < 0.25f && r[2] < 0.25f && r[3] < 0.25f; }
    static bool uniform(const float* r) { return std::fabs(r[0] - r[1]) < 0.25f && std::fabs(r[0] - r[2]) < 0.25f && std::fabs(r[0] - r[3]) < 0.25f; }
    ComPtr<ID2D1Geometry> shape(float x, float y, float w, float hgt, const float* rIn) {
        float r[4];
        for (int i = 0; i < 4; i++) r[i] = std::max(0.0f, std::min(rIn[i], std::min(w, hgt) / 2));
        ComPtr<ID2D1Geometry> out;
        if (square(r)) {
            ComPtr<ID2D1RectangleGeometry> g;
            if (SUCCEEDED(d2d->CreateRectangleGeometry(D2D1::RectF(x, y, x + w, y + hgt), &g))) out = g;
            return out;
        }
        if (uniform(r)) {
            ComPtr<ID2D1RoundedRectangleGeometry> g;
            if (SUCCEEDED(d2d->CreateRoundedRectangleGeometry(D2D1::RoundedRect(D2D1::RectF(x, y, x + w, y + hgt), r[0], r[0]), &g))) out = g;
            return out;
        }
        ComPtr<ID2D1PathGeometry> path;
        ComPtr<ID2D1GeometrySink> sink;
        if (FAILED(d2d->CreatePathGeometry(&path)) || FAILED(path->Open(&sink))) return out;
        auto arc = [&](float ex, float ey, float rad) {
            if (rad <= 0) { sink->AddLine(D2D1::Point2F(ex, ey)); return; }
            sink->AddArc(D2D1::ArcSegment(D2D1::Point2F(ex, ey), D2D1::SizeF(rad, rad), 0, D2D1_SWEEP_DIRECTION_CLOCKWISE, D2D1_ARC_SIZE_SMALL));
        };
        sink->BeginFigure(D2D1::Point2F(x + r[0], y), D2D1_FIGURE_BEGIN_FILLED);
        sink->AddLine(D2D1::Point2F(x + w - r[1], y));
        arc(x + w, y + r[1], r[1]);
        sink->AddLine(D2D1::Point2F(x + w, y + hgt - r[2]));
        arc(x + w - r[2], y + hgt, r[2]);
        sink->AddLine(D2D1::Point2F(x + r[3], y + hgt));
        arc(x, y + hgt - r[3], r[3]);
        sink->AddLine(D2D1::Point2F(x, y + r[0]));
        arc(x + r[0], y, r[0]);
        sink->EndFigure(D2D1_FIGURE_END_CLOSED);
        sink->Close();
        out = path;
        return out;
    }
    void fill(float x, float y, float w, float hgt, const float* r, ID2D1Brush* b) {
        if (w <= 0 || hgt <= 0) return;
        if (square(r)) { rt->FillRectangle(D2D1::RectF(x, y, x + w, y + hgt), b); return; }
        if (uniform(r)) {
            const float rad = std::min(r[0], std::min(w, hgt) / 2);
            rt->FillRoundedRectangle(D2D1::RoundedRect(D2D1::RectF(x, y, x + w, y + hgt), rad, rad), b);
            return;
        }
        ComPtr<ID2D1Geometry> g = shape(x, y, w, hgt, r);
        if (g) rt->FillGeometry(g.Get(), b);
    }
    ID2D1SolidColorBrush* solid(const float* rgba) {
        brush->SetColor(colorOf(rgba));
        brush->SetOpacity(1.0f);
        return brush.Get();
    }
    void popClip() {
        if (clip == Clip::Axis) rt->PopAxisAlignedClip();
        else if (clip == Clip::Layer) rt->PopLayer();
        clip = Clip::None;
    }
    ComPtr<ID2D1GradientStopCollection> stops(const float* s, int n) {
        std::vector<D2D1_GRADIENT_STOP> v;
        for (int i = 0; i < n; i++) v.push_back({clamp01(s[i * 5]), colorOf(s + i * 5 + 1)});
        ComPtr<ID2D1GradientStopCollection> c;
        rt->CreateGradientStopCollection(v.data(), UINT32(v.size()), D2D1_GAMMA_2_2, D2D1_EXTEND_MODE_CLAMP, &c);
        return c;
    }

    // ---- commands
    void execute() {
        if (list.size() < 4) return;
        const std::size_t count = std::size_t(std::max(0.0f, list[3]));
        const float* p = list.data() + 4;
        std::size_t remaining = list.size() - 4;
        auto str = [&](float idx) -> const std::string& {
            static const std::string empty;
            const std::size_t i = std::size_t(std::max(0.0f, idx));
            return i < strings.size() ? strings[i] : empty;
        };
        int drawn = 0;
        for (std::size_t c = 0; c < count; c++) {
            const std::size_t size = webappUiCommandSize(p, remaining);
            if (!size) break;
            const float* a = p + 1;
            bool ok = true;
            for (std::size_t k = 0; k + 1 < size && k < 13; k++) if (!finite(a[k])) { ok = false; break; }
            if (ok) {
                drawCommand(int(p[0]), a, str);
                drawn++;
            }
            p += size;
            remaining -= size;
        }
        popClip();
        lastCommands = drawn;
    }
    template <typename Str>
    void drawCommand(int op, const float* a, Str&& str) {
        switch (op) {
        case kUiClip:
            popClip();
            if (a[2] >= 0 && a[3] >= 0) {
                if (a[4] <= 0.5f) {
                    rt->PushAxisAlignedClip(D2D1::RectF(a[0], a[1], a[0] + a[2], a[1] + a[3]), D2D1_ANTIALIAS_MODE_ALIASED);
                    clip = Clip::Axis;
                } else {
                    const float r[4] = {a[4], a[4], a[4], a[4]};
                    ComPtr<ID2D1Geometry> g = shape(a[0], a[1], a[2], a[3], r);
                    if (g && layer) {
                        rt->PushLayer(D2D1::LayerParameters(D2D1::InfiniteRect(), g.Get()), layer.Get());
                        clip = Clip::Layer;
                    }
                }
            }
            break;
        case kUiRect:
            if (a[11] > 0) fill(a[0], a[1], a[2], a[3], a + 4, solid(a + 8));
            break;
        case kUiShadow: {
            const float blur = std::max(0.0f, a[8]);
            const float alpha = a[12];
            if (alpha <= 0) break;
            const int steps = blur < 1 ? 1 : std::min(10, int(std::ceil(blur / 2)));
            for (int k = 0; k < steps; k++) {
                const float e = steps == 1 ? 0 : blur * (0.5f - float(k) / float(steps - 1));
                float rgba[4] = {a[9], a[10], a[11], alpha / float(steps) * (steps == 1 ? 1.0f : 1.6f)};
                const float r[4] = {std::max(0.0f, a[4] + e), std::max(0.0f, a[5] + e), std::max(0.0f, a[6] + e), std::max(0.0f, a[7] + e)};
                fill(a[0] - e, a[1] - e, a[2] + 2 * e, a[3] + 2 * e, r, solid(rgba));
            }
            break;
        }
        case kUiBorder: {
            const float x = a[0], y = a[1], w = a[2], hgt = a[3];
            const float* r = a + 4;
            const float bt = a[8], br = a[9], bb = a[10], bl = a[11];
            const float* col[4] = {a + 12, a + 16, a + 20, a + 24};
            bool same = true;
            for (int i = 1; i < 4; i++)
                for (int k = 0; k < 4; k++)
                    if (std::fabs(col[i][k] - col[0][k]) > 0.002f && (i == 1 ? br : i == 2 ? bb : bl) > 0) same = false;
            if (same && !square(r)) {
                ComPtr<ID2D1Geometry> outer = shape(x, y, w, hgt, r);
                const float ir[4] = {std::max(0.0f, r[0] - std::max(bl, bt)), std::max(0.0f, r[1] - std::max(br, bt)),
                                     std::max(0.0f, r[2] - std::max(br, bb)), std::max(0.0f, r[3] - std::max(bl, bb))};
                ComPtr<ID2D1Geometry> inner = shape(x + bl, y + bt, std::max(0.0f, w - bl - br), std::max(0.0f, hgt - bt - bb), ir);
                if (outer && inner) {
                    ID2D1Geometry* parts[2] = {outer.Get(), inner.Get()};
                    ComPtr<ID2D1GeometryGroup> ring;
                    if (SUCCEEDED(d2d->CreateGeometryGroup(D2D1_FILL_MODE_ALTERNATE, parts, 2, &ring)))
                        rt->FillGeometry(ring.Get(), solid(col[0]));
                }
                break;
            }
            const float zero[4] = {0, 0, 0, 0};
            if (bt > 0 && col[0][3] > 0) fill(x, y, w, bt, zero, solid(col[0]));
            if (bb > 0 && col[2][3] > 0) fill(x, y + hgt - bb, w, bb, zero, solid(col[2]));
            if (bl > 0 && col[3][3] > 0) fill(x, y + bt, bl, hgt - bt - bb, zero, solid(col[3]));
            if (br > 0 && col[1][3] > 0) fill(x + w - br, y + bt, br, hgt - bt - bb, zero, solid(col[1]));
            break;
        }
        case kUiImage: {
            if (a[2] <= 0 || a[3] <= 0 || a[9] <= 0) break;
            Image& img = image(str(a[4]));
            if (img.failed) break;
            const D2D1_RECT_F dst = D2D1::RectF(a[0], a[1], a[0] + a[2], a[1] + a[3]);
            if (img.svg) {
                if (!dc5) break;
                if (!img.svgDoc) {
                    ComPtr<IStream> s;
                    s.Attach(SHCreateMemStream(reinterpret_cast<const BYTE*>(img.svgBytes.data()), UINT(img.svgBytes.size())));
                    if (!s || FAILED(dc5->CreateSvgDocument(s.Get(), D2D1::SizeF(a[2], a[3]), &img.svgDoc))) {
                        img.failed = true;
                        failedImages++;
                        lastFailure = str(a[4]).substr(0, 80) + ": SVG could not be parsed by Direct2D";
                        break;
                    }
                }
                img.svgDoc->SetViewportSize(D2D1::SizeF(a[2], a[3]));
                const bool fade = a[9] < 0.999f && layer;
                if (fade) rt->PushLayer(D2D1::LayerParameters(D2D1::InfiniteRect(), nullptr, D2D1_ANTIALIAS_MODE_PER_PRIMITIVE, D2D1::IdentityMatrix(), a[9]), layer.Get());
                rt->SetTransform(D2D1::Matrix3x2F::Translation(a[0], a[1]));
                dc5->DrawSvgDocument(img.svgDoc.Get());
                rt->SetTransform(D2D1::IdentityMatrix());
                if (fade) rt->PopLayer();
                break;
            }
            if (!img.bitmap && FAILED(rt->CreateBitmapFromWicBitmap(img.source.Get(), nullptr, &img.bitmap))) {
                img.failed = true;
                failedImages++;
                break;
            }
            D2D1_RECT_F src{};
            const bool crop = a[7] > 0 && a[8] > 0;
            if (crop) src = D2D1::RectF(a[5], a[6], a[5] + a[7], a[6] + a[8]);
            rt->DrawBitmap(img.bitmap.Get(), dst, clamp01(a[9]),
                           a[11] > 0.5f ? D2D1_BITMAP_INTERPOLATION_MODE_LINEAR : D2D1_BITMAP_INTERPOLATION_MODE_NEAREST_NEIGHBOR,
                           crop ? &src : nullptr);
            break;
        }
        case kUiText: {
            if (a[12] <= 0) break;
            const std::wstring text = wide(str(a[4]));
            if (text.empty()) break;
            IDWriteTextFormat* f = format(str(a[5]), a[6], int(a[7]), a[8] > 0.5f);
            if (!f) break;
            ComPtr<IDWriteTextLayout> layout;
            if (FAILED(dwrite->CreateTextLayout(text.c_str(), UINT32(text.size()), f, std::max(a[2], 1.0f) + 4096.0f,
                                                std::max(a[3], 1.0f), &layout)))
                break;
            const DWRITE_TEXT_RANGE all{0, UINT32(text.size())};
            const int deco = int(a[13]);
            if (deco & 1) layout->SetUnderline(TRUE, all);
            if (deco & 2) layout->SetStrikethrough(TRUE, all);
            if (std::fabs(a[14]) > 0.01f) {
                ComPtr<IDWriteTextLayout1> l1;
                if (SUCCEEDED(layout.As(&l1))) l1->SetCharacterSpacing(0, a[14], 0, all);
            }
            rt->DrawTextLayout(D2D1::Point2F(a[0], a[1]), layout.Get(), solid(a + 9), D2D1_DRAW_TEXT_OPTIONS_ENABLE_COLOR_FONT);
            break;
        }
        case kUiLinearGradient: case kUiRadialGradient: {
            const int n = int(a[12]);
            ComPtr<ID2D1GradientStopCollection> coll = stops(a + 13, n);
            if (!coll) break;
            if (op == kUiLinearGradient) {
                ComPtr<ID2D1LinearGradientBrush> b;
                if (SUCCEEDED(rt->CreateLinearGradientBrush(D2D1::LinearGradientBrushProperties(D2D1::Point2F(a[8], a[9]), D2D1::Point2F(a[10], a[11])), coll.Get(), &b)))
                    fill(a[0], a[1], a[2], a[3], a + 4, b.Get());
            } else {
                ComPtr<ID2D1RadialGradientBrush> b;
                if (SUCCEEDED(rt->CreateRadialGradientBrush(D2D1::RadialGradientBrushProperties(D2D1::Point2F(a[8], a[9]), D2D1::Point2F(0, 0), std::max(0.5f, a[10]), std::max(0.5f, a[11])), coll.Get(), &b)))
                    fill(a[0], a[1], a[2], a[3], a + 4, b.Get());
            }
            break;
        }
        default: break;
        }
    }
};

WebappUiRenderer::WebappUiRenderer() : impl_(std::make_unique<Impl>()) {}
WebappUiRenderer::~WebappUiRenderer() {
    if (impl_) {
        const bool com = impl_->comInit;
        impl_.reset();
        if (com) CoUninitialize();
    }
}

bool WebappUiRenderer::init(const std::filesystem::path& gameRoot, std::string& error) {
    Impl& s = *impl_;
    s.root = gameRoot;
    const HRESULT co = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    s.comInit = co == S_OK || co == S_FALSE;
    if (FAILED(D2D1CreateFactory(D2D1_FACTORY_TYPE_SINGLE_THREADED, s.d2d.GetAddressOf()))) { error = "Direct2D factory unavailable"; return false; }
    if (FAILED(DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED, __uuidof(IDWriteFactory), reinterpret_cast<IUnknown**>(s.dwrite.GetAddressOf())))) {
        error = "DirectWrite factory unavailable";
        s.d2d.Reset();
        return false;
    }
    s.dwrite->GetSystemFontCollection(&s.fonts, FALSE);
    if (FAILED(CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&s.wic))))
        error = "Windows Imaging Component unavailable: UI images will not be drawn";
    return true;
}
bool WebappUiRenderer::ready() const { return impl_->d2d && impl_->dwrite; }

void WebappUiRenderer::setDisplayList(const float* data, std::size_t floats, const std::string& strings) {
    Impl& s = *impl_;
    s.list.assign(data, data + floats);
    s.strings = webappUiSplitStrings(strings);
    s.dirty = true;
}
bool WebappUiRenderer::empty() const { return impl_->list.size() < 4 || impl_->list[3] <= 0; }

double WebappUiRenderer::measureText(const std::string& families, double sizePx, int weight, bool italic, const std::string& text) {
    Impl& s = *impl_;
    if (!s.dwrite) return -1.0;
    const std::wstring w = wide(text);
    if (w.empty()) return 0.0;
    IDWriteTextFormat* f = s.format(families, float(sizePx), weight, italic);
    if (!f) return -1.0;
    ComPtr<IDWriteTextLayout> layout;
    if (FAILED(s.dwrite->CreateTextLayout(w.c_str(), UINT32(w.size()), f, 100000.0f, 1000.0f, &layout))) return -1.0;
    DWRITE_TEXT_METRICS m{};
    if (FAILED(layout->GetMetrics(&m))) return -1.0;
    return m.widthIncludingTrailingWhitespace;
}

bool WebappUiRenderer::render(unsigned width, unsigned height) {
    Impl& s = *impl_;
    if (!s.d2d || !s.wic || width == 0 || height == 0) return false;
    if (!s.dirty && width == s.w && height == s.h && s.rt) return false;
    const auto start = std::chrono::steady_clock::now();
    if (!s.rt || width != s.w || height != s.h) {
        s.rt.Reset();
        s.dc5.Reset();
        s.brush.Reset();
        s.layer.Reset();
        s.target.Reset();
        for (auto& kv : s.images) { kv.second.bitmap.Reset(); kv.second.svgDoc.Reset(); }
        if (FAILED(s.wic->CreateBitmap(width, height, GUID_WICPixelFormat32bppPBGRA, WICBitmapCacheOnDemand, &s.target))) return false;
        const D2D1_RENDER_TARGET_PROPERTIES props = D2D1::RenderTargetProperties(
            D2D1_RENDER_TARGET_TYPE_DEFAULT, D2D1::PixelFormat(DXGI_FORMAT_B8G8R8A8_UNORM, D2D1_ALPHA_MODE_PREMULTIPLIED), 96.0f, 96.0f);
        if (FAILED(s.d2d->CreateWicBitmapRenderTarget(s.target.Get(), props, &s.rt))) return false;
        s.rt.As(&s.dc5); // SVG needs ID2D1DeviceContext5 (Windows 10 1703+)
        s.rt->CreateSolidColorBrush(D2D1::ColorF(0, 0, 0, 1), &s.brush);
        s.rt->CreateLayer(nullptr, &s.layer);
        s.w = width;
        s.h = height;
    }
    s.dirty = false;
    s.rt->BeginDraw();
    s.rt->SetTransform(D2D1::IdentityMatrix());
    s.rt->Clear(D2D1::ColorF(0, 0, 0, 0));
    s.rt->SetAntialiasMode(D2D1_ANTIALIAS_MODE_PER_PRIMITIVE);
    s.rt->SetTextAntialiasMode(D2D1_TEXT_ANTIALIAS_MODE_GRAYSCALE);
    s.clip = Impl::Clip::None;
    s.execute();
    const HRESULT hr = s.rt->EndDraw();
    if (hr == D2DERR_RECREATE_TARGET) { s.rt.Reset(); s.dirty = true; return false; }
    if (FAILED(hr)) return false;
    ComPtr<IWICBitmapLock> lock;
    const WICRect rect{0, 0, INT(width), INT(height)};
    if (FAILED(s.target->Lock(&rect, WICBitmapLockRead, &lock))) return false;
    UINT stride = 0, bytes = 0;
    BYTE* data = nullptr;
    lock->GetStride(&stride);
    lock->GetDataPointer(&bytes, &data);
    if (!data) return false;
    s.stride = stride;
    s.pixels.assign(data, data + std::size_t(stride) * height);
    s.lastMs = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - start).count();
    return true;
}

const std::uint8_t* WebappUiRenderer::pixels() const { return impl_->pixels.empty() ? nullptr : impl_->pixels.data(); }
unsigned WebappUiRenderer::stride() const { return impl_->stride; }
unsigned WebappUiRenderer::width() const { return impl_->w; }
unsigned WebappUiRenderer::height() const { return impl_->h; }

std::string WebappUiRenderer::stats() const {
    const Impl& s = *impl_;
    char line[256];
    std::snprintf(line, sizeof line, "UI layer: %d commands, %zu images (%d failed), %.1f ms raster%s",
                  s.lastCommands, s.images.size(), s.failedImages, s.lastMs, s.dc5 ? "" : ", no SVG support");
    std::string out = line;
    if (!s.lastFailure.empty()) out += " | last image problem: " + s.lastFailure;
    return out;
}

} // namespace native_three
