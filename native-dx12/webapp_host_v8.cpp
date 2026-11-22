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
#include <process.h>
#else
#include <unistd.h>
#endif

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstring>
#include <deque>
#include <functional>
#include <cstdlib>
#include <fstream>
#include <map>
#include <memory>
#include <mutex>
#include <set>
#include <thread>
#include <type_traits>
#include <unordered_map>

#include <libplatform/libplatform.h>
#include <v8.h>

#include "task_queue.h"

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
        // Games allocate many short-lived objects per frame (vectors, arrays,
        // closures). A larger young generation means fewer scavenges, i.e.
        // fewer GC pauses inside a frame. NTB_V8_FLAGS adds or overrides flags.
        std::string flags = "--max-semi-space-size=32";
#ifdef _WIN32
        char extra[512] = {};
        if (GetEnvironmentVariableA("NTB_V8_FLAGS", extra, sizeof extra) > 0) flags += std::string(" ") + extra;
#else
        if (const char* extra = std::getenv("NTB_V8_FLAGS")) flags += std::string(" ") + extra;
#endif
        v8::V8::SetFlagsFromString(flags.c_str(), flags.size());
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

// ------------------------------------------------------------------------
// Web Workers and structured clone.
//
// Every `new Worker(...)` gets its own V8 isolate on its own OS thread, so
// worker JavaScript really runs in parallel with the game. Messages cross
// threads as V8 structured-clone bytes; transferred ArrayBuffers move their
// memory (no copy), SharedArrayBuffers share it, compiled WebAssembly
// modules are shared too.

std::chrono::steady_clock::time_point gClockOrigin = std::chrono::steady_clock::now();
double clockMs() {
    return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - gClockOrigin).count();
}

struct WireMessage {
    std::vector<std::uint8_t> bytes;
    std::vector<std::shared_ptr<v8::BackingStore>> shared, moved;
    std::vector<v8::CompiledWasmModule> wasm;
};

void throwDataCloneError(v8::Isolate* isolate, v8::Local<v8::String> message) {
    v8::Local<v8::Value> error = v8::Exception::Error(message);
    v8::Local<v8::Context> ctx = isolate->GetCurrentContext();
    if (!ctx.IsEmpty() && error->IsObject())
        error.As<v8::Object>()->Set(ctx, v8::String::NewFromUtf8Literal(isolate, "name"),
                                    v8::String::NewFromUtf8Literal(isolate, "DataCloneError")).Check();
    isolate->ThrowException(error);
}

class WireWriter final : public v8::ValueSerializer::Delegate {
public:
    WireWriter(v8::Isolate* isolate, WireMessage& out) : isolate_(isolate), out_(out) {}
    void ThrowDataCloneError(v8::Local<v8::String> message) override { throwDataCloneError(isolate_, message); }
    v8::Maybe<uint32_t> GetSharedArrayBufferId(v8::Isolate*, v8::Local<v8::SharedArrayBuffer> buffer) override {
        for (std::size_t i = 0; i < seen_.size(); i++)
            if (seen_[i] == buffer) return v8::Just(uint32_t(i));
        seen_.push_back(buffer);
        out_.shared.push_back(buffer->GetBackingStore());
        return v8::Just(uint32_t(seen_.size() - 1));
    }
    v8::Maybe<uint32_t> GetWasmModuleTransferId(v8::Isolate*, v8::Local<v8::WasmModuleObject> module) override {
        out_.wasm.push_back(module->GetCompiledModule());
        return v8::Just(uint32_t(out_.wasm.size() - 1));
    }
private:
    v8::Isolate* isolate_;
    WireMessage& out_;
    std::vector<v8::Local<v8::SharedArrayBuffer>> seen_;
};

class WireReader final : public v8::ValueDeserializer::Delegate {
public:
    explicit WireReader(const WireMessage& in) : in_(in) {}
    v8::MaybeLocal<v8::SharedArrayBuffer> GetSharedArrayBufferFromId(v8::Isolate* isolate, uint32_t id) override {
        if (id >= in_.shared.size()) return {};
        return v8::SharedArrayBuffer::New(isolate, in_.shared[id]);
    }
    v8::MaybeLocal<v8::WasmModuleObject> GetWasmModuleFromId(v8::Isolate* isolate, uint32_t id) override {
        if (id >= in_.wasm.size()) return {};
        return v8::WasmModuleObject::FromCompiledModule(isolate, in_.wasm[id]);
    }
private:
    const WireMessage& in_;
};

// Structured clone of `value`; ArrayBuffers listed in `transfer` are moved
// (detached here). Throws DataCloneError like a browser on failure.
bool writeWire(v8::Isolate* isolate, v8::Local<v8::Context> ctx, v8::Local<v8::Value> value,
               v8::Local<v8::Value> transfer, WireMessage& out) {
    WireWriter delegate(isolate, out);
    v8::ValueSerializer serializer(isolate, &delegate);
    std::vector<v8::Local<v8::ArrayBuffer>> moved;
    if (!transfer.IsEmpty() && transfer->IsArray()) {
        v8::Local<v8::Array> list = transfer.As<v8::Array>();
        for (uint32_t i = 0; i < list->Length(); i++) {
            v8::Local<v8::Value> item;
            if (!list->Get(ctx, i).ToLocal(&item)) return false;
            if (!item->IsArrayBuffer()) continue; // MessagePort/ImageBitmap/...: copied or ignored
            v8::Local<v8::ArrayBuffer> buffer = item.As<v8::ArrayBuffer>();
            if (std::find(moved.begin(), moved.end(), buffer) != moved.end()) {
                throwDataCloneError(isolate, v8::String::NewFromUtf8Literal(isolate, "ArrayBuffer listed twice in the transfer list"));
                return false;
            }
            if (!buffer->IsDetachable() || buffer->WasDetached()) {
                throwDataCloneError(isolate, v8::String::NewFromUtf8Literal(isolate, "An ArrayBuffer is detached or cannot be transferred"));
                return false;
            }
            serializer.TransferArrayBuffer(uint32_t(moved.size()), buffer);
            moved.push_back(buffer);
        }
    }
    serializer.WriteHeader();
    if (!serializer.WriteValue(ctx, value).FromMaybe(false)) return false;
    const auto [bytes, size] = serializer.Release();
    out.bytes.assign(bytes, bytes + size);
    std::free(bytes);
    for (auto& buffer : moved) {
        out.moved.push_back(buffer->GetBackingStore());
        if (!buffer->Detach(v8::Local<v8::Value>()).FromMaybe(false)) return false;
    }
    return true;
}

