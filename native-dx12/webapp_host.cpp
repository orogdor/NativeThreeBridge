// Portable QuickJS-NG host for ordinary Three.js webapps. See webapp_host.h.
#include "webapp_host.h"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <map>
#include <set>
#include <sstream>

#include "quickjs.h"

namespace native_three {
namespace {

constexpr std::size_t kMaxGameFileBytes = 256u * 1024u * 1024u;

bool startsWith(const std::string& s, const char* prefix) {
    const std::size_t n = std::strlen(prefix);
    return s.size() >= n && s.compare(0, n, prefix) == 0;
}
bool endsWith(const std::string& s, const char* suffix) {
    const std::size_t n = std::strlen(suffix);
    return s.size() >= n && s.compare(s.size() - n, n, suffix) == 0;
}
std::string stripQueryAndHash(const std::string& s) {
    const std::size_t cut = s.find_first_of("?#");
    return cut == std::string::npos ? s : s.substr(0, cut);
}
std::string dirOf(const std::string& path) {
    const std::size_t slash = path.find_last_of('/');
    return slash == std::string::npos ? std::string() : path.substr(0, slash + 1);
}
std::string baseName(const std::string& path) {
    const std::size_t slash = path.find_last_of('/');
    return slash == std::string::npos ? path : path.substr(slash + 1);
}
// Joins and normalizes; returns false when the path climbs above the root.
bool normalizeSegments(const std::string& path, std::string& out) {
    std::vector<std::string> parts;
    std::size_t start = 0;
    while (start <= path.size()) {
        std::size_t end = path.find('/', start);
        if (end == std::string::npos) end = path.size();
        const std::string part = path.substr(start, end - start);
        if (part == "..") {
            if (parts.empty()) return false;
            parts.pop_back();
        } else if (!part.empty() && part != ".") {
            parts.push_back(part);
        }
        start = end + 1;
    }
    out.clear();
    for (std::size_t i = 0; i < parts.size(); i++) {
        if (i) out += '/';
        out += parts[i];
    }
    return true;
}
bool isThreeBuildFile(const std::string& path) {
    const std::string name = baseName(path);
    return name == "three.module.js" || name == "three.module.min.js" ||
           name == "three.core.js" || name == "three.core.min.js";
}
std::string toLower(std::string s) {
    for (char& c : s) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    return s;
}

} // namespace

// ---------------------------------------------------------------------------
struct WebappHost::Impl {
    JSRuntime* rt = nullptr;
    JSContext* ctx = nullptr;
    JSValue hostObject = JS_UNDEFINED;
    std::filesystem::path root;
    std::map<std::string, std::string> builtins;
    std::vector<std::string> builtinNames;
    std::vector<std::string> importMap;
    std::set<std::string> warnedThreeImports;
    WebappRenderSink* sink = nullptr;
    std::string title;
    bool started = false;
    std::optional<WebappPage> reload;

    static Impl* from(JSContext* c) { return static_cast<Impl*>(JS_GetContextOpaque(c)); }

