// V8 (JIT) backend for the webapp runtime. Same WebappHost API, shim,
// NativeRenderer and module rules as the QuickJS backend (webapp_host.cpp);
// only the JavaScript engine differs. Rendering stays in the engine's DX12
// renderer: V8 only runs the game's JavaScript.
// Compiled as C++20 (required by V8 13 headers).
#include "webapp_host.h"

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#else
#include <unistd.h>
#endif

#include <algorithm>
#include <cstring>
#include <cstdlib>
#include <fstream>
#include <map>
#include <memory>
#include <mutex>
#include <set>
#include <type_traits>
#include <unordered_map>

#include <libplatform/libplatform.h>
#include <v8.h>

namespace native_three {
namespace {

std::unique_ptr<v8::Platform> gPlatform;
v8::ArrayBuffer::Allocator* gAllocator = nullptr;
std::once_flag gV8Once;
std::string gEngineName = "V8";

void initializeV8Once() {
    std::call_once(gV8Once, [] {
#ifdef _WIN32
        wchar_t wide[MAX_PATH] = {};
        GetModuleFileNameW(nullptr, wide, MAX_PATH);
        char exe[MAX_PATH * 3] = {};
        WideCharToMultiByte(CP_UTF8, 0, wide, -1, exe, sizeof exe, nullptr, nullptr);
#else
        char exe[4096] = {};
        if (readlink("/proc/self/exe", exe, sizeof exe - 1) < 0) exe[0] = 0;
#endif
        // icudtl.dat and an optional snapshot_blob.bin live beside the EXE.
        v8::V8::InitializeICUDefaultLocation(exe);
        v8::V8::InitializeExternalStartupData(exe);
        gPlatform = v8::platform::NewDefaultPlatform();
        v8::V8::InitializePlatform(gPlatform.get());
        v8::V8::Initialize();
        gAllocator = v8::ArrayBuffer::Allocator::NewDefaultAllocator();
        gEngineName = std::string("V8 ") + v8::V8::GetVersion();
    });
}

bool startsWith(const std::string& s, const char* prefix) {
    const std::size_t n = std::strlen(prefix);
    return s.size() >= n && s.compare(0, n, prefix) == 0;
}
bool endsWithJson(const std::string& s) {
    if (s.size() < 5) return false;
    std::string tail = s.substr(s.size() - 5);
    for (char& c : tail) c = char(std::tolower(static_cast<unsigned char>(c)));
    return tail == ".json";
}

} // namespace

struct WebappHost::Impl {
    v8::Isolate* isolate = nullptr;
    v8::Global<v8::Context> context;
    v8::Global<v8::Object> hostObject;
    v8::Global<v8::Function> afterHelper; // (promise, namespace) => promise.then(() => namespace)
    std::filesystem::path root;
    std::map<std::string, std::string> builtins;
    std::vector<std::string> builtinNames;
    std::vector<std::string> importMap;
    std::set<std::string> warnedThreeImports;
    std::map<std::string, v8::Global<v8::Module>> modules;          // name -> module
    std::unordered_multimap<int, std::string> moduleNames;           // identity hash -> name
    WebappRenderSink* sink = nullptr;
    bool started = false;
    std::optional<WebappPage> reload;