v8::MaybeLocal<v8::Value> readWire(v8::Isolate* isolate, v8::Local<v8::Context> ctx, const WireMessage& in) {
    WireReader delegate(in);
    v8::ValueDeserializer deserializer(isolate, in.bytes.data(), in.bytes.size(), &delegate);
    if (!deserializer.ReadHeader(ctx).FromMaybe(false)) return {};
    for (std::size_t i = 0; i < in.moved.size(); i++)
        deserializer.TransferArrayBuffer(uint32_t(i), v8::ArrayBuffer::New(isolate, in.moved[i]));
    return deserializer.ReadValue(ctx);
}

enum : int { kWorkerMessage = 0, kWorkerError = 1, kWorkerLog = 2, kWorkerMessageError = 3 };

struct WorkerEvent {
    std::uint32_t worker = 0;
    int kind = kWorkerMessage;
    WireMessage message;
    std::string text, file; // error message + filename, or log text + level
    int line = 0;
};

struct WorkerOutbox {
    std::mutex mutex;
    std::deque<WorkerEvent> events;
};

// OS thread with a large stack: game and library code recurses deeply
// (the main thread links with a 64 MB stack for the same reason).
#ifdef _WIN32
constexpr std::size_t kWorkerStackBytes = 32u << 20;
#else
constexpr std::size_t kWorkerStackBytes = 8u << 20;
#endif
class JsThread {
public:
    bool start(std::function<void()> fn) {
#ifdef _WIN32
        auto* job = new std::function<void()>(std::move(fn));
        handle_ = reinterpret_cast<HANDLE>(_beginthreadex(nullptr, unsigned(kWorkerStackBytes), &entry, job,
                                                          STACK_SIZE_PARAM_IS_A_RESERVATION, nullptr));
        if (!handle_) { delete job; return false; }
        return true;
#else
        thread_ = std::thread(std::move(fn));
        return true;
#endif
    }
    void join() {
#ifdef _WIN32
        if (!handle_) return;
        WaitForSingleObject(handle_, INFINITE);
        CloseHandle(handle_);
        handle_ = nullptr;
#else
        if (thread_.joinable()) thread_.join();
#endif
    }
private:
#ifdef _WIN32
    static unsigned __stdcall entry(void* p) {
        std::unique_ptr<std::function<void()>> job(static_cast<std::function<void()>*>(p));
        (*job)();
        return 0;
    }
    HANDLE handle_ = nullptr;
#else
    std::thread thread_;
#endif
};

class WakeTask final : public v8::Task {
public:
    void Run() override {}
};

// State shared by the page (main thread) and one worker thread.
struct WorkerShared {
    std::uint32_t id = 0;
    std::string path;    // game-relative script path, or empty when `source` is given (blob:/data: URL)
    std::string source;
    std::string url;     // script URL (base for relative imports, fetch and importScripts)
    std::string name;
    bool module = false;
    std::filesystem::path root;
    std::string shim;
    std::shared_ptr<const std::map<std::string, std::string>> builtins;
    std::vector<std::string> builtinNames, importMap;
    std::shared_ptr<WorkerOutbox> outbox;

    std::mutex mutex;
    std::deque<WireMessage> inbox;
    bool stopping = false;
    v8::Isolate* isolate = nullptr; // set while the worker thread owns a live isolate
    std::atomic<bool> finished{false};
    std::atomic<double> timerDue{HUGE_VAL}; // clockMs() of the next worker timer
    JsThread thread;

    void send(WorkerEvent event) {
        event.worker = id;
        std::lock_guard<std::mutex> lock(outbox->mutex);
        outbox->events.push_back(std::move(event));
    }
    // Wakes the worker's event loop; caller holds `mutex`.
    void wakeLocked() {
        if (isolate) gPlatform->GetForegroundTaskRunner(isolate)->PostTask(std::make_unique<WakeTask>());
    }
    void deliver(WireMessage message) {
        std::lock_guard<std::mutex> lock(mutex);
        if (stopping) return;
        inbox.push_back(std::move(message));
        wakeLocked();
    }
    void stop() {
        std::lock_guard<std::mutex> lock(mutex);
        stopping = true;
        if (isolate) {
            isolate->TerminateExecution();
            wakeLocked();
        }
    }
};

void runWorker(std::shared_ptr<WorkerShared> shared);