    void log(const std::string& level, const std::string& text) {
        if (sink) sink->log(level, text);
    }
    std::string exceptionText() {
        JSValue exception = JS_GetException(ctx);
        std::string out;
        const char* message = JS_ToCString(ctx, exception);
        out = message ? message : "(exception)";
        if (message) JS_FreeCString(ctx, message);
        if (JS_IsError(exception)) {
            JSValue stack = JS_GetPropertyStr(ctx, exception, "stack");
            if (!JS_IsUndefined(stack)) {
                const char* s = JS_ToCString(ctx, stack);
                if (s && *s) { out += "\n"; out += s; }
                if (s) JS_FreeCString(ctx, s);
            }
            JS_FreeValue(ctx, stack);
        }
        JS_FreeValue(ctx, exception);
        return out;
    }
    void drainJobs() {
        for (int i = 0; i < 1000000; i++) {
            JSContext* jobContext = nullptr;
            const int r = JS_ExecutePendingJob(rt, &jobContext);
            if (r == 0) return;
            if (r < 0) log("error", "Uncaught (in promise job): " + exceptionText());
        }
        log("error", "Promise job queue did not settle (1,000,000 jobs in one step)");
    }
    bool readGameFile(const std::string& rel, std::string& out, std::string& error) {
        return webappReadGameFile(root, rel, out, error);
    }
    // Calls __ntHost[name](...args); errors are logged, never fatal.
    void callHost(const char* name, int argc, JSValue* argv) {
        if (!started) return;
        JSValue fn = JS_GetPropertyStr(ctx, hostObject, name);
        JSValue result = JS_Call(ctx, fn, hostObject, argc, argv);
        if (JS_IsException(result)) log("error", std::string("__ntHost.") + name + ": " + exceptionText());
        JS_FreeValue(ctx, result);
        JS_FreeValue(ctx, fn);
        for (int i = 0; i < argc; i++) JS_FreeValue(ctx, argv[i]);
        drainJobs();
    }
};

namespace {

using Impl = WebappHost::Impl;

std::string argString(JSContext* ctx, JSValueConst v) {
    std::size_t len = 0;
    const char* s = JS_ToCStringLen(ctx, &len, v);
    if (!s) return {};
    std::string out(s, len);
    JS_FreeCString(ctx, s);
    return out;
}

// Typed array view. Optional arrays may be null/undefined -> data=nullptr.
template <typename T>
bool typedView(JSContext* ctx, JSValueConst value, const T*& data, std::size_t& count,
               bool optional, const char* what) {
    data = nullptr;
    count = 0;
    if (optional && (JS_IsNull(value) || JS_IsUndefined(value))) return true;
    std::size_t offset = 0, bytes = 0, elementBytes = 0;
    JSValue buffer = JS_GetTypedArrayBuffer(ctx, value, &offset, &bytes, &elementBytes);
    if (JS_IsException(buffer)) return false;
    std::size_t total = 0;
    std::uint8_t* base = JS_GetArrayBuffer(ctx, &total, buffer);
    JS_FreeValue(ctx, buffer);
    if (!base || elementBytes != sizeof(T) || offset + bytes > total) {
        JS_ThrowTypeError(ctx, "%s: wrong typed array type", what);
        return false;
    }
    data = reinterpret_cast<const T*>(base + offset);
    count = bytes / sizeof(T);
    return true;
}

JSValue jsRequestReload(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    auto* self = Impl::from(ctx);
    if (argc >= 2) self->reload = WebappPage{argString(ctx, argv[0]), argString(ctx, argv[1])};
    return JS_UNDEFINED;
}

JSValue jsLog(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    Impl* self = Impl::from(ctx);
    if (argc >= 2) self->log(argString(ctx, argv[0]), argString(ctx, argv[1]));
    return JS_UNDEFINED;
}
JSValue jsSetTitle(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    Impl* self = Impl::from(ctx);
    if (argc >= 1) {
        self->title = argString(ctx, argv[0]);
        if (self->sink) self->sink->setTitle(self->title);
    }
    return JS_UNDEFINED;
}
JSValue jsReadText(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    Impl* self = Impl::from(ctx);
    if (argc < 1) return JS_ThrowTypeError(ctx, "readText(path)");
    std::string data, error;
    if (!self->readGameFile(argString(ctx, argv[0]), data, error))
        return JS_ThrowReferenceError(ctx, "%s", error.c_str());
    return JS_NewStringLen(ctx, data.data(), data.size());
}
JSValue jsReadBinary(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    Impl* self = Impl::from(ctx);
    if (argc < 1) return JS_ThrowTypeError(ctx, "readBinary(path)");
    std::string data, error;
    if (!self->readGameFile(argString(ctx, argv[0]), data, error))
        return JS_ThrowReferenceError(ctx, "%s", error.c_str());
    return JS_NewArrayBufferCopy(ctx, reinterpret_cast<const std::uint8_t*>(data.data()), data.size());
}
JSValue jsSetImportMap(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    Impl* self = Impl::from(ctx);
    self->importMap.clear();
    if (argc < 1) return JS_UNDEFINED;
    JSValue lengthValue = JS_GetPropertyStr(ctx, argv[0], "length");
    std::uint32_t length = 0;
    JS_ToUint32(ctx, &length, lengthValue);
    JS_FreeValue(ctx, lengthValue);
    for (std::uint32_t i = 0; i + 1 < length && i < 4096; i += 2) {
        JSValue k = JS_GetPropertyUint32(ctx, argv[0], i);
        JSValue v = JS_GetPropertyUint32(ctx, argv[0], i + 1);
        self->importMap.push_back(argString(ctx, k));
        self->importMap.push_back(argString(ctx, v));
        JS_FreeValue(ctx, k);
        JS_FreeValue(ctx, v);
    }
    return JS_UNDEFINED;
}
JSValue jsEvalScript(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    if (argc < 2) return JS_ThrowTypeError(ctx, "evalScript(source, name)");
    const std::string source = argString(ctx, argv[0]);
    const std::string name = argString(ctx, argv[1]);
    return JS_Eval(ctx, source.c_str(), source.size(), name.c_str(), JS_EVAL_TYPE_GLOBAL);
}
int setImportMeta(JSContext* ctx, JSValueConst moduleValue, const std::string& name) {
    JSModuleDef* m = static_cast<JSModuleDef*>(JS_VALUE_GET_PTR(moduleValue));
    JSValue meta = JS_GetImportMeta(ctx, m);
    if (JS_IsException(meta)) return -1;
    std::string url;
    if (startsWith(name, "nt:")) url = name;
    else {
        std::string file = name;
        const std::size_t hash = file.find('#');
        if (hash != std::string::npos) file.resize(hash);
        url = "nt://game/" + file;
    }
    JS_DefinePropertyValueStr(ctx, meta, "url", JS_NewString(ctx, url.c_str()), JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(ctx, meta, "main", JS_NewBool(ctx, false), JS_PROP_C_W_E);
    JS_FreeValue(ctx, meta);
    return 0;
}
JSValue jsEvalModule(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    if (argc < 2) return JS_ThrowTypeError(ctx, "evalModule(source, name)");
    const std::string source = argString(ctx, argv[0]);
    const std::string name = argString(ctx, argv[1]);
    JSValue compiled = JS_Eval(ctx, source.c_str(), source.size(), name.c_str(),
                               JS_EVAL_TYPE_MODULE | JS_EVAL_FLAG_COMPILE_ONLY);
    if (JS_IsException(compiled)) return compiled;
    if (setImportMeta(ctx, compiled, name) < 0) {
        JS_FreeValue(ctx, compiled);
        return JS_EXCEPTION;
    }
    // Takes ownership of `compiled`; returns the evaluation promise.
    return JS_EvalFunction(ctx, compiled);
}
JSValue jsUploadGeometry(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    Impl* self = Impl::from(ctx);
    if (argc < 5) return JS_ThrowTypeError(ctx, "uploadGeometry(id, positions, normals, colors, indices, uvs)");
    std::uint32_t id = 0;
    if (JS_ToUint32(ctx, &id, argv[0]) < 0) return JS_EXCEPTION;
    const float *positions = nullptr, *normals = nullptr, *colors = nullptr, *uvs = nullptr;
    const std::uint32_t* indices = nullptr;
    std::size_t nPositions = 0, nNormals = 0, nColors = 0, nIndices = 0, nUvs = 0;
    if (!typedView(ctx, argv[1], positions, nPositions, false, "positions") ||
        !typedView(ctx, argv[2], normals, nNormals, true, "normals") ||
        !typedView(ctx, argv[3], colors, nColors, true, "colors") ||
        !typedView(ctx, argv[4], indices, nIndices, true, "indices") ||
        (argc >= 6 && !typedView(ctx, argv[5], uvs, nUvs, true, "uvs")))
        return JS_EXCEPTION;
    if (nPositions % 3 || (normals && nNormals != nPositions) || (colors && nColors != nPositions && nColors != nPositions / 3 * 4))
        return JS_ThrowRangeError(ctx, "Geometry attributes must be 3 floats per vertex (colours 3 or 4) and equal length");
    const std::uint32_t vertexCount = static_cast<std::uint32_t>(nPositions / 3);
    const std::uint32_t colorChannels = colors && nColors != nPositions ? 4 : 3;
    if (uvs && nUvs != std::size_t(vertexCount) * 2) return JS_ThrowRangeError(ctx, "Geometry uvs must be 2 floats per vertex");
    for (std::size_t i = 0; i < nIndices; i++)
        if (indices[i] >= vertexCount) return JS_ThrowRangeError(ctx, "Geometry index out of range");
    if (self->sink)
        self->sink->uploadGeometry(id, positions, normals, colors, vertexCount, indices,
                                   static_cast<std::uint32_t>(nIndices), uvs, colorChannels);
    return JS_UNDEFINED;
}
JSValue jsUploadTexture(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    Impl* self = Impl::from(ctx);
    if (argc < 5) return JS_ThrowTypeError(ctx, "uploadTexture(id, bytes, width, height, flags)");
    std::uint32_t id = 0, width = 0, height = 0, flags = 0;
    if (JS_ToUint32(ctx, &id, argv[0]) < 0 || JS_ToUint32(ctx, &width, argv[2]) < 0 ||
        JS_ToUint32(ctx, &height, argv[3]) < 0 || JS_ToUint32(ctx, &flags, argv[4]) < 0)
        return JS_EXCEPTION;
    const std::uint8_t* data = nullptr;
    std::size_t bytes = 0;
    if (!typedView(ctx, argv[1], data, bytes, false, "texture data")) return JS_EXCEPTION;
    if (width && (height == 0 || bytes < std::size_t(width) * height * 4))
        return JS_ThrowRangeError(ctx, "uploadTexture: pixel data smaller than width*height*4");
    return JS_NewBool(ctx, self->sink && self->sink->uploadTexture(id, data, bytes, width, height, flags));
}
JSValue jsCanvasCommands(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    Impl* self = Impl::from(ctx);
    if (argc < 6) return JS_ThrowTypeError(ctx, "canvasCommands(id, width, height, ops, floats, strings)");
    std::uint32_t id = 0, width = 0, height = 0, floats = 0;
    if (JS_ToUint32(ctx, &id, argv[0]) < 0 || JS_ToUint32(ctx, &width, argv[1]) < 0 || JS_ToUint32(ctx, &height, argv[2]) < 0 ||
        JS_ToUint32(ctx, &floats, argv[4]) < 0)
        return JS_EXCEPTION;
    const float* ops = nullptr;
    std::size_t available = 0;
    if (!typedView(ctx, argv[3], ops, available, false, "canvas commands")) return JS_EXCEPTION;
    if (floats > available) return JS_ThrowRangeError(ctx, "canvasCommands: floats > array length");
    if (self->sink) self->sink->canvasCommands(id, width, height, ops, floats, argString(ctx, argv[5]));
    return JS_UNDEFINED;
}
JSValue jsCanvasRead(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    Impl* self = Impl::from(ctx);
    std::uint32_t id = 0, w = 0, h = 0;
    std::int32_t x = 0, y = 0;
    if (argc < 5 || JS_ToUint32(ctx, &id, argv[0]) < 0 || JS_ToInt32(ctx, &x, argv[1]) < 0 || JS_ToInt32(ctx, &y, argv[2]) < 0 ||
        JS_ToUint32(ctx, &w, argv[3]) < 0 || JS_ToUint32(ctx, &h, argv[4]) < 0)
        return JS_ThrowTypeError(ctx, "canvasRead(id, x, y, w, h)");
    if (w > 16384 || h > 16384) return JS_ThrowRangeError(ctx, "canvasRead: rectangle too large");
    std::vector<std::uint8_t> rgba;
    if (!self->sink || !self->sink->canvasRead(id, x, y, w, h, rgba)) return JS_NULL;
    return JS_NewArrayBufferCopy(ctx, rgba.data(), rgba.size());
}
JSValue jsCanvasWrite(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    Impl* self = Impl::from(ctx);
    std::uint32_t id = 0, cw = 0, ch = 0, w = 0, h = 0;
    std::int32_t x = 0, y = 0;
    if (argc < 8 || JS_ToUint32(ctx, &id, argv[0]) < 0 || JS_ToUint32(ctx, &cw, argv[1]) < 0 || JS_ToUint32(ctx, &ch, argv[2]) < 0 ||
        JS_ToInt32(ctx, &x, argv[3]) < 0 || JS_ToInt32(ctx, &y, argv[4]) < 0 || JS_ToUint32(ctx, &w, argv[5]) < 0 ||
        JS_ToUint32(ctx, &h, argv[6]) < 0)
        return JS_ThrowTypeError(ctx, "canvasWrite(id, canvasW, canvasH, x, y, w, h, rgba)");
    const std::uint8_t* data = nullptr;
    std::size_t bytes = 0;
    if (!typedView(ctx, argv[7], data, bytes, false, "pixels")) return JS_EXCEPTION;
    if (bytes < std::size_t(w) * h * 4) return JS_ThrowRangeError(ctx, "canvasWrite: pixel data smaller than w*h*4");
    if (self->sink) self->sink->canvasWrite(id, cw, ch, x, y, w, h, data);
    return JS_UNDEFINED;
}
JSValue jsRegisterImage(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    Impl* self = Impl::from(ctx);
    if (argc < 2) return JS_ThrowTypeError(ctx, "registerImage(key, bytes)");
    const std::uint8_t* data = nullptr;
    std::size_t bytes = 0;
    if (!typedView(ctx, argv[1], data, bytes, false, "image bytes")) return JS_EXCEPTION;
    if (self->sink) self->sink->registerImage(argString(ctx, argv[0]), data, bytes);
    return JS_UNDEFINED;
}
JSValue jsReleaseTexture(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    Impl* self = Impl::from(ctx);
    std::uint32_t id = 0;
    if (argc >= 1 && JS_ToUint32(ctx, &id, argv[0]) == 0 && self->sink) self->sink->releaseTexture(id);
    return JS_UNDEFINED;
}
JSValue jsUploadCanvasTexture(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    Impl* self = Impl::from(ctx);
    std::uint32_t id = 0, canvas = 0, flags = 0;
    if (argc < 3 || JS_ToUint32(ctx, &id, argv[0]) < 0 || JS_ToUint32(ctx, &canvas, argv[1]) < 0 || JS_ToUint32(ctx, &flags, argv[2]) < 0)
        return JS_ThrowTypeError(ctx, "uploadCanvasTexture(id, canvasId, flags)");
    return JS_NewBool(ctx, self->sink && self->sink->uploadCanvasTexture(id, canvas, flags));
}
JSValue jsReleaseGeometry(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    Impl* self = Impl::from(ctx);
    std::uint32_t id = 0;
    if (argc >= 1 && JS_ToUint32(ctx, &id, argv[0]) == 0 && self->sink) self->sink->releaseGeometry(id);
    return JS_UNDEFINED;
}
JSValue jsUploadInstances(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    Impl* self = Impl::from(ctx);
    if (argc < 4) return JS_ThrowTypeError(ctx, "uploadInstances(id, matrices, colors, count)");
    std::uint32_t id = 0, count = 0;
    if (JS_ToUint32(ctx, &id, argv[0]) < 0 || JS_ToUint32(ctx, &count, argv[3]) < 0) return JS_EXCEPTION;
    const float *matrices = nullptr, *colors = nullptr;
    std::size_t nMatrices = 0, nColors = 0;
    if (!typedView(ctx, argv[1], matrices, nMatrices, false, "matrices") ||
        !typedView(ctx, argv[2], colors, nColors, true, "colors"))
        return JS_EXCEPTION;
    if (nMatrices < std::size_t(count) * 16 || (colors && nColors < std::size_t(count) * 3))
        return JS_ThrowRangeError(ctx, "Instance buffers smaller than count");
    if (self->sink) self->sink->uploadInstances(id, matrices, colors, count);
    return JS_UNDEFINED;
}
JSValue jsReleaseInstances(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    Impl* self = Impl::from(ctx);
    std::uint32_t id = 0;
    if (argc >= 1 && JS_ToUint32(ctx, &id, argv[0]) == 0 && self->sink) self->sink->releaseInstances(id);
    return JS_UNDEFINED;
}
JSValue jsSubmitPass(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    Impl* self = Impl::from(ctx);
    if (argc < 2) return JS_ThrowTypeError(ctx, "submitPass(packet, floats)");
    const float* data = nullptr;
    std::size_t available = 0;
    std::uint32_t floats = 0;
    if (!typedView(ctx, argv[0], data, available, false, "packet") ||
        JS_ToUint32(ctx, &floats, argv[1]) < 0)
        return JS_EXCEPTION;
    if (floats > available || floats < kWebappPassHeaderFloats)
        return JS_ThrowRangeError(ctx, "submitPass: bad packet size");
    const std::size_t lights = static_cast<std::size_t>(data[35]);
    const std::size_t draws = static_cast<std::size_t>(data[43]);
    if (lights > kWebappMaxLights ||
        kWebappPassHeaderFloats + lights * kWebappLightFloats + draws * kWebappDrawFloats != floats)
        return JS_ThrowRangeError(ctx, "submitPass: header counts do not match packet size");
    if (self->sink) self->sink->submitPass(data, floats);
    return JS_UNDEFINED;
}

JSValue jsSubmitUi(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    Impl* self = Impl::from(ctx);
    if (argc < 3) return JS_ThrowTypeError(ctx, "submitUi(packet, floats, strings)");
    const float* data = nullptr;
    std::size_t available = 0;
    std::uint32_t floats = 0;
    if (!typedView(ctx, argv[0], data, available, false, "packet") || JS_ToUint32(ctx, &floats, argv[1]) < 0)
        return JS_EXCEPTION;
    if (floats > available || floats < webappUiHeaderFloats(data[0]) || webappUiHeaderFloats(data[0]) == 0) return JS_ThrowRangeError(ctx, "submitUi: bad packet");
    if (self->sink) self->sink->submitUi(data, floats, argString(ctx, argv[2]));
    return JS_UNDEFINED;
}
JSValue jsMeasureText(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    Impl* self = Impl::from(ctx);
    if (argc < 5 || !self->sink) return JS_NewFloat64(ctx, -1.0);
    double size = 16, weight = 400;
    JS_ToFloat64(ctx, &size, argv[1]);
    JS_ToFloat64(ctx, &weight, argv[2]);
    const bool italic = JS_ToBool(ctx, argv[3]) > 0;
    return JS_NewFloat64(ctx, self->sink->measureText(argString(ctx, argv[0]), size, int(weight), italic, argString(ctx, argv[4])));
}

JSValue jsReportUi(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    Impl* self = Impl::from(ctx);
    if (argc < 6 || !self->sink) return JS_UNDEFINED;
    double v[6] = {};
    for (int i = 0; i < 6; i++) JS_ToFloat64(ctx, &v[i], argv[i]);
    self->sink->reportUi(v[0], v[1], v[2], int(v[3]), int(v[4]), int(v[5]));
    return JS_UNDEFINED;
}
JSValue jsSetCursor(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    Impl* self = Impl::from(ctx);
    if (argc >= 1 && self->sink) self->sink->setCursor(argString(ctx, argv[0]));
    return JS_UNDEFINED;
}

char* moduleNormalize(JSContext* ctx, const char* base, const char* name, void*) {
    Impl* self = Impl::from(ctx);
    std::string error;
    const std::string resolved = webappResolveModule(base ? base : "index.html", name ? name : "",
                                                     self->importMap, self->builtinNames, error);
    if (resolved.empty()) {
        JS_ThrowReferenceError(ctx, "%s (imported from %s)", error.c_str(), base ? base : "?");
        return nullptr;
    }
    if (resolved == "nt:three" && name && std::strcmp(name, "three") != 0 &&
        std::strncmp(name, "nt:", 3) != 0 && self->warnedThreeImports.insert(name).second)
        self->log("warn", std::string("[NativeThreeBridge] '") + name +
                              "' replaced by the engine's built-in Three.js r181");
    return js_strdup(ctx, resolved.c_str());
}
JSModuleDef* moduleLoader(JSContext* ctx, const char* nameIn, void*) {
    Impl* self = Impl::from(ctx);
    const std::string name = nameIn;
    std::string source, error;
    if (startsWith(name, "nt:")) {
        auto it = self->builtins.find(name);
        if (it == self->builtins.end()) {
            JS_ThrowReferenceError(ctx, "Engine module %s is missing from this build", name.c_str());
            return nullptr;
        }
        source = it->second;
    } else {
        if (endsWith(toLower(name), ".json")) {
            JS_ThrowTypeError(ctx, "JSON modules are not supported yet: %s (use fetch)", name.c_str());
            return nullptr;
        }
        if (!self->readGameFile(name, source, error)) {
            JS_ThrowReferenceError(ctx, "%s", error.c_str());
            return nullptr;
        }
    }
    JSValue compiled = JS_Eval(ctx, source.c_str(), source.size(), name.c_str(),
                               JS_EVAL_TYPE_MODULE | JS_EVAL_FLAG_COMPILE_ONLY);
    if (JS_IsException(compiled)) return nullptr;
    if (setImportMeta(ctx, compiled, name) < 0) {
        JS_FreeValue(ctx, compiled);
        return nullptr;
    }
    JSModuleDef* m = static_cast<JSModuleDef*>(JS_VALUE_GET_PTR(compiled));
    JS_FreeValue(ctx, compiled); // the runtime keeps its own reference
    return m;
}
void rejectionTracker(JSContext* ctx, JSValueConst, JSValueConst reason, bool handled, void*) {
    if (handled) return;
    Impl* self = Impl::from(ctx);
    std::string text = argString(ctx, reason);
    if (JS_IsError(reason)) {
        JSValue stack = JS_GetPropertyStr(ctx, reason, "stack");
        const std::string s = argString(ctx, stack);
        if (!s.empty()) text += "\n" + s;
        JS_FreeValue(ctx, stack);
    }
    self->log("warn", "Unhandled promise rejection: " + text);
}

} // namespace

WebappHost::WebappHost() : impl_(std::make_unique<Impl>()) {}
WebappHost::~WebappHost() { shutdown(); }

bool WebappHost::running() const { return impl_ && impl_->started; }

bool WebappHost::start(const std::filesystem::path& root, const std::string& shimSource,
                       std::vector<WebappBuiltin> builtins, WebappRenderSink* sink,
                       int width, int height, std::string& error, const WebappPage& page) {
    shutdown();
    Impl& s = *impl_;
    s.root = root;
    s.sink = sink;
    s.builtins.clear();
    s.builtinNames.clear();
    for (auto& b : builtins) {
        s.builtinNames.push_back(b.name);
        s.builtins[b.name] = std::move(b.source);
    }
    s.builtins["nt:three"] = webappThreeModuleSource();
    s.builtinNames.push_back("nt:three");
    for (const char* required : {"nt:three.core.min.js", "nt:three.module.min.js", "nt:native-renderer.mjs"}) {
        if (!s.builtins.count(required)) { error = std::string("Engine build is missing ") + required; return false; }
    }

    std::string html;
    if (!s.readGameFile("index.html", html, error)) {
        error = "No index.html in " + webappPathUtf8(root) + " (" + error + ")";
        return false;
    }

    s.rt = JS_NewRuntime();
    if (!s.rt) { error = "Cannot create QuickJS runtime"; return false; }
    JS_SetMemoryLimit(s.rt, 1024ULL * 1024ULL * 1024ULL);
    // The game/smoke EXEs reserve a 64 MB main-thread stack (CMake /STACK);
    // QuickJS throws a catchable RangeError well before that is exhausted.
    JS_SetMaxStackSize(s.rt, 48ULL * 1024ULL * 1024ULL);
    JS_SetModuleLoaderFunc(s.rt, moduleNormalize, moduleLoader, nullptr);
    JS_SetHostPromiseRejectionTracker(s.rt, rejectionTracker, nullptr);
    s.ctx = JS_NewContext(s.rt);
    if (!s.ctx) { error = "Cannot create QuickJS context"; shutdown(); return false; }
    JS_SetContextOpaque(s.ctx, &s);

    JSValue global = JS_GetGlobalObject(s.ctx);
    JSValue api = JS_NewObject(s.ctx);
    struct Fn { const char* name; JSCFunction* fn; int length; };
    const Fn functions[] = {
        {"requestReload", jsRequestReload, 2}, {"log", jsLog, 2}, {"setTitle", jsSetTitle, 1},
        {"readText", jsReadText, 1}, {"readBinary", jsReadBinary, 1},
        {"setImportMap", jsSetImportMap, 1},
        {"evalScript", jsEvalScript, 2}, {"evalModule", jsEvalModule, 2},
        {"uploadGeometry", jsUploadGeometry, 6}, {"releaseGeometry", jsReleaseGeometry, 1},
        {"uploadInstances", jsUploadInstances, 4}, {"releaseInstances", jsReleaseInstances, 1},
        {"uploadTexture", jsUploadTexture, 5}, {"releaseTexture", jsReleaseTexture, 1},
        {"uploadCanvasTexture", jsUploadCanvasTexture, 3},
        {"canvasCommands", jsCanvasCommands, 6}, {"canvasRead", jsCanvasRead, 5}, {"canvasWrite", jsCanvasWrite, 8},
        {"registerImage", jsRegisterImage, 2},
        {"submitPass", jsSubmitPass, 2},
        {"submitUi", jsSubmitUi, 3}, {"measureText", jsMeasureText, 5}, {"setCursor", jsSetCursor, 1}, {"reportUi", jsReportUi, 6},
    };
    for (const Fn& f : functions)
        JS_SetPropertyStr(s.ctx, api, f.name, JS_NewCFunction(s.ctx, f.fn, f.name, f.length));
    JS_SetPropertyStr(s.ctx, global, "__nt", api);

    JSValue result = JS_Eval(s.ctx, shimSource.c_str(), shimSource.size(), "nt:webapp-shim.js",
                             JS_EVAL_TYPE_GLOBAL);
    if (JS_IsException(result)) {
        error = "Webapp shim failed: " + s.exceptionText();
        JS_FreeValue(s.ctx, global);
        shutdown();
        return false;
    }
    JS_FreeValue(s.ctx, result);
    s.hostObject = JS_GetPropertyStr(s.ctx, global, "__ntHost");
    JS_FreeValue(s.ctx, global);
    if (!JS_IsObject(s.hostObject)) { error = "Webapp shim did not install __ntHost"; shutdown(); return false; }
    s.started = true;

    resize(width, height, 1.0);
    JSValue args[] = {JS_NewStringLen(s.ctx, html.data(), html.size()),
                      JS_NewStringLen(s.ctx, page.url.data(), page.url.size()),
                      JS_NewStringLen(s.ctx, page.storage.data(), page.storage.size())};
    s.callHost("boot", 3, args);
    return true;
}

void WebappHost::shutdown() {
    if (!impl_) return;
    Impl& s = *impl_;
    if (s.ctx) {
        JS_FreeValue(s.ctx, s.hostObject);
        s.hostObject = JS_UNDEFINED;
        JS_FreeContext(s.ctx);
        s.ctx = nullptr;
    }
    if (s.rt) {
        JS_FreeRuntime(s.rt);
        s.rt = nullptr;
    }
    s.started = false;
    s.reload.reset();
}

std::optional<WebappPage> WebappHost::takeReload() {
    auto page = std::move(impl_->reload);
    impl_->reload.reset();
    return page;
}

void WebappHost::resize(int width, int height, double pixelRatio) {
    if (!running()) return;
    JSContext* c = impl_->ctx;
    JSValue args[3] = {JS_NewInt32(c, std::max(1, width)), JS_NewInt32(c, std::max(1, height)),
                       JS_NewFloat64(c, pixelRatio)};
    impl_->callHost("resize", 3, args);
}
void WebappHost::frame(double timeMs, bool uiTick) {
    if (!running()) return;
    JSValue args[2] = {JS_NewFloat64(impl_->ctx, timeMs), JS_NewBool(impl_->ctx, uiTick)};
    impl_->callHost("frame", 2, args);
}
void WebappHost::key(bool down, const std::string& key, const std::string& code, bool repeat,
                     bool alt, bool ctrl, bool shift, bool meta) {
    if (!running()) return;
    JSContext* c = impl_->ctx;
    JSValue args[8] = {JS_NewBool(c, down), JS_NewString(c, key.c_str()), JS_NewString(c, code.c_str()),
                       JS_NewBool(c, repeat), JS_NewBool(c, alt), JS_NewBool(c, ctrl),
                       JS_NewBool(c, shift), JS_NewBool(c, meta)};
    impl_->callHost("key", 8, args);
}
void WebappHost::pointer(const char* kind, double x, double y, int button) {
    if (!running()) return;
    JSContext* c = impl_->ctx;
    JSValue args[4] = {JS_NewString(c, kind), JS_NewFloat64(c, x), JS_NewFloat64(c, y), JS_NewInt32(c, button)};
    impl_->callHost("pointer", 4, args);
}
void WebappHost::wheel(double x, double y, double deltaX, double deltaY) {
    if (!running()) return;
    JSContext* c = impl_->ctx;
    JSValue args[4] = {JS_NewFloat64(c, x), JS_NewFloat64(c, y), JS_NewFloat64(c, deltaX), JS_NewFloat64(c, deltaY)};
    impl_->callHost("wheel", 4, args);
}
void WebappHost::focus(bool focused) {
    if (!running()) return;
    JSValue arg = JS_NewBool(impl_->ctx, focused);
    impl_->callHost("focus", 1, &arg);
}
std::string WebappHost::statusJson() {
    if (!running()) return "{}";
    Impl& s = *impl_;
    JSValue fn = JS_GetPropertyStr(s.ctx, s.hostObject, "status");
    JSValue result = JS_Call(s.ctx, fn, s.hostObject, 0, nullptr);
    JS_FreeValue(s.ctx, fn);
    if (JS_IsException(result)) {
        s.log("error", "status(): " + s.exceptionText());
        return "{}";
    }
    std::string out = argString(s.ctx, result);
    JS_FreeValue(s.ctx, result);
    return out;
}

const char* webappEngineName() { return "QuickJS-NG"; }

} // namespace native_three