    static Impl* fromContext(v8::Local<v8::Context> ctx) {
        return static_cast<Impl*>(ctx->GetAlignedPointerFromEmbedderData(1));
    }
    static Impl* fromInfo(const v8::FunctionCallbackInfo<v8::Value>& info) {
        return static_cast<Impl*>(info.Data().As<v8::External>()->Value());
    }
    void log(const std::string& level, const std::string& text) {
        if (sink) sink->log(level, text);
    }
    v8::Local<v8::String> str(const std::string& s) {
        return v8::String::NewFromUtf8(isolate, s.data(), v8::NewStringType::kNormal, int(s.size())).ToLocalChecked();
    }
    std::string utf8(v8::Local<v8::Value> v) {
        v8::String::Utf8Value u(isolate, v);
        return *u ? std::string(*u, u.length()) : std::string();
    }
    std::string exceptionText(v8::TryCatch& tc) {
        v8::Local<v8::Context> ctx = isolate->GetCurrentContext();
        std::string out = utf8(tc.Exception());
        v8::Local<v8::Value> stack;
        if (tc.StackTrace(ctx).ToLocal(&stack) && stack->IsString()) {
            const std::string s = utf8(stack);
            if (!s.empty() && s != out) out += "\n" + s;
        } else if (!tc.Message().IsEmpty()) {
            v8::Local<v8::Message> m = tc.Message();
            out += " (" + utf8(m->GetScriptResourceName()) + ":" + std::to_string(m->GetLineNumber(ctx).FromMaybe(0)) + ")";
        }
        return out;
    }
    void throwError(const std::string& kind, const std::string& message) {
        v8::Local<v8::String> m = str(message);
        isolate->ThrowException(kind == "type" ? v8::Exception::TypeError(m)
                               : kind == "range" ? v8::Exception::RangeError(m)
                                                 : v8::Exception::ReferenceError(m));
    }
    std::string nameOf(v8::Local<v8::Module> module) {
        auto range = moduleNames.equal_range(module->GetIdentityHash());
        for (auto it = range.first; it != range.second; ++it) {
            auto found = modules.find(it->second);
            if (found != modules.end() && found->second.Get(isolate) == module) return it->second;
        }
        return "index.html";
    }
    // Compiles (or returns the cached) module `name`. Throws on failure.
    v8::MaybeLocal<v8::Module> loadModule(const std::string& name) {
        auto cached = modules.find(name);
        if (cached != modules.end()) return cached->second.Get(isolate);
        std::string source, error;
        if (startsWith(name, "nt:")) {
            auto it = builtins.find(name);
            if (it == builtins.end()) { throwError("reference", "Engine module " + name + " is missing from this build"); return {}; }
            source = it->second;
        } else {
            if (endsWithJson(name)) { throwError("type", "JSON modules are not supported yet: " + name + " (use fetch)"); return {}; }
            if (!webappReadGameFile(root, name, source, error)) { throwError("reference", error); return {}; }
        }
        return compileModule(source, name);
    }
    v8::MaybeLocal<v8::Module> compileModule(const std::string& source, const std::string& name) {
        v8::ScriptOrigin origin(str(name), 0, 0, false, -1, v8::Local<v8::Value>(), false, false, true);
        v8::ScriptCompiler::Source src(str(source), origin);
        v8::Local<v8::Module> module;
        if (!v8::ScriptCompiler::CompileModule(isolate, &src).ToLocal(&module)) return {};
        modules[name].Reset(isolate, module);
        moduleNames.emplace(module->GetIdentityHash(), name);
        return module;
    }
    std::string resolve(const std::string& base, const std::string& specifier) {
        std::string error;
        const std::string resolved = webappResolveModule(base, specifier, importMap, builtinNames, error);
        if (resolved.empty()) {
            throwError("reference", error + " (imported from " + base + ")");
            return {};
        }
        if (resolved == "nt:three" && specifier != "three" && !startsWith(specifier, "nt:") &&
            warnedThreeImports.insert(specifier).second)
            log("warn", "[NativeThreeBridge] '" + specifier + "' replaced by the engine's built-in Three.js r181");
        return resolved;
    }
    // Instantiate + evaluate; returns the evaluation promise.
    v8::MaybeLocal<v8::Value> run(v8::Local<v8::Context> ctx, v8::Local<v8::Module> module);
    void microtasks() {
        isolate->PerformMicrotaskCheckpoint();
        while (v8::platform::PumpMessageLoop(gPlatform.get(), isolate)) isolate->PerformMicrotaskCheckpoint();
    }
    void callHost(const char* name, int argc, v8::Local<v8::Value>* argv) {
        if (!started) return;
        v8::Local<v8::Context> ctx = context.Get(isolate);
        v8::TryCatch tc(isolate);
        v8::Local<v8::Object> host = hostObject.Get(isolate);
        v8::Local<v8::Value> fn;
        if (host->Get(ctx, str(name)).ToLocal(&fn) && fn->IsFunction()) {
            v8::Local<v8::Value> result;
            if (!fn.As<v8::Function>()->Call(ctx, host, argc, argv).ToLocal(&result) && tc.HasCaught())
                log("error", std::string("__ntHost.") + name + ": " + exceptionText(tc));
        }
        microtasks();
    }
};

namespace {
using Impl = WebappHost::Impl;

v8::MaybeLocal<v8::Module> resolveCallback(v8::Local<v8::Context> ctx, v8::Local<v8::String> specifier,
                                           v8::Local<v8::FixedArray>, v8::Local<v8::Module> referrer) {
    Impl* self = Impl::fromContext(ctx);
    const std::string name = self->resolve(self->nameOf(referrer), self->utf8(specifier));
    if (name.empty()) return {};
    return self->loadModule(name);
}

} // namespace

v8::MaybeLocal<v8::Value> Impl::run(v8::Local<v8::Context> ctx, v8::Local<v8::Module> module) {
    if (module->GetStatus() == v8::Module::kUninstantiated &&
        !module->InstantiateModule(ctx, resolveCallback).FromMaybe(false))
        return {};
    return module->Evaluate(ctx);
}

namespace {

void importMeta(v8::Local<v8::Context> ctx, v8::Local<v8::Module> module, v8::Local<v8::Object> meta) {
    Impl* self = Impl::fromContext(ctx);
    std::string name = self->nameOf(module), url;
    if (startsWith(name, "nt:")) url = name;
    else {
        const std::size_t hash = name.find('#');
        url = "nt://game/" + (hash == std::string::npos ? name : name.substr(0, hash));
    }
    meta->CreateDataProperty(ctx, self->str("url"), self->str(url)).Check();
    meta->CreateDataProperty(ctx, self->str("main"), v8::False(self->isolate)).Check();
}

v8::MaybeLocal<v8::Promise> dynamicImport(v8::Local<v8::Context> ctx, v8::Local<v8::Data>,
                                          v8::Local<v8::Value> resourceName, v8::Local<v8::String> specifier,
                                          v8::Local<v8::FixedArray>) {
    Impl* self = Impl::fromContext(ctx);
    v8::Isolate* isolate = self->isolate;
    v8::EscapableHandleScope scope(isolate);
    v8::Local<v8::Promise::Resolver> resolver = v8::Promise::Resolver::New(ctx).ToLocalChecked();
    v8::TryCatch tc(isolate);
    std::string base = resourceName->IsString() ? self->utf8(resourceName) : "index.html";
    if (base.empty() || startsWith(base, "nt:webapp-shim")) base = "index.html";
    const std::string name = self->resolve(base, self->utf8(specifier));
    v8::Local<v8::Module> module;
    v8::Local<v8::Value> evaluation;
    if (!name.empty() && self->loadModule(name).ToLocal(&module) && self->run(ctx, module).ToLocal(&evaluation)) {
        v8::Local<v8::Value> args[2] = {evaluation, module->GetModuleNamespace()};
        v8::Local<v8::Value> chained;
        if (self->afterHelper.Get(isolate)->Call(ctx, v8::Undefined(isolate), 2, args).ToLocal(&chained))
            resolver->Resolve(ctx, chained).Check();
    }
    if (tc.HasCaught()) resolver->Reject(ctx, tc.Exception()).Check();
    return scope.Escape(resolver->GetPromise());
}

void rejectionCallback(v8::PromiseRejectMessage message) {
    if (message.GetEvent() != v8::kPromiseRejectWithNoHandler) return;
    v8::Isolate* isolate = v8::Isolate::GetCurrent();
    v8::Local<v8::Context> ctx = isolate->GetCurrentContext();
    if (ctx.IsEmpty()) return;
    Impl* self = Impl::fromContext(ctx);
    std::string text = self->utf8(message.GetValue());
    if (message.GetValue()->IsNativeError()) {
        v8::Local<v8::Value> stack;
        if (message.GetValue().As<v8::Object>()->Get(ctx, self->str("stack")).ToLocal(&stack) && stack->IsString())
            text = self->utf8(stack);
    }
    self->log("warn", "Unhandled promise rejection: " + text);
}

// Typed array view; optional arrays may be null/undefined.
template <typename T>
bool typedView(Impl* self, v8::Local<v8::Value> value, const T*& data, std::size_t& count, bool optional, const char* what) {
    data = nullptr;
    count = 0;
    if (optional && (value->IsNull() || value->IsUndefined())) return true;
    if (!value->IsTypedArray()) { self->throwError("type", std::string(what) + ": typed array expected"); return false; }
    v8::Local<v8::TypedArray> array = value.As<v8::TypedArray>();
    const bool ok = std::is_same_v<T, std::uint8_t> ? (array->IsUint8Array() || array->IsUint8ClampedArray())
                  : sizeof(T) == 4 && (std::is_same_v<T, float> ? array->IsFloat32Array() : array->IsUint32Array());
    if (!ok) { self->throwError("type", std::string(what) + ": wrong typed array type"); return false; }
    v8::Local<v8::ArrayBuffer> buffer = array->Buffer();
    data = reinterpret_cast<const T*>(static_cast<const std::uint8_t*>(buffer->Data()) + array->ByteOffset());
    count = array->ByteLength() / sizeof(T);
    return true;
}

#ifdef _WIN32
constexpr std::size_t kStorageLimit = 128 * 1024 * 1024;

std::filesystem::path storagePath(Impl* self, v8::Local<v8::Value> key) {
    const std::string name = self->utf8(key);
    if (name.empty() || name.size() > 96) {
        self->throwError("range", "Invalid web storage name");
        return {};
    }
    static constexpr char hex[] = "0123456789abcdef";
    std::string file;
    for (const unsigned char c : name) {
        file += hex[c >> 4];
        file += hex[c & 15];
    }
    auto root = self->root.lexically_normal();
    if (root.filename().empty()) root = root.parent_path();
    auto directory = root;
    directory += L".native-storage";
    return directory / (file + ".bin");
}

v8::MaybeLocal<v8::Value> decodeStorage(v8::Local<v8::Context> ctx, const uint8_t* bytes, std::size_t size) {
    v8::ValueDeserializer decoder(ctx->GetIsolate(), bytes, size);
    if (!decoder.ReadHeader(ctx).FromMaybe(false)) return {};
    return decoder.ReadValue(ctx);
}

v8::MaybeLocal<v8::Value> readStorage(Impl* self, const std::filesystem::path& path) {
    std::error_code ec;
    const auto size = std::filesystem::file_size(path, ec);
    if (ec == std::errc::no_such_file_or_directory) return v8::Undefined(self->isolate);
    if (ec || size > kStorageLimit) {
        self->throwError("range", "Cannot read web storage");
        return {};
    }
    std::vector<uint8_t> bytes(static_cast<std::size_t>(size));
    std::ifstream file(path, std::ios::binary);
    if (!file.read(reinterpret_cast<char*>(bytes.data()), bytes.size())) {
        self->throwError("range", "Cannot read web storage");
        return {};
    }
    return decodeStorage(self->isolate->GetCurrentContext(), bytes.data(), bytes.size());
}

void ntStorageRead(const v8::FunctionCallbackInfo<v8::Value>& info) {
    auto* self = Impl::fromInfo(info);
    const auto path = storagePath(self, info[0]);
    if (path.empty()) return;
    v8::Local<v8::Value> value;
    if (readStorage(self, path).ToLocal(&value))
        info.GetReturnValue().Set(value);
}

void ntStorageWrite(const v8::FunctionCallbackInfo<v8::Value>& info) {
    auto* self = Impl::fromInfo(info);
    const auto path = storagePath(self, info[0]);
    if (path.empty()) return;
    v8::ValueSerializer encoder(info.GetIsolate());
    encoder.WriteHeader();
    if (!encoder.WriteValue(info.GetIsolate()->GetCurrentContext(), info[1]).FromMaybe(false)) return;
    const auto [bytes, size] = encoder.Release();
    std::unique_ptr<uint8_t, decltype(&std::free)> buffer(bytes, &std::free);
    if (size > kStorageLimit) return self->throwError("range", "Web storage quota exceeded");
    std::error_code ec;
    const auto dir = path.parent_path();
    std::filesystem::create_directories(dir, ec);
    if (ec) return self->throwError("range", "Cannot create web storage directory");
    auto lockPath = path;
    lockPath += L".lock";
    const HANDLE handle = CreateFileW(lockPath.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_ALWAYS,
                                      FILE_ATTRIBUTE_NORMAL, nullptr);
    if (handle == INVALID_HANDLE_VALUE) return self->throwError("range", "Web storage is busy");
    const std::unique_ptr<void, decltype(&CloseHandle)> lock(handle, &CloseHandle);
    if (info[2]->IsNumber()) {
        auto ctx = info.GetIsolate()->GetCurrentContext();
        v8::Local<v8::Value> current;
        if (!readStorage(self, path).ToLocal(&current)) return;
        v8::Local<v8::Value> revision = v8::Integer::New(info.GetIsolate(), 0);
        if (current->IsObject() && !current.As<v8::Object>()->Get(ctx, self->str("revision")).ToLocal(&revision)) return;
        if (!revision->StrictEquals(info[2])) return self->throwError("range", "Web storage changed in another window");
    }
    wchar_t temp[MAX_PATH];
    if (!GetTempFileNameW(dir.c_str(), L"ntw", 0, temp))
        return self->throwError("range", "Cannot create web storage file");
    std::ofstream file(std::filesystem::path(temp), std::ios::binary | std::ios::trunc);
    file.write(reinterpret_cast<const char*>(bytes), size);
    file.close();
    if (!file || !MoveFileExW(temp, path.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
        DeleteFileW(temp);
        return self->throwError("range", "Cannot commit web storage");
    }
}

void ntStorageClone(const v8::FunctionCallbackInfo<v8::Value>& info) {
    auto ctx = info.GetIsolate()->GetCurrentContext();
    v8::ValueSerializer encoder(info.GetIsolate());
    encoder.WriteHeader();
    if (!encoder.WriteValue(ctx, info[0]).FromMaybe(false)) return;
    const auto [bytes, size] = encoder.Release();
    std::unique_ptr<uint8_t, decltype(&std::free)> buffer(bytes, &std::free);
    v8::Local<v8::Value> clone;
    if (decodeStorage(ctx, bytes, size).ToLocal(&clone)) info.GetReturnValue().Set(clone);
}
#endif

void ntRequestReload(const v8::FunctionCallbackInfo<v8::Value>& info) {
    auto* self = Impl::fromInfo(info);
    if (info.Length() >= 2) self->reload = WebappPage{self->utf8(info[0]), self->utf8(info[1])};
}

void ntLog(const v8::FunctionCallbackInfo<v8::Value>& info) {
    Impl* self = Impl::fromInfo(info);
    if (info.Length() >= 2) self->log(self->utf8(info[0]), self->utf8(info[1]));
}
void ntSetTitle(const v8::FunctionCallbackInfo<v8::Value>& info) {
    Impl* self = Impl::fromInfo(info);
    if (info.Length() >= 1 && self->sink) self->sink->setTitle(self->utf8(info[0]));
}
void ntReadText(const v8::FunctionCallbackInfo<v8::Value>& info) {
    Impl* self = Impl::fromInfo(info);
    std::string data, error;
    if (info.Length() < 1 || !webappReadGameFile(self->root, self->utf8(info[0]), data, error))
        return self->throwError("reference", error.empty() ? "readText(path)" : error);
    info.GetReturnValue().Set(self->str(data));
}
void ntReadBinary(const v8::FunctionCallbackInfo<v8::Value>& info) {
    Impl* self = Impl::fromInfo(info);
    std::string data, error;
    if (info.Length() < 1 || !webappReadGameFile(self->root, self->utf8(info[0]), data, error))
        return self->throwError("reference", error.empty() ? "readBinary(path)" : error);
    std::unique_ptr<v8::BackingStore> store = v8::ArrayBuffer::NewBackingStore(self->isolate, data.size());
    if (!data.empty()) std::memcpy(store->Data(), data.data(), data.size());
    info.GetReturnValue().Set(v8::ArrayBuffer::New(self->isolate, std::move(store)));
}
void ntSetImportMap(const v8::FunctionCallbackInfo<v8::Value>& info) {
    Impl* self = Impl::fromInfo(info);
    self->importMap.clear();
    if (info.Length() < 1 || !info[0]->IsArray()) return;
    v8::Local<v8::Context> ctx = self->isolate->GetCurrentContext();
    v8::Local<v8::Array> list = info[0].As<v8::Array>();
    for (uint32_t i = 0; i + 1 < list->Length() && i < 4096; i += 2) {
        self->importMap.push_back(self->utf8(list->Get(ctx, i).ToLocalChecked()));
        self->importMap.push_back(self->utf8(list->Get(ctx, i + 1).ToLocalChecked()));
    }
}
void ntEvalScript(const v8::FunctionCallbackInfo<v8::Value>& info) {
    Impl* self = Impl::fromInfo(info);
    if (info.Length() < 2) return self->throwError("type", "evalScript(source, name)");
    v8::Local<v8::Context> ctx = self->isolate->GetCurrentContext();
    v8::ScriptOrigin origin(info[1]);
    v8::Local<v8::Script> script;
    v8::Local<v8::Value> result;
    if (!info[0]->IsString()) return self->throwError("type", "evalScript: source must be a string");
    if (v8::Script::Compile(ctx, info[0].As<v8::String>(), &origin).ToLocal(&script) && script->Run(ctx).ToLocal(&result))
        info.GetReturnValue().Set(result);
}
void ntEvalModule(const v8::FunctionCallbackInfo<v8::Value>& info) {
    Impl* self = Impl::fromInfo(info);
    if (info.Length() < 2) return self->throwError("type", "evalModule(source, name)");
    v8::Local<v8::Context> ctx = self->isolate->GetCurrentContext();
    v8::Local<v8::Module> module;
    v8::Local<v8::Value> evaluation;
    if (self->compileModule(self->utf8(info[0]), self->utf8(info[1])).ToLocal(&module) &&
        self->run(ctx, module).ToLocal(&evaluation))
        info.GetReturnValue().Set(evaluation);
}
void ntUploadGeometry(const v8::FunctionCallbackInfo<v8::Value>& info) {
    Impl* self = Impl::fromInfo(info);
    if (info.Length() < 5) return self->throwError("type", "uploadGeometry(id, positions, normals, colors, indices, uvs)");
    v8::Local<v8::Context> ctx = self->isolate->GetCurrentContext();
    const std::uint32_t id = info[0]->Uint32Value(ctx).FromMaybe(0);
    const float *positions, *normals, *colors, *uvs = nullptr;
    const std::uint32_t* indices;
    std::size_t nP, nN, nC, nI, nU = 0;
    if (!typedView(self, info[1], positions, nP, false, "positions") || !typedView(self, info[2], normals, nN, true, "normals") ||
        !typedView(self, info[3], colors, nC, true, "colors") || !typedView(self, info[4], indices, nI, true, "indices") ||
        (info.Length() >= 6 && !typedView(self, info[5], uvs, nU, true, "uvs")))
        return;
    if (nP % 3 || (normals && nN != nP) || (colors && nC != nP && nC != nP / 3 * 4))
        return self->throwError("range", "Geometry attributes must be 3 floats per vertex (colours 3 or 4) and equal length");
    const std::uint32_t vertexCount = std::uint32_t(nP / 3);
    const std::uint32_t colorChannels = colors && nC != nP ? 4 : 3;
    if (uvs && nU != std::size_t(vertexCount) * 2) return self->throwError("range", "Geometry uvs must be 2 floats per vertex");
    for (std::size_t i = 0; i < nI; i++)
        if (indices[i] >= vertexCount) return self->throwError("range", "Geometry index out of range");
    if (self->sink) self->sink->uploadGeometry(id, positions, normals, colors, vertexCount, indices, std::uint32_t(nI), uvs, colorChannels);
}
void ntUploadTexture(const v8::FunctionCallbackInfo<v8::Value>& info) {
    Impl* self = Impl::fromInfo(info);
    if (info.Length() < 5) return self->throwError("type", "uploadTexture(id, bytes, width, height, flags)");
    v8::Local<v8::Context> ctx = self->isolate->GetCurrentContext();
    const std::uint32_t id = info[0]->Uint32Value(ctx).FromMaybe(0), width = info[2]->Uint32Value(ctx).FromMaybe(0),
                        height = info[3]->Uint32Value(ctx).FromMaybe(0), flags = info[4]->Uint32Value(ctx).FromMaybe(0);
    const std::uint8_t* data;
    std::size_t bytes;
    if (!typedView(self, info[1], data, bytes, false, "texture data")) return;
    if (width && (height == 0 || bytes < std::size_t(width) * height * 4))
        return self->throwError("range", "uploadTexture: pixel data smaller than width*height*4");
    info.GetReturnValue().Set(bool(self->sink && self->sink->uploadTexture(id, data, bytes, width, height, flags)));
}
void ntCanvasCommands(const v8::FunctionCallbackInfo<v8::Value>& info) {
    Impl* self = Impl::fromInfo(info);
    if (info.Length() < 6) return self->throwError("type", "canvasCommands(id, width, height, ops, floats, strings)");
    v8::Local<v8::Context> ctx = self->isolate->GetCurrentContext();
    const std::uint32_t id = info[0]->Uint32Value(ctx).FromMaybe(0), width = info[1]->Uint32Value(ctx).FromMaybe(0),
                        height = info[2]->Uint32Value(ctx).FromMaybe(0), floats = info[4]->Uint32Value(ctx).FromMaybe(0);
    const float* ops;
    std::size_t available;
    if (!typedView(self, info[3], ops, available, false, "canvas commands")) return;
    if (floats > available) return self->throwError("range", "canvasCommands: floats > array length");
    if (self->sink) self->sink->canvasCommands(id, width, height, ops, floats, self->utf8(info[5]));
}
void ntCanvasRead(const v8::FunctionCallbackInfo<v8::Value>& info) {
    Impl* self = Impl::fromInfo(info);
    if (info.Length() < 5) return self->throwError("type", "canvasRead(id, x, y, w, h)");
    v8::Local<v8::Context> ctx = self->isolate->GetCurrentContext();
    const std::uint32_t id = info[0]->Uint32Value(ctx).FromMaybe(0), w = info[3]->Uint32Value(ctx).FromMaybe(0),
                        h = info[4]->Uint32Value(ctx).FromMaybe(0);
    const std::int32_t x = info[1]->Int32Value(ctx).FromMaybe(0), y = info[2]->Int32Value(ctx).FromMaybe(0);
    if (w > 16384 || h > 16384) return self->throwError("range", "canvasRead: rectangle too large");
    std::vector<std::uint8_t> rgba;
    if (!self->sink || !self->sink->canvasRead(id, x, y, w, h, rgba)) { info.GetReturnValue().SetNull(); return; }
    std::unique_ptr<v8::BackingStore> store = v8::ArrayBuffer::NewBackingStore(self->isolate, rgba.size());
    if (!rgba.empty()) std::memcpy(store->Data(), rgba.data(), rgba.size());
    info.GetReturnValue().Set(v8::ArrayBuffer::New(self->isolate, std::move(store)));
}
void ntCanvasWrite(const v8::FunctionCallbackInfo<v8::Value>& info) {
    Impl* self = Impl::fromInfo(info);
    if (info.Length() < 8) return self->throwError("type", "canvasWrite(id, canvasW, canvasH, x, y, w, h, rgba)");
    v8::Local<v8::Context> ctx = self->isolate->GetCurrentContext();
    const std::uint32_t id = info[0]->Uint32Value(ctx).FromMaybe(0), cw = info[1]->Uint32Value(ctx).FromMaybe(0),
                        ch = info[2]->Uint32Value(ctx).FromMaybe(0), w = info[5]->Uint32Value(ctx).FromMaybe(0),
                        h = info[6]->Uint32Value(ctx).FromMaybe(0);
    const std::int32_t x = info[3]->Int32Value(ctx).FromMaybe(0), y = info[4]->Int32Value(ctx).FromMaybe(0);
    const std::uint8_t* data;
    std::size_t bytes;
    if (!typedView(self, info[7], data, bytes, false, "pixels")) return;
    if (bytes < std::size_t(w) * h * 4) return self->throwError("range", "canvasWrite: pixel data smaller than w*h*4");
    if (self->sink) self->sink->canvasWrite(id, cw, ch, x, y, w, h, data);
}
void ntRegisterImage(const v8::FunctionCallbackInfo<v8::Value>& info) {
    Impl* self = Impl::fromInfo(info);
    if (info.Length() < 2) return self->throwError("type", "registerImage(key, bytes)");
    const std::uint8_t* data;
    std::size_t bytes;
    if (!typedView(self, info[1], data, bytes, false, "image bytes")) return;
    if (self->sink) self->sink->registerImage(self->utf8(info[0]), data, bytes);
}
void ntAllocateDepthTarget(const v8::FunctionCallbackInfo<v8::Value>& info) {
    Impl* self = Impl::fromInfo(info);
    if (info.Length() < 3) return self->throwError("type", "allocateDepthTarget(id, width, height)");
    v8::Local<v8::Context> ctx = self->isolate->GetCurrentContext();
    const std::uint32_t id = info[0]->Uint32Value(ctx).FromMaybe(0),
        width = info[1]->Uint32Value(ctx).FromMaybe(0), height = info[2]->Uint32Value(ctx).FromMaybe(0);
    if (!id || !width || !height || width > 4096 || height > 4096)
        return self->throwError("range", "Invalid offscreen depth target dimensions");
    info.GetReturnValue().Set(self->sink && self->sink->allocateDepthTarget(id, width, height));
}
void ntReleaseDepthTarget(const v8::FunctionCallbackInfo<v8::Value>& info) {
    Impl* self = Impl::fromInfo(info);
    if (info.Length() >= 1 && self->sink)
        self->sink->releaseDepthTarget(info[0]->Uint32Value(self->isolate->GetCurrentContext()).FromMaybe(0));
}
void ntUpdateFloatTexture(const v8::FunctionCallbackInfo<v8::Value>& info) {
    Impl* self = Impl::fromInfo(info);
    if (info.Length() < 6) return self->throwError("type", "updateFloatTexture(id,x,y,w,h,bytes)");
    v8::Local<v8::Context> ctx = self->isolate->GetCurrentContext();
    const auto id = info[0]->Uint32Value(ctx).FromMaybe(0);
    const auto x = info[1]->Uint32Value(ctx).FromMaybe(0);
    const auto y = info[2]->Uint32Value(ctx).FromMaybe(0);
    const auto w = info[3]->Uint32Value(ctx).FromMaybe(0);
    const auto h = info[4]->Uint32Value(ctx).FromMaybe(0);
    const std::uint8_t* data = nullptr;
    std::size_t bytes = 0;
    if (!typedView(self, info[5], data, bytes, false, "RGBA32F update bytes")) return;
    if (!w || !h || w > 4096 || h > 1024 || bytes != std::size_t(w) * h * 16)
        return self->throwError("range", "Invalid RGBA32F subrectangle payload");
    info.GetReturnValue().Set(bool(self->sink &&
        self->sink->updateFloatTexture(id, x, y, w, h, data, bytes)));
}
void ntReleaseTexture(const v8::FunctionCallbackInfo<v8::Value>& info) {
    Impl* self = Impl::fromInfo(info);
    if (info.Length() >= 1 && self->sink)
        self->sink->releaseTexture(info[0]->Uint32Value(self->isolate->GetCurrentContext()).FromMaybe(0));
}
void ntUploadCanvasTexture(const v8::FunctionCallbackInfo<v8::Value>& info) {
    Impl* self = Impl::fromInfo(info);
    if (info.Length() < 3) return self->throwError("type", "uploadCanvasTexture(id, canvasId, flags)");
    v8::Local<v8::Context> ctx = self->isolate->GetCurrentContext();
    const std::uint32_t id = info[0]->Uint32Value(ctx).FromMaybe(0), canvas = info[1]->Uint32Value(ctx).FromMaybe(0),
                        flags = info[2]->Uint32Value(ctx).FromMaybe(0);
    info.GetReturnValue().Set(bool(self->sink && self->sink->uploadCanvasTexture(id, canvas, flags)));
}
void ntReleaseGeometry(const v8::FunctionCallbackInfo<v8::Value>& info) {
    Impl* self = Impl::fromInfo(info);
    if (info.Length() >= 1 && self->sink)
        self->sink->releaseGeometry(info[0]->Uint32Value(self->isolate->GetCurrentContext()).FromMaybe(0));
}
void ntUploadInstances(const v8::FunctionCallbackInfo<v8::Value>& info) {
    Impl* self = Impl::fromInfo(info);
    if (info.Length() < 4) return self->throwError("type", "uploadInstances(id, matrices, colors, count)");
    v8::Local<v8::Context> ctx = self->isolate->GetCurrentContext();
    const std::uint32_t id = info[0]->Uint32Value(ctx).FromMaybe(0), count = info[3]->Uint32Value(ctx).FromMaybe(0);
    const float *matrices, *colors;
    std::size_t nM, nC;
    if (!typedView(self, info[1], matrices, nM, false, "matrices") || !typedView(self, info[2], colors, nC, true, "colors")) return;
    if (nM < std::size_t(count) * 16 || (colors && nC < std::size_t(count) * 3))
        return self->throwError("range", "Instance buffers smaller than count");
    if (self->sink) self->sink->uploadInstances(id, matrices, colors, count);
}
void ntReleaseInstances(const v8::FunctionCallbackInfo<v8::Value>& info) {
    Impl* self = Impl::fromInfo(info);
    if (info.Length() >= 1 && self->sink)
        self->sink->releaseInstances(info[0]->Uint32Value(self->isolate->GetCurrentContext()).FromMaybe(0));
}
void ntRegisterColorPatch(const v8::FunctionCallbackInfo<v8::Value>& info) {
    auto* self = Impl::fromInfo(info);
    if (info.Length() < 2 || !self->sink || !info[1]->IsString()) return;
    const auto id = info[0]->Uint32Value(self->isolate->GetCurrentContext()).FromMaybe(0);
    info.GetReturnValue().Set(self->sink->registerColorPatch(id, self->utf8(info[1])));
}
void ntSubmitPass(const v8::FunctionCallbackInfo<v8::Value>& info) {
    Impl* self = Impl::fromInfo(info);
    if (info.Length() < 2) return self->throwError("type", "submitPass(packet, floats)");
    const float* data;
    std::size_t available;
    if (!typedView(self, info[0], data, available, false, "packet")) return;
    const std::uint32_t floats = info[1]->Uint32Value(self->isolate->GetCurrentContext()).FromMaybe(0);
    if (floats > available || floats < kWebappPassHeaderFloats) return self->throwError("range", "submitPass: bad packet size");
    const std::size_t lights = std::size_t(data[35]), draws = std::size_t(data[43]);
    if (lights > kWebappMaxLights || kWebappPassHeaderFloats + lights * kWebappLightFloats + draws * kWebappDrawFloats != floats)
        return self->throwError("range", "submitPass: header counts do not match packet size");
    if (self->sink) self->sink->submitPass(data, floats);
}
void ntSubmitUi(const v8::FunctionCallbackInfo<v8::Value>& info) {
    Impl* self = Impl::fromInfo(info);
    if (info.Length() < 3) return self->throwError("type", "submitUi(packet, floats, strings)");
    const float* data;
    std::size_t available;
    if (!typedView(self, info[0], data, available, false, "packet")) return;
    const std::uint32_t floats = info[1]->Uint32Value(self->isolate->GetCurrentContext()).FromMaybe(0);
    if (floats > available || webappUiHeaderFloats(data[0]) == 0 || floats < webappUiHeaderFloats(data[0])) return self->throwError("range", "submitUi: bad packet");
    if (self->sink) self->sink->submitUi(data, floats, self->utf8(info[2]));
}
void ntReportUi(const v8::FunctionCallbackInfo<v8::Value>& info) {
    Impl* self = Impl::fromInfo(info);
    if (info.Length() < 6 || !self->sink) return;
    v8::Local<v8::Context> c = self->isolate->GetCurrentContext();
    double v[6] = {};
    for (int i = 0; i < 6; i++) v[i] = info[i]->NumberValue(c).FromMaybe(0.0);
    self->sink->reportUi(v[0], v[1], v[2], int(v[3]), int(v[4]), int(v[5]));
}
void ntSetCursor(const v8::FunctionCallbackInfo<v8::Value>& info) {
    Impl* self = Impl::fromInfo(info);
    if (info.Length() >= 1 && self->sink) self->sink->setCursor(self->utf8(info[0]));
}
void ntMeasureText(const v8::FunctionCallbackInfo<v8::Value>& info) {
    Impl* self = Impl::fromInfo(info);
    double width = -1.0;
    if (info.Length() >= 5 && self->sink) {
        v8::Local<v8::Context> c = self->isolate->GetCurrentContext();
        width = self->sink->measureText(self->utf8(info[0]), info[1]->NumberValue(c).FromMaybe(16.0),
                                        int(info[2]->NumberValue(c).FromMaybe(400.0)), info[3]->BooleanValue(self->isolate),
                                        self->utf8(info[4]));
    }
    info.GetReturnValue().Set(v8::Number::New(self->isolate, width));
}

} // namespace

const char* webappEngineName() { return gEngineName.c_str(); }

WebappHost::WebappHost() : impl_(std::make_unique<Impl>()) {}
WebappHost::~WebappHost() { shutdown(); }
bool WebappHost::running() const { return impl_ && impl_->started; }

bool WebappHost::start(const std::filesystem::path& root, const std::string& shimSource,
                       std::vector<WebappBuiltin> builtins, WebappRenderSink* sink,
                       int width, int height, std::string& error, const WebappPage& page) {
    shutdown();
    initializeV8Once();
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
    for (const char* required : {"nt:three.core.min.js", "nt:three.module.min.js", "nt:native-renderer.mjs"})
        if (!s.builtins.count(required)) { error = std::string("Engine build is missing ") + required; return false; }
    std::string html;
    if (!webappReadGameFile(root, "index.html", html, error)) {
        error = "No index.html in " + webappPathUtf8(root) + " (" + error + ")";
        return false;
    }

    v8::Isolate::CreateParams params;
    params.array_buffer_allocator = gAllocator;
    params.constraints.ConfigureDefaultsFromHeapSize(0, 4096ull * 1024 * 1024);
    s.isolate = v8::Isolate::New(params);
    v8::Isolate* isolate = s.isolate;
    isolate->SetMicrotasksPolicy(v8::MicrotasksPolicy::kExplicit);
    isolate->SetHostImportModuleDynamicallyCallback(dynamicImport);
    isolate->SetHostInitializeImportMetaObjectCallback(importMeta);
    isolate->SetPromiseRejectCallback(rejectionCallback);
    s.log("info", std::string("JavaScript engine: ") + gEngineName);

    v8::Isolate::Scope isolateScope(isolate);
    v8::HandleScope handles(isolate);
    v8::Local<v8::Context> ctx = v8::Context::New(isolate);
    ctx->SetAlignedPointerInEmbedderData(1, &s);
    s.context.Reset(isolate, ctx);
    v8::Context::Scope contextScope(ctx);

    v8::Local<v8::External> self = v8::External::New(isolate, &s);
    v8::Local<v8::Object> api = v8::Object::New(isolate);
    struct Fn { const char* name; v8::FunctionCallback fn; };
    const Fn functions[] = {
#ifdef _WIN32
        {"storageRead", ntStorageRead}, {"storageWrite", ntStorageWrite}, {"storageClone", ntStorageClone},
#endif
        {"requestReload", ntRequestReload}, {"log", ntLog}, {"setTitle", ntSetTitle}, {"readText", ntReadText}, {"readBinary", ntReadBinary},
        {"setImportMap", ntSetImportMap}, {"evalScript", ntEvalScript}, {"evalModule", ntEvalModule},
        {"uploadGeometry", ntUploadGeometry}, {"releaseGeometry", ntReleaseGeometry},
        {"uploadInstances", ntUploadInstances}, {"releaseInstances", ntReleaseInstances}, {"submitPass", ntSubmitPass},
        {"registerColorPatch", ntRegisterColorPatch},
        {"uploadTexture", ntUploadTexture}, {"updateFloatTexture", ntUpdateFloatTexture},
        {"releaseTexture", ntReleaseTexture},
        {"allocateDepthTarget", ntAllocateDepthTarget}, {"releaseDepthTarget", ntReleaseDepthTarget},
        {"uploadCanvasTexture", ntUploadCanvasTexture},
        {"canvasCommands", ntCanvasCommands}, {"canvasRead", ntCanvasRead}, {"canvasWrite", ntCanvasWrite}, {"registerImage", ntRegisterImage},
        {"submitUi", ntSubmitUi}, {"measureText", ntMeasureText}, {"setCursor", ntSetCursor}, {"reportUi", ntReportUi},
    };
    for (const Fn& f : functions) {
        v8::Local<v8::Function> fn = v8::Function::New(ctx, f.fn, self).ToLocalChecked();
        api->Set(ctx, s.str(f.name), fn).Check();
    }
    ctx->Global()->Set(ctx, s.str("__nt"), api).Check();

    v8::TryCatch tc(isolate);
    auto runClassic = [&](const std::string& source, const char* name) -> bool {
        v8::ScriptOrigin origin(s.str(name));
        v8::Local<v8::Script> script;
        v8::Local<v8::Value> result;
        return v8::Script::Compile(ctx, s.str(source), &origin).ToLocal(&script) && script->Run(ctx).ToLocal(&result);
    };
    if (!runClassic(shimSource, "nt:webapp-shim.js") ||
        !runClassic("globalThis.__ntAfter = (p, ns) => Promise.resolve(p).then(() => ns);", "nt:after")) {
        error = "Webapp shim failed: " + s.exceptionText(tc);
        return false;
    }
    v8::Local<v8::Value> host, after;
    if (!ctx->Global()->Get(ctx, s.str("__ntHost")).ToLocal(&host) || !host->IsObject() ||
        !ctx->Global()->Get(ctx, s.str("__ntAfter")).ToLocal(&after) || !after->IsFunction()) {
        error = "Webapp shim did not install __ntHost";
        return false;
    }
    s.hostObject.Reset(isolate, host.As<v8::Object>());
    s.afterHelper.Reset(isolate, after.As<v8::Function>());
    s.started = true;

    resize(width, height, 1.0);
    v8::Local<v8::Value> args[] = {s.str(html), s.str(page.url), s.str(page.storage)};
    s.callHost("boot", 3, args);
    return true;
}

void WebappHost::shutdown() {
    if (!impl_) return;
    Impl& s = *impl_;
    if (s.isolate) {
        s.modules.clear();
        s.moduleNames.clear();
        s.hostObject.Reset();
        s.afterHelper.Reset();
        s.context.Reset();
        s.isolate->Dispose();
        s.isolate = nullptr;
    }
    s.started = false;
    s.reload.reset();
}

std::optional<WebappPage> WebappHost::takeReload() {
    auto page = std::move(impl_->reload);
    impl_->reload.reset();
    return page;
}

#define NT_V8_SCOPE()                                     \
    if (!running()) return;                               \
    v8::Isolate* isolate = impl_->isolate;                \
    v8::Isolate::Scope isolateScope(isolate);             \
    v8::HandleScope handles(isolate);                     \
    v8::Local<v8::Context> ctx = impl_->context.Get(isolate); \
    v8::Context::Scope contextScope(ctx)

void WebappHost::resize(int width, int height, double pixelRatio) {
    NT_V8_SCOPE();
    v8::Local<v8::Value> args[3] = {v8::Integer::New(isolate, std::max(1, width)), v8::Integer::New(isolate, std::max(1, height)),
                                    v8::Number::New(isolate, pixelRatio)};
    impl_->callHost("resize", 3, args);
}
void WebappHost::frame(double timeMs, bool uiTick) {
    NT_V8_SCOPE();
    v8::Local<v8::Value> args[2] = {v8::Number::New(isolate, timeMs), v8::Boolean::New(isolate, uiTick)};
    impl_->callHost("frame", 2, args);
}
void WebappHost::key(bool down, const std::string& key, const std::string& code, bool repeat, bool alt, bool ctrl,
                     bool shift, bool meta) {
    NT_V8_SCOPE();
    v8::Local<v8::Value> args[8] = {v8::Boolean::New(isolate, down), impl_->str(key), impl_->str(code),
                                    v8::Boolean::New(isolate, repeat), v8::Boolean::New(isolate, alt),
                                    v8::Boolean::New(isolate, ctrl), v8::Boolean::New(isolate, shift),
                                    v8::Boolean::New(isolate, meta)};
    impl_->callHost("key", 8, args);
}
void WebappHost::pointer(const char* kind, double x, double y, int button) {
    NT_V8_SCOPE();
    v8::Local<v8::Value> args[4] = {impl_->str(kind), v8::Number::New(isolate, x), v8::Number::New(isolate, y),
                                    v8::Integer::New(isolate, button)};
    impl_->callHost("pointer", 4, args);
}
void WebappHost::wheel(double x, double y, double deltaX, double deltaY) {
    NT_V8_SCOPE();
    v8::Local<v8::Value> args[4] = {v8::Number::New(isolate, x), v8::Number::New(isolate, y),
                                    v8::Number::New(isolate, deltaX), v8::Number::New(isolate, deltaY)};
    impl_->callHost("wheel", 4, args);
}
void WebappHost::focus(bool focused) {
    NT_V8_SCOPE();
    v8::Local<v8::Value> arg = v8::Boolean::New(isolate, focused);
    impl_->callHost("focus", 1, &arg);
}
std::string WebappHost::statusJson() {
    if (!running()) return "{}";
    v8::Isolate* isolate = impl_->isolate;
    v8::Isolate::Scope isolateScope(isolate);
    v8::HandleScope handles(isolate);
    v8::Local<v8::Context> ctx = impl_->context.Get(isolate);
    v8::Context::Scope contextScope(ctx);
    v8::TryCatch tc(isolate);
    v8::Local<v8::Object> host = impl_->hostObject.Get(isolate);
    v8::Local<v8::Value> fn, result;
    if (host->Get(ctx, impl_->str("status")).ToLocal(&fn) && fn->IsFunction() &&
        fn.As<v8::Function>()->Call(ctx, host, 0, nullptr).ToLocal(&result))
        return impl_->utf8(result);
    return "{}";
}

} // namespace native_three