// Completed background file read, handed to JavaScript on the next frame.
// `data` comes from V8's ArrayBuffer allocator (inside the V8 sandbox when
// the build has one), so the page's ArrayBuffer adopts it without a copy.
struct IoResult {
    std::uint32_t id = 0;
    bool ok = false;
    void* data = nullptr;
    std::size_t size = 0;
    std::string error;
    IoResult() = default;
    IoResult(IoResult&& o) noexcept : id(o.id), ok(o.ok), data(o.data), size(o.size), error(std::move(o.error)) { o.data = nullptr; }
    IoResult& operator=(IoResult&&) = delete;
    ~IoResult() { if (data) gAllocator->Free(data, size); }
};

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

    // Web Workers: one isolate + thread each (see runWorker).
    std::shared_ptr<WorkerOutbox> outbox = std::make_shared<WorkerOutbox>();
    std::map<std::uint32_t, std::shared_ptr<WorkerShared>> workers;
    std::vector<std::shared_ptr<WorkerShared>> stoppedWorkers;
    std::uint32_t nextWorker = 1;
    std::shared_ptr<const std::map<std::string, std::string>> sharedBuiltins;
    // Large game files are read on background threads (fetch).
    TaskQueue io{2};
    std::mutex ioMutex;
    std::deque<IoResult> ioDone;
    std::uint32_t nextIo = 1;
    // Garbage collection time of the page's isolate, reported in the log.
    double gcStart = 0, gcMs = 0, gcMaxMs = 0, gcReportAt = 0;
    int gcCount = 0;

    void pumpNative();
    void stopWorkers();
    void reapWorkers();

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
    const float *positions, *normals, *colors, *uvs = nullptr, *shaderAttributes = nullptr;
    const std::uint32_t* indices;
    std::size_t nP, nN, nC, nI, nU = 0, nA = 0;
    if (!typedView(self, info[1], positions, nP, false, "positions") || !typedView(self, info[2], normals, nN, true, "normals") ||
        !typedView(self, info[3], colors, nC, true, "colors") || !typedView(self, info[4], indices, nI, true, "indices") ||
        (info.Length() >= 6 && !typedView(self, info[5], uvs, nU, true, "uvs")) ||
        (info.Length() >= 8 && !typedView(self, info[7], shaderAttributes, nA, true, "shader attributes")))
        return;
    if (nP % 3 || (normals && nN != nP) || (colors && nC != nP && nC != nP / 3 * 4))
        return self->throwError("range", "Geometry attributes must be 3 floats per vertex (colours 3 or 4) and equal length");
    const std::uint32_t vertexCount = std::uint32_t(nP / 3);
    const std::uint32_t colorChannels = colors && nC != nP ? 4 : 3;
    if (uvs && nU != std::size_t(vertexCount) * 2) return self->throwError("range", "Geometry uvs must be 2 floats per vertex");
    if (shaderAttributes && nA != std::size_t(vertexCount) * 4)
        return self->throwError("range", "Shader attributes must be 4 floats per vertex");
    for (std::size_t i = 0; i < nI; i++)
        if (indices[i] >= vertexCount) return self->throwError("range", "Geometry index out of range");
    if (self->sink) self->sink->uploadGeometry(id, positions, normals, colors, vertexCount, indices, std::uint32_t(nI),
                                              uvs, colorChannels, info.Length() >= 7 && info[6]->IsTrue(), shaderAttributes);
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
void ntReleaseTexture(const v8::FunctionCallbackInfo<v8::Value>& info) {
    Impl* self = Impl::fromInfo(info);
    if (info.Length() >= 1 && self->sink)
        self->sink->releaseTexture(info[0]->Uint32Value(self->isolate->GetCurrentContext()).FromMaybe(0));
}
void ntCreateRenderTarget(const v8::FunctionCallbackInfo<v8::Value>& info) {
    Impl* self = Impl::fromInfo(info);
    if (info.Length() < 3) return self->throwError("type", "createRenderTarget(id, width, height)");
    v8::Local<v8::Context> ctx = self->isolate->GetCurrentContext();
    const bool ok = self->sink && self->sink->createRenderTarget(info[0]->Uint32Value(ctx).FromMaybe(0), info[1]->Uint32Value(ctx).FromMaybe(0),
                                                                 info[2]->Uint32Value(ctx).FromMaybe(0));
    info.GetReturnValue().Set(ok);
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
void ntUploadSkin(const v8::FunctionCallbackInfo<v8::Value>& info) {
    Impl* self = Impl::fromInfo(info);
    if (info.Length() < 4) return self->throwError("type", "uploadSkin(id, indices, weights, vertexCount)");
    v8::Local<v8::Context> ctx = self->isolate->GetCurrentContext();
    const std::uint32_t id = info[0]->Uint32Value(ctx).FromMaybe(0), count = info[3]->Uint32Value(ctx).FromMaybe(0);
    const float *indices, *weights;
    std::size_t nI, nW;
    if (!typedView(self, info[1], indices, nI, false, "indices") || !typedView(self, info[2], weights, nW, false, "weights")) return;
    if (nI < std::size_t(count) * 4 || nW < std::size_t(count) * 4)
        return self->throwError("range", "Skin buffers smaller than vertexCount");
    info.GetReturnValue().Set(bool(self->sink && self->sink->uploadSkin(id, indices, weights, count)));
}
void ntRegisterColorPatch(const v8::FunctionCallbackInfo<v8::Value>& info) {
    auto* self = Impl::fromInfo(info);
    if (info.Length() < 2 || !self->sink || !info[1]->IsString()) return;
    const auto id = info[0]->Uint32Value(self->isolate->GetCurrentContext()).FromMaybe(0);
    info.GetReturnValue().Set(self->sink->registerColorPatch(id, self->utf8(info[1])));
}
void ntColorPatchStatus(const v8::FunctionCallbackInfo<v8::Value>& info) {
    auto* self = Impl::fromInfo(info);
    if (info.Length() < 1 || !self->sink) return info.GetReturnValue().Set(-1);
    const auto id = info[0]->Uint32Value(self->isolate->GetCurrentContext()).FromMaybe(0);
    info.GetReturnValue().Set(self->sink->colorPatchStatus(id));
}
void ntSubmitPass(const v8::FunctionCallbackInfo<v8::Value>& info) {
    Impl* self = Impl::fromInfo(info);
    if (info.Length() < 2) return self->throwError("type", "submitPass(packet, floats)");
    const float* data;
    std::size_t available;
    if (!typedView(self, info[0], data, available, false, "packet")) return;
    const std::uint32_t floats = info[1]->Uint32Value(self->isolate->GetCurrentContext()).FromMaybe(0);
    if (floats > available || floats < kWebappPassHeaderFloats) return self->throwError("range", "submitPass: bad packet size");
    const WebappPassLayout layout = webappPassLayout(data);
    if (!layout.valid || layout.floats != floats)
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
void ntSetPointerLock(const v8::FunctionCallbackInfo<v8::Value>& info) {
    Impl* self = Impl::fromInfo(info);
    const bool ok = info.Length() >= 1 && self->sink && self->sink->setPointerLock(info[0]->BooleanValue(self->isolate));
    info.GetReturnValue().Set(ok);
}
void ntSetFullscreen(const v8::FunctionCallbackInfo<v8::Value>& info) {
    Impl* self = Impl::fromInfo(info);
    const bool ok = info.Length() >= 1 && self->sink && self->sink->setFullscreen(info[0]->BooleanValue(self->isolate));
    info.GetReturnValue().Set(ok);
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

// ---- Web Workers, structured clone and background reads (page side)
// workerCreate(path | null, source | null, isModule, name, url) -> id
void ntWorkerCreate(const v8::FunctionCallbackInfo<v8::Value>& info) {
    Impl* self = Impl::fromInfo(info);
    if (info.Length() < 5) return self->throwError("type", "workerCreate(path, source, module, name, url)");
    auto shim = self->builtins.find("nt:webapp-worker-shim.js");
    if (shim == self->builtins.end()) return self->throwError("reference", "This engine build has no worker runtime");
    self->reapWorkers();
    if (self->workers.size() >= 512) return self->throwError("range", "Too many workers are running (512)");
    auto w = std::make_shared<WorkerShared>();
    w->id = self->nextWorker++;
    if (info[0]->IsString()) w->path = self->utf8(info[0]);
    if (info[1]->IsString()) w->source = self->utf8(info[1]);
    if (w->path.empty() && !info[1]->IsString()) return self->throwError("type", "Worker needs a script path or source");
    w->module = info[2]->BooleanValue(self->isolate);
    w->name = self->utf8(info[3]);
    w->url = self->utf8(info[4]);
    w->root = self->root;
    w->shim = shim->second;
    w->builtins = self->sharedBuiltins;
    w->builtinNames = self->builtinNames;
    w->importMap = self->importMap;
    w->outbox = self->outbox;
    if (!w->thread.start([w] { runWorker(w); })) return self->throwError("range", "Could not start a worker thread");
    self->workers[w->id] = w;
    info.GetReturnValue().Set(v8::Integer::NewFromUnsigned(self->isolate, w->id));
}
// workerPost(id, message, transferList)
void ntWorkerPost(const v8::FunctionCallbackInfo<v8::Value>& info) {
    Impl* self = Impl::fromInfo(info);
    if (info.Length() < 2) return self->throwError("type", "workerPost(id, message, transfer)");
    v8::Local<v8::Context> ctx = self->isolate->GetCurrentContext();
    WireMessage message;
    if (!writeWire(self->isolate, ctx, info[1], info.Length() > 2 ? info[2] : v8::Local<v8::Value>(), message)) return;
    auto it = self->workers.find(info[0]->Uint32Value(ctx).FromMaybe(0));
    if (it != self->workers.end()) it->second->deliver(std::move(message));
}
void ntWorkerTerminate(const v8::FunctionCallbackInfo<v8::Value>& info) {
    Impl* self = Impl::fromInfo(info);
    if (info.Length() < 1) return;
    auto it = self->workers.find(info[0]->Uint32Value(self->isolate->GetCurrentContext()).FromMaybe(0));
    if (it == self->workers.end()) return;
    it->second->stop();
    self->stoppedWorkers.push_back(it->second);
    self->workers.erase(it);
}
void ntStructuredClone(const v8::FunctionCallbackInfo<v8::Value>& info) {
    v8::Isolate* isolate = info.GetIsolate();
    v8::Local<v8::Context> ctx = isolate->GetCurrentContext();
    WireMessage wire;
    v8::Local<v8::Value> clone;
    if (writeWire(isolate, ctx, info.Length() ? info[0] : v8::Undefined(isolate).As<v8::Value>(),
                  info.Length() > 1 ? info[1] : v8::Local<v8::Value>(), wire) &&
        readWire(isolate, ctx, wire).ToLocal(&clone))
        info.GetReturnValue().Set(clone);
}
void ntHardwareConcurrency(const v8::FunctionCallbackInfo<v8::Value>& info) {
    info.GetReturnValue().Set(v8::Integer::NewFromUnsigned(info.GetIsolate(), std::max(1u, std::thread::hardware_concurrency())));
}
void ntNow(const v8::FunctionCallbackInfo<v8::Value>& info) {
    info.GetReturnValue().Set(v8::Number::New(info.GetIsolate(), clockMs()));
}
// Files below this size are read at once (as before); larger ones on a
// background thread so a big GLB or texture does not stall the frame.
constexpr std::uint64_t kAsyncReadBytes = 256 * 1024;
// readBinaryAsync(path) -> ArrayBuffer (small file, read now) | request id;
// the result arrives through __ntHost.ioComplete(id, buffer, error).
void ntReadBinaryAsync(const v8::FunctionCallbackInfo<v8::Value>& info) {
    Impl* self = Impl::fromInfo(info);
    if (info.Length() < 1) return self->throwError("type", "readBinaryAsync(path)");
    const std::string rel = self->utf8(info[0]);
    std::uint64_t size = 0;
    std::string error;
    if (!webappGameFileSize(self->root, rel, size, error)) return self->throwError("reference", error);
    if (size < kAsyncReadBytes) {
        std::string data;
        if (!webappReadGameFile(self->root, rel, data, error)) return self->throwError("reference", error);
        std::unique_ptr<v8::BackingStore> store = v8::ArrayBuffer::NewBackingStore(self->isolate, data.size());
        if (!data.empty()) std::memcpy(store->Data(), data.data(), data.size());
        info.GetReturnValue().Set(v8::ArrayBuffer::New(self->isolate, std::move(store)));
        return;
    }
    const std::uint32_t id = self->nextIo++;
    const std::filesystem::path root = self->root;
    self->io.post([self, id, root, rel] {
        IoResult result;
        result.id = id;
        std::string bytes;
        result.ok = webappReadGameFile(root, rel, bytes, result.error);
        if (result.ok && !bytes.empty()) {
            result.data = gAllocator->AllocateUninitialized(bytes.size());
            if (result.data) {
                result.size = bytes.size();
                std::memcpy(result.data, bytes.data(), bytes.size());
            } else {
                result.ok = false;
                result.error = "Out of memory reading " + rel;
            }
        }
        std::lock_guard<std::mutex> lock(self->ioMutex);
        self->ioDone.push_back(std::move(result));
    });
    info.GetReturnValue().Set(v8::Integer::NewFromUnsigned(self->isolate, id));
}

void gcPrologue(v8::Isolate*, v8::GCType, v8::GCCallbackFlags, void* data) {
    static_cast<Impl*>(data)->gcStart = clockMs();
}
void gcEpilogue(v8::Isolate*, v8::GCType, v8::GCCallbackFlags, void* data) {
    Impl* self = static_cast<Impl*>(data);
    const double ms = clockMs() - self->gcStart;
    self->gcMs += ms;
    self->gcMaxMs = std::max(self->gcMaxMs, ms);
    self->gcCount++;
}

} // namespace

// ------------------------------------------------------------------------
// Worker thread: its own isolate, the worker shim (js/webapp-worker-shim.js)
// and an event loop that sleeps until a message, a timer or a V8 task
// (WebAssembly compilation, Atomics.waitAsync ...) arrives.
namespace {

struct WorkerRuntime {
    std::shared_ptr<WorkerShared> shared;
    v8::Isolate* isolate = nullptr;
    v8::Global<v8::Context> context;
    v8::Global<v8::Object> host;
    v8::Global<v8::Function> afterHelper;
    std::map<std::string, v8::Global<v8::Module>> modules;
    std::unordered_multimap<int, std::string> moduleNames;
    std::set<std::string> warnedThreeImports;
    std::string entryName; // module name / script name of the worker entry
    bool closing = false;

    static WorkerRuntime* fromContext(v8::Local<v8::Context> ctx) {
        return static_cast<WorkerRuntime*>(ctx->GetAlignedPointerFromEmbedderData(1));
    }
    static WorkerRuntime* fromInfo(const v8::FunctionCallbackInfo<v8::Value>& info) {
        return static_cast<WorkerRuntime*>(info.Data().As<v8::External>()->Value());
    }
    v8::Local<v8::String> str(const std::string& s) {
        return v8::String::NewFromUtf8(isolate, s.data(), v8::NewStringType::kNormal, int(s.size())).ToLocalChecked();
    }
    std::string utf8(v8::Local<v8::Value> v) {
        v8::String::Utf8Value u(isolate, v);
        return *u ? std::string(*u, u.length()) : std::string();
    }
    void throwError(const std::string& kind, const std::string& message) {
        v8::Local<v8::String> m = str(message);
        isolate->ThrowException(kind == "type" ? v8::Exception::TypeError(m)
                               : kind == "range" ? v8::Exception::RangeError(m)
                                                 : v8::Exception::ReferenceError(m));
    }
    void log(const std::string& level, const std::string& text) {
        WorkerEvent e;
        e.kind = kWorkerLog;
        e.file = level;
        e.text = "[worker " + (shared->name.empty() ? (shared->path.empty() ? std::string("#") + std::to_string(shared->id) : shared->path) : shared->name) + "] " + text;
        shared->send(std::move(e));
    }
    // Uncaught error: the page's Worker object gets an 'error' event.
    void reportException(v8::TryCatch& tc) {
        if (!tc.HasCaught() || tc.HasTerminated()) return;
        v8::Local<v8::Context> ctx = isolate->GetCurrentContext();
        WorkerEvent e;
        e.kind = kWorkerError;
        e.text = utf8(tc.Exception());
        v8::Local<v8::Value> stack;
        if (tc.StackTrace(ctx).ToLocal(&stack) && stack->IsString()) {
            const std::string s = utf8(stack);
            if (!s.empty() && s != e.text) e.text += "\n" + s;
        }
        if (!tc.Message().IsEmpty()) {
            e.file = utf8(tc.Message()->GetScriptResourceName());
            e.line = tc.Message()->GetLineNumber(ctx).FromMaybe(0);
        }
        shared->send(std::move(e));
    }
    void microtasks() {
        isolate->PerformMicrotaskCheckpoint();
        while (v8::platform::PumpMessageLoop(gPlatform.get(), isolate)) isolate->PerformMicrotaskCheckpoint();
    }
    // Calls __ntWorkerHost[name](...args); returns the result or empty.
    v8::MaybeLocal<v8::Value> callHost(const char* name, int argc, v8::Local<v8::Value>* argv) {
        v8::Local<v8::Context> ctx = context.Get(isolate);
        v8::TryCatch tc(isolate);
        v8::Local<v8::Object> h = host.Get(isolate);
        v8::Local<v8::Value> fn, result;
        if (h->Get(ctx, str(name)).ToLocal(&fn) && fn->IsFunction() &&
            fn.As<v8::Function>()->Call(ctx, h, argc, argv).ToLocal(&result)) {
            microtasks();
            return result;
        }
        reportException(tc);
        microtasks();
        return {};
    }

    // ---- modules (same resolution rules as the page)
    std::string nameOf(v8::Local<v8::Module> module) {
        auto range = moduleNames.equal_range(module->GetIdentityHash());
        for (auto it = range.first; it != range.second; ++it) {
            auto found = modules.find(it->second);
            if (found != modules.end() && found->second.Get(isolate) == module) return it->second;
        }
        return entryName;
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
    v8::MaybeLocal<v8::Module> loadModule(const std::string& name) {
        auto cached = modules.find(name);
        if (cached != modules.end()) return cached->second.Get(isolate);
        std::string source, error;
        if (startsWith(name, "nt:")) {
            auto it = shared->builtins->find(name);
            if (it == shared->builtins->end()) { throwError("reference", "Engine module " + name + " is missing from this build"); return {}; }
            source = it->second;
        } else {
            if (endsWithJson(name)) { throwError("type", "JSON modules are not supported yet: " + name + " (use fetch)"); return {}; }
            if (!webappReadGameFile(shared->root, name, source, error)) { throwError("reference", error); return {}; }
        }
        return compileModule(source, name);
    }
    std::string resolve(const std::string& base, const std::string& specifier) {
        std::string error;
        const std::string resolved = webappResolveModule(base, specifier, shared->importMap, shared->builtinNames, error);
        if (resolved.empty()) {
            throwError("reference", error + " (imported from " + base + ")");
            return {};
        }
        if (resolved == "nt:three" && specifier != "three" && !startsWith(specifier, "nt:") &&
            warnedThreeImports.insert(specifier).second)
            log("warn", "[NativeThreeBridge] '" + specifier + "' replaced by the engine's built-in Three.js r181");
        return resolved;
    }
};

v8::MaybeLocal<v8::Module> workerResolve(v8::Local<v8::Context> ctx, v8::Local<v8::String> specifier,
                                         v8::Local<v8::FixedArray>, v8::Local<v8::Module> referrer) {
    WorkerRuntime* self = WorkerRuntime::fromContext(ctx);
    const std::string name = self->resolve(self->nameOf(referrer), self->utf8(specifier));
    if (name.empty()) return {};
    return self->loadModule(name);
}

v8::MaybeLocal<v8::Value> workerRunModule(v8::Local<v8::Context> ctx, v8::Local<v8::Module> module) {
    if (module->GetStatus() == v8::Module::kUninstantiated &&
        !module->InstantiateModule(ctx, workerResolve).FromMaybe(false))
        return {};
    return module->Evaluate(ctx);
}

void workerImportMeta(v8::Local<v8::Context> ctx, v8::Local<v8::Module> module, v8::Local<v8::Object> meta) {
    WorkerRuntime* self = WorkerRuntime::fromContext(ctx);
    const std::string name = self->nameOf(module);
    std::string url;
    if (startsWith(name, "nt:")) url = name;
    else if (name == self->entryName && self->shared->path.empty()) url = self->shared->url;
    else {
        const std::size_t hash = name.find('#');
        url = "nt://game/" + (hash == std::string::npos ? name : name.substr(0, hash));
    }
    meta->CreateDataProperty(ctx, self->str("url"), self->str(url)).Check();
    meta->CreateDataProperty(ctx, self->str("main"), v8::False(self->isolate)).Check();
}

v8::MaybeLocal<v8::Promise> workerDynamicImport(v8::Local<v8::Context> ctx, v8::Local<v8::Data>,
                                                v8::Local<v8::Value> resourceName, v8::Local<v8::String> specifier,
                                                v8::Local<v8::FixedArray>) {
    WorkerRuntime* self = WorkerRuntime::fromContext(ctx);
    v8::Isolate* isolate = self->isolate;
    v8::EscapableHandleScope scope(isolate);
    v8::Local<v8::Promise::Resolver> resolver = v8::Promise::Resolver::New(ctx).ToLocalChecked();
    v8::TryCatch tc(isolate);
    std::string base = resourceName->IsString() ? self->utf8(resourceName) : self->entryName;
    if (base.empty() || startsWith(base, "nt:webapp-worker-shim")) base = self->entryName;
    const std::string name = self->resolve(base, self->utf8(specifier));
    v8::Local<v8::Module> module;
    v8::Local<v8::Value> evaluation;
    if (!name.empty() && self->loadModule(name).ToLocal(&module) && workerRunModule(ctx, module).ToLocal(&evaluation)) {
        v8::Local<v8::Value> args[2] = {evaluation, module->GetModuleNamespace()};
        v8::Local<v8::Value> chained;
        if (self->afterHelper.Get(isolate)->Call(ctx, v8::Undefined(isolate), 2, args).ToLocal(&chained))
            resolver->Resolve(ctx, chained).Check();
    }
    if (tc.HasCaught() && !tc.HasTerminated()) resolver->Reject(ctx, tc.Exception()).Check();
    return scope.Escape(resolver->GetPromise());
}

void workerRejection(v8::PromiseRejectMessage message) {
    if (message.GetEvent() != v8::kPromiseRejectWithNoHandler) return;
    v8::Isolate* isolate = v8::Isolate::GetCurrent();
    v8::Local<v8::Context> ctx = isolate->GetCurrentContext();
    if (ctx.IsEmpty()) return;
    WorkerRuntime* self = WorkerRuntime::fromContext(ctx);
    std::string text = self->utf8(message.GetValue());
    if (message.GetValue()->IsNativeError()) {
        v8::Local<v8::Value> stack;
        if (message.GetValue().As<v8::Object>()->Get(ctx, self->str("stack")).ToLocal(&stack) && stack->IsString())
            text = self->utf8(stack);
    }
    self->log("warn", "Unhandled promise rejection: " + text);
}

// ---- __ntw: native functions of a worker global scope
void ntwLog(const v8::FunctionCallbackInfo<v8::Value>& info) {
    WorkerRuntime* self = WorkerRuntime::fromInfo(info);
    if (info.Length() >= 2) self->log(self->utf8(info[0]), self->utf8(info[1]));
}
void ntwPostMessage(const v8::FunctionCallbackInfo<v8::Value>& info) {
    WorkerRuntime* self = WorkerRuntime::fromInfo(info);
    if (self->closing) return;
    WorkerEvent e;
    e.kind = kWorkerMessage;
    if (!writeWire(self->isolate, self->isolate->GetCurrentContext(), info.Length() ? info[0] : v8::Undefined(self->isolate).As<v8::Value>(),
                   info.Length() > 1 ? info[1] : v8::Local<v8::Value>(), e.message))
        return; // DataCloneError is pending
    self->shared->send(std::move(e));
}
// Error that the worker's own onerror did not handle: forwarded to the page.
void ntwReportError(const v8::FunctionCallbackInfo<v8::Value>& info) {
    WorkerRuntime* self = WorkerRuntime::fromInfo(info);
    WorkerEvent e;
    e.kind = kWorkerError;
    if (info.Length() >= 1) e.text = self->utf8(info[0]);
    if (info.Length() >= 2) e.file = self->utf8(info[1]);
    if (info.Length() >= 3) e.line = info[2]->Int32Value(self->isolate->GetCurrentContext()).FromMaybe(0);
    self->shared->send(std::move(e));
}
void ntwClose(const v8::FunctionCallbackInfo<v8::Value>& info) { WorkerRuntime::fromInfo(info)->closing = true; }
void ntwNow(const v8::FunctionCallbackInfo<v8::Value>& info) {
    info.GetReturnValue().Set(v8::Number::New(info.GetIsolate(), clockMs()));
}
void ntwReadText(const v8::FunctionCallbackInfo<v8::Value>& info) {
    WorkerRuntime* self = WorkerRuntime::fromInfo(info);
    std::string data, error;
    if (info.Length() < 1 || !webappReadGameFile(self->shared->root, self->utf8(info[0]), data, error))
        return self->throwError("reference", error.empty() ? "readText(path)" : error);
    info.GetReturnValue().Set(self->str(data));
}
void ntwReadBinary(const v8::FunctionCallbackInfo<v8::Value>& info) {
    WorkerRuntime* self = WorkerRuntime::fromInfo(info);
    std::string data, error;
    if (info.Length() < 1 || !webappReadGameFile(self->shared->root, self->utf8(info[0]), data, error))
        return self->throwError("reference", error.empty() ? "readBinary(path)" : error);
    std::unique_ptr<v8::BackingStore> store = v8::ArrayBuffer::NewBackingStore(self->isolate, data.size());
    if (!data.empty()) std::memcpy(store->Data(), data.data(), data.size());
    info.GetReturnValue().Set(v8::ArrayBuffer::New(self->isolate, std::move(store)));
}
// importScripts(): classic scripts in the worker's global scope.
void ntwEvalScript(const v8::FunctionCallbackInfo<v8::Value>& info) {
    WorkerRuntime* self = WorkerRuntime::fromInfo(info);
    if (info.Length() < 2 || !info[0]->IsString()) return self->throwError("type", "evalScript(source, name)");
    v8::Local<v8::Context> ctx = self->isolate->GetCurrentContext();
    v8::ScriptOrigin origin(info[1]);
    v8::Local<v8::Script> script;
    v8::Local<v8::Value> result;
    if (v8::Script::Compile(ctx, info[0].As<v8::String>(), &origin).ToLocal(&script) && script->Run(ctx).ToLocal(&result))
        info.GetReturnValue().Set(result);
}
void ntwStructuredClone(const v8::FunctionCallbackInfo<v8::Value>& info) {
    v8::Isolate* isolate = info.GetIsolate();
    v8::Local<v8::Context> ctx = isolate->GetCurrentContext();
    WireMessage wire;
    v8::Local<v8::Value> clone;
    if (writeWire(isolate, ctx, info.Length() ? info[0] : v8::Undefined(isolate).As<v8::Value>(),
                  info.Length() > 1 ? info[1] : v8::Local<v8::Value>(), wire) &&
        readWire(isolate, ctx, wire).ToLocal(&clone))
        info.GetReturnValue().Set(clone);
}
void ntwHardwareConcurrency(const v8::FunctionCallbackInfo<v8::Value>& info) {
    info.GetReturnValue().Set(v8::Integer::NewFromUnsigned(info.GetIsolate(), std::max(1u, std::thread::hardware_concurrency())));
}

// Worker event loop. Returns when the worker closes itself or is terminated.
void workerLoop(WorkerRuntime& rt) {
    v8::Isolate* isolate = rt.isolate;
    std::shared_ptr<WorkerShared> w = rt.shared;
    double wakeAt = HUGE_VAL;
    for (;;) {
        std::deque<WireMessage> batch;
        {
            std::lock_guard<std::mutex> lock(w->mutex);
            if (w->stopping) return;
            batch.swap(w->inbox);
        }
        for (auto& message : batch) {
            if (rt.closing) break;
            v8::HandleScope scope(isolate);
            v8::Local<v8::Context> ctx = rt.context.Get(isolate);
            v8::Local<v8::Value> data;
            bool ok;
            {
                v8::TryCatch tc(isolate);
                ok = readWire(isolate, ctx, message).ToLocal(&data);
            }
            v8::Local<v8::Value> args[2] = {ok ? data : v8::Undefined(isolate).As<v8::Value>(), v8::Boolean::New(isolate, !ok)};
            rt.callHost("message", 2, args);
            if (isolate->IsExecutionTerminating()) return;
        }
        if (rt.closing) return;
        double delay = -1;
        {
            v8::HandleScope scope(isolate);
            v8::Local<v8::Value> now = v8::Number::New(isolate, clockMs());
            v8::Local<v8::Value> next;
            if (rt.callHost("timers", 1, &now).ToLocal(&next) && next->IsNumber()) delay = next.As<v8::Number>()->Value();
            if (isolate->IsExecutionTerminating() || rt.closing) return;
        }
        w->timerDue = delay >= 0 ? clockMs() + delay : HUGE_VAL;
        if (delay >= 0) {
            const double due = clockMs() + delay;
            if (due < wakeAt - 0.5) {
                wakeAt = due;
                gPlatform->GetForegroundTaskRunner(isolate)->PostDelayedTask(std::make_unique<WakeTask>(), std::max(0.0, delay) / 1000.0);
            }
        }
        {
            std::lock_guard<std::mutex> lock(w->mutex);
            if (w->stopping) return;
            if (!w->inbox.empty() || delay == 0) continue;
        }
        // Sleeps until a message (WakeTask), a timer (delayed WakeTask) or
        // any V8 task for this isolate arrives.
        v8::platform::PumpMessageLoop(gPlatform.get(), isolate, v8::platform::MessageLoopBehavior::kWaitForWork);
        {
            v8::HandleScope scope(isolate);
            v8::Context::Scope contextScope(rt.context.Get(isolate));
            rt.microtasks();
        }
        if (clockMs() >= wakeAt) wakeAt = HUGE_VAL;
    }
}

bool workerBoot(WorkerRuntime& rt, v8::Local<v8::Context> ctx) {
    v8::Isolate* isolate = rt.isolate;
    WorkerShared& w = *rt.shared;
    v8::TryCatch tc(isolate);
    auto classic = [&](const std::string& source, const std::string& name) -> bool {
        v8::ScriptOrigin origin(rt.str(name));
        v8::Local<v8::Script> script;
        v8::Local<v8::Value> result;
        return v8::Script::Compile(ctx, rt.str(source), &origin).ToLocal(&script) && script->Run(ctx).ToLocal(&result);
    };
    if (!classic(w.shim, "nt:webapp-worker-shim.js") ||
        !classic("globalThis.__ntAfter = (p, ns) => Promise.resolve(p).then(() => ns);", "nt:after")) {
        rt.reportException(tc);
        return false;
    }
    v8::Local<v8::Value> host, after;
    if (!ctx->Global()->Get(ctx, rt.str("__ntWorkerHost")).ToLocal(&host) || !host->IsObject() ||
        !ctx->Global()->Get(ctx, rt.str("__ntAfter")).ToLocal(&after) || !after->IsFunction()) {
        rt.log("error", "worker shim did not install __ntWorkerHost");
        return false;
    }
    rt.host.Reset(isolate, host.As<v8::Object>());
    rt.afterHelper.Reset(isolate, after.As<v8::Function>());
    {
        v8::Local<v8::Value> args[3] = {rt.str(w.url), rt.str(w.name), v8::Boolean::New(isolate, w.module)};
        rt.callHost("boot", 3, args);
    }
    std::string source = w.source, error;
    rt.entryName = w.path.empty() ? "nt:worker-" + std::to_string(w.id) + (w.module ? ".mjs" : ".js") : w.path;
    if (!w.path.empty() && !webappReadGameFile(w.root, w.path, source, error)) {
        WorkerEvent e;
        e.kind = kWorkerError;
        e.text = "Worker script could not be loaded: " + error;
        e.file = w.url;
        w.send(std::move(e));
        return false;
    }
    if (w.module) {
        v8::Local<v8::Module> module;
        v8::Local<v8::Value> evaluation;
        if (!rt.compileModule(source, rt.entryName).ToLocal(&module) || !workerRunModule(ctx, module).ToLocal(&evaluation)) {
            rt.reportException(tc);
            return false;
        }
        rt.microtasks();
        if (evaluation->IsPromise()) {
            v8::Local<v8::Promise> promise = evaluation.As<v8::Promise>();
            if (promise->State() == v8::Promise::kRejected) {
                WorkerEvent e;
                e.kind = kWorkerError;
                e.text = rt.utf8(promise->Result());
                e.file = w.url;
                w.send(std::move(e));
                return false;
            }
        }
    } else if (!classic(source, rt.entryName)) {
        rt.reportException(tc);
        return false;
    }
    rt.microtasks();
    return true;
}

void runWorker(std::shared_ptr<WorkerShared> shared) {
    v8::Isolate::CreateParams params;
    params.array_buffer_allocator = gAllocator;
    params.constraints.ConfigureDefaultsFromHeapSize(0, 2048ull * 1024 * 1024);
    v8::Isolate* isolate = v8::Isolate::New(params);
    // PumpMessageLoop only sleeps on an existing task runner: create it now.
    gPlatform->GetForegroundTaskRunner(isolate);
    {
        std::lock_guard<std::mutex> lock(shared->mutex);
        shared->isolate = isolate;
        if (shared->stopping) isolate->TerminateExecution();
    }
    {
        WorkerRuntime rt;
        rt.shared = shared;
        rt.isolate = isolate;
        v8::Isolate::Scope isolateScope(isolate);
        // The thread has a large stack: let V8 use most of it.
        char here = 0;
        isolate->SetStackLimit(reinterpret_cast<uintptr_t>(&here) - (kWorkerStackBytes - (2u << 20)));
        isolate->SetMicrotasksPolicy(v8::MicrotasksPolicy::kExplicit);
        isolate->SetHostImportModuleDynamicallyCallback(workerDynamicImport);
        isolate->SetHostInitializeImportMetaObjectCallback(workerImportMeta);
        isolate->SetPromiseRejectCallback(workerRejection);
        v8::HandleScope handles(isolate);
        v8::Local<v8::Context> ctx = v8::Context::New(isolate);
        ctx->SetAlignedPointerInEmbedderData(1, &rt);
        rt.context.Reset(isolate, ctx);
        v8::Context::Scope contextScope(ctx);
        v8::Local<v8::External> self = v8::External::New(isolate, &rt);
        v8::Local<v8::Object> api = v8::Object::New(isolate);
        struct Fn { const char* name; v8::FunctionCallback fn; };
        const Fn functions[] = {
            {"log", ntwLog}, {"postMessage", ntwPostMessage}, {"reportError", ntwReportError}, {"close", ntwClose},
            {"now", ntwNow}, {"readText", ntwReadText}, {"readBinary", ntwReadBinary}, {"evalScript", ntwEvalScript},
            {"structuredClone", ntwStructuredClone}, {"hardwareConcurrency", ntwHardwareConcurrency},
        };
        for (const Fn& f : functions)
            api->Set(ctx, rt.str(f.name), v8::Function::New(ctx, f.fn, self).ToLocalChecked()).Check();
        ctx->Global()->Set(ctx, rt.str("__ntw"), api).Check();
        if (workerBoot(rt, ctx) && !rt.closing) workerLoop(rt);
        rt.modules.clear();
        rt.moduleNames.clear();
        rt.host.Reset();
        rt.afterHelper.Reset();
        rt.context.Reset();
    }
    {
        std::lock_guard<std::mutex> lock(shared->mutex);
        shared->isolate = nullptr;
        shared->stopping = true;
        shared->inbox.clear();
    }
    v8::platform::NotifyIsolateShutdown(gPlatform.get(), isolate);
    isolate->Dispose();
    shared->finished = true;
}

} // namespace

// Hands finished background reads and worker messages to JavaScript.
// Runs on the page thread at the start of every frame, so the game sees
// them between frames like browser tasks.
void WebappHost::Impl::pumpNative() {
    std::deque<IoResult> reads;
    std::deque<WorkerEvent> events;
    {
        std::lock_guard<std::mutex> lock(ioMutex);
        reads.swap(ioDone);
    }
    {
        std::lock_guard<std::mutex> lock(outbox->mutex);
        events.swap(outbox->events);
    }
    v8::Local<v8::Context> ctx = context.Get(isolate);
    for (auto& r : reads) {
        v8::HandleScope scope(isolate);
        v8::Local<v8::Value> args[3] = {v8::Integer::NewFromUnsigned(isolate, r.id), v8::Null(isolate), v8::Null(isolate)};
        if (r.ok && r.data) {
            // The ArrayBuffer adopts the allocator memory: no copy on this thread.
            void* bytes = r.data;
            r.data = nullptr;
            std::unique_ptr<v8::BackingStore> store = v8::ArrayBuffer::NewBackingStore(
                bytes, r.size, [](void* data, std::size_t length, void*) { gAllocator->Free(data, length); }, nullptr);
            args[1] = v8::ArrayBuffer::New(isolate, std::move(store));
        } else if (r.ok) {
            args[1] = v8::ArrayBuffer::New(isolate, 0);
        } else {
            args[2] = str(r.error);
        }
        callHost("ioComplete", 3, args);
    }
    for (auto& e : events) {
        if (e.kind == kWorkerLog) {
            log(e.file, e.text);
            continue;
        }
        if (!workers.count(e.worker)) continue; // terminated meanwhile
        v8::HandleScope scope(isolate);
        int kind = e.kind;
        v8::Local<v8::Value> data = v8::Undefined(isolate);
        if (kind == kWorkerMessage) {
            v8::TryCatch tc(isolate);
            if (!readWire(isolate, ctx, e.message).ToLocal(&data)) {
                kind = kWorkerMessageError;
                data = v8::Undefined(isolate);
            }
        }
        v8::Local<v8::Value> args[6] = {v8::Integer::NewFromUnsigned(isolate, e.worker), v8::Integer::New(isolate, kind), data,
                                        str(e.text), str(e.file), v8::Integer::New(isolate, e.line)};
        callHost("workerEvent", 6, args);
    }
    reapWorkers();
    const double now = clockMs();
    // Backup wake-up for worker timers (the worker also posts a delayed task).
    for (auto& [id, w] : workers) {
        if (w->timerDue > now) continue;
        std::lock_guard<std::mutex> lock(w->mutex);
        w->timerDue = HUGE_VAL;
        w->wakeLocked();
    }
    if (gcReportAt == 0) gcReportAt = now + 30000;
    if (now >= gcReportAt) {
        if (gcCount)
            log("info", "[gc] " + std::to_string(gcCount) + " collections, " + std::to_string(int(gcMs + 0.5)) +
                            " ms in 30 s, longest " + std::to_string(int(gcMaxMs + 0.5)) + " ms; " +
                            std::to_string(workers.size()) + " workers");
        gcCount = 0;
        gcMs = gcMaxMs = 0;
        gcReportAt = now + 30000;
    }
}

// Joins worker threads that have already ended (terminate() / close()).
void WebappHost::Impl::reapWorkers() {
    // A worker that called close() stays listed until the page terminates it
    // or drops it, so the messages it sent before closing still arrive.
    for (auto& [id, w] : workers)
        if (w->finished) w->thread.join();
    for (auto it = stoppedWorkers.begin(); it != stoppedWorkers.end();) {
        if ((*it)->finished) {
            (*it)->thread.join();
            it = stoppedWorkers.erase(it);
        } else ++it;
    }
}

void WebappHost::Impl::stopWorkers() {
    for (auto& [id, w] : workers) {
        w->stop();
        stoppedWorkers.push_back(w);
    }
    workers.clear();
    for (auto& w : stoppedWorkers) {
        w->stop();
        w->thread.join();
    }
    stoppedWorkers.clear();
    io.stop();
    {
        std::lock_guard<std::mutex> lock(ioMutex);
        ioDone.clear();
    }
    std::lock_guard<std::mutex> lock(outbox->mutex);
    outbox->events.clear();
}

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
    s.sharedBuiltins = std::make_shared<const std::map<std::string, std::string>>(s.builtins);
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
    isolate->AddGCPrologueCallback(gcPrologue, &s);
    isolate->AddGCEpilogueCallback(gcEpilogue, &s);
    s.log("info", std::string("JavaScript engine: ") + gEngineName + ", " +
                      std::to_string(std::max(1u, std::thread::hardware_concurrency())) + " CPU threads available to Web Workers");

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
        {"uploadSkin", ntUploadSkin},
        {"registerColorPatch", ntRegisterColorPatch}, {"colorPatchStatus", ntColorPatchStatus},
        {"uploadTexture", ntUploadTexture}, {"releaseTexture", ntReleaseTexture}, {"uploadCanvasTexture", ntUploadCanvasTexture},
        {"createRenderTarget", ntCreateRenderTarget},
        {"canvasCommands", ntCanvasCommands}, {"canvasRead", ntCanvasRead}, {"canvasWrite", ntCanvasWrite}, {"registerImage", ntRegisterImage},
        {"submitUi", ntSubmitUi}, {"measureText", ntMeasureText}, {"setCursor", ntSetCursor}, {"reportUi", ntReportUi},
        {"setPointerLock", ntSetPointerLock}, {"setFullscreen", ntSetFullscreen},
        {"workerCreate", ntWorkerCreate}, {"workerPost", ntWorkerPost}, {"workerTerminate", ntWorkerTerminate},
        {"structuredClone", ntStructuredClone}, {"hardwareConcurrency", ntHardwareConcurrency}, {"now", ntNow},
        {"readBinaryAsync", ntReadBinaryAsync},
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
    s.stopWorkers();
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
void WebappHost::frame(double timeMs) {
    NT_V8_SCOPE();
    impl_->pumpNative();
    if (!running()) return;
    v8::Local<v8::Value> arg = v8::Number::New(isolate, timeMs);
    impl_->callHost("frame", 1, &arg);
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
void WebappHost::pointerMovement(double dx, double dy) {
    NT_V8_SCOPE();
    v8::Local<v8::Value> args[2] = {v8::Number::New(isolate, dx), v8::Number::New(isolate, dy)};
    impl_->callHost("pointerMovement", 2, args);
}
void WebappHost::lockChanged(bool pointerLocked, bool fullscreen) {
    NT_V8_SCOPE();
    v8::Local<v8::Value> args[2] = {v8::Boolean::New(isolate, pointerLocked), v8::Boolean::New(isolate, fullscreen)};
    impl_->callHost("lockChanged", 2, args);
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
