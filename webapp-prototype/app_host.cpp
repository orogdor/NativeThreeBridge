// Small, intentionally restricted HTML + Three.js host for the first WebApp proof.
// No WebView, Chromium, network fetch, arbitrary HTML layout or WebGL emulator.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <filesystem>
#include <stdexcept>
#include <cstdint>
#include <fstream>
#include <regex>
#include <string>
#include <cmath>
#include <cstring>
#include "quickjs.h"
#include "app_host.h"

namespace {
JSRuntime* runtime = nullptr;
JSContext* ctx = nullptr;
bool initialized = false;

std::string readText(const std::filesystem::path& path, std::size_t limit) {
  std::ifstream file(path, std::ios::binary | std::ios::ate);
  if (!file) throw std::runtime_error("Cannot open: " + path.u8string());
  const auto size = file.tellg();
  if (size < 1 || static_cast<std::uint64_t>(size) > limit)
    throw std::runtime_error("Empty or oversized file: " + path.u8string());
  std::string result(static_cast<std::size_t>(size), '\0');
  file.seekg(0);
  if (!file.read(result.data(), size))
    throw std::runtime_error("Could not read: " + path.u8string());
  return result;
}

std::string jsError() {
  JSValue exc = JS_GetException(ctx);
  JSValue stack = JS_GetPropertyStr(ctx, exc, "stack");
  JSValue message = JS_IsUndefined(stack) ? JS_DupValue(ctx, exc) : JS_DupValue(ctx, stack);
  const char* s = JS_ToCString(ctx, message);
  const char* detail = JS_ToCString(ctx, exc);
  std::string error = detail ? detail : "unknown JavaScript exception";
  if (s && error != s) error += std::string("\n") + s;
  if (detail) JS_FreeCString(ctx, detail);
  if (s) JS_FreeCString(ctx, s);
  JS_FreeValue(ctx, message);
  JS_FreeValue(ctx, stack);
  JS_FreeValue(ctx, exc);
  return error;
}

bool evaluate(const char* source, std::size_t size, const char* name, std::string& error) {
  JSValue result = JS_Eval(ctx, source, size, name, JS_EVAL_TYPE_GLOBAL);
  if (JS_IsException(result)) {
    error = std::string(name) + ": " + jsError();
    JS_FreeValue(ctx, result);
    return false;
  }
  JS_FreeValue(ctx, result);
  return true;
}

const char* shim = R"NTB(
(function () {
  globalThis.window = globalThis;
  globalThis.innerWidth = 960;
  globalThis.innerHeight = 640;
  globalThis.devicePixelRatio = 1;
  globalThis.performance = { now: () => globalThis.__nativeTimeMs || 0 };
  const canvas = {
    width:960, height:640, style:{},
    addEventListener(){}, removeEventListener(){},
    getContext(){ throw Error("Raw WebGL calls are not supported in this native prototype"); }
  };
  globalThis.document = {
    getElementById(id) { return id === "stage" ? canvas : null; },
    createElement(tag) { if (tag === "canvas") return canvas; throw Error("Unsupported element: " + tag); },
    body: { appendChild() {} }
  };
  globalThis.requestAnimationFrame = (callback) => {
    if (typeof callback !== 'function') throw TypeError('requestAnimationFrame callback required');
    globalThis.__nextFrame = callback; return 1;
  };
  globalThis.cancelAnimationFrame = () => { globalThis.__nextFrame = undefined; };

  // The ESM Three.js namespace is immutable. Copy it before overriding the
  // renderer only; real THREE.Scene/BoxGeometry/Mesh are unchanged.
  const THREE_original = globalThis.THREE;
  globalThis.THREE = {
    ...THREE_original,
    WebGLRenderer: class NativeDX12Renderer {
      constructor({ canvas: supplied } = {}) { this.domElement = supplied || canvas; }
      setSize(w,h) { this.domElement.width = w; this.domElement.height = h; }
      setPixelRatio() {}
      render(scene,camera) {
        globalThis.__drawScene = scene;
        globalThis.__drawCamera = camera;
      }
    }
  };

  globalThis.__nativeCapture = function () {
    const scene = globalThis.__drawScene, camera = globalThis.__drawCamera;
    if (!scene || !scene.isScene || !camera || !camera.isPerspectiveCamera)
      throw Error('WebApp must render a THREE.Scene with PerspectiveCamera');
    const meshes = [];
    scene.traverse(obj => { if (obj.isMesh) meshes.push(obj); });
    if (meshes.length !== 1 || meshes[0].geometry?.type !== 'BoxGeometry')
      throw Error('Native v0.26 WebApp prototype supports exactly one THREE.BoxGeometry mesh');
    const mesh = meshes[0];
    if (!mesh.material?.color?.isColor)
      throw Error('Only a single color material is supported');
    if (camera.position.x !== 0 || camera.position.y !== 0 || camera.position.z !== 6)
      throw Error('Camera translation not yet supported; expected (0,0,6)');
    scene.updateMatrixWorld(true);
    const sample = new Float32Array(19);
    sample.set(mesh.matrixWorld.elements, 0);
    sample[16] = mesh.material.color.r;
    sample[17] = mesh.material.color.g;
    sample[18] = mesh.material.color.b;
    return sample;
  };
})();
)NTB";
}  // namespace

bool WebApp_Init(const std::wstring& htmlPath, std::string& error) {
  if (initialized) { error = "WebApp already initialized"; return false; }
  try {
    const std::filesystem::path htmlFile(htmlPath);
    const std::string html = readText(htmlFile, 1024 * 1024);
    const std::regex entryRegex(
      "<meta\\s+name\\s*=\\s*\"nativethree-entry\"\\s+content\\s*=\\s*\"([A-Za-z0-9_-]+\\.js)\"\\s*/?>",
      std::regex::icase);
    std::smatch match;
    if (!std::regex_search(html, match, entryRegex)) {
      error = "index.html must declare <meta name=\"nativethree-entry\" content=\"app.js\">";
      return false;
    }
    const auto jsFile = htmlFile.parent_path() / match[1].str();
    const std::string appScript = readText(jsFile, 1024 * 1024);

    HRSRC resource = FindResourceW(nullptr, MAKEINTRESOURCEW(301), RT_RCDATA);
    if (!resource) { error = "Bundled Three.js resource 301 missing"; return false; }
    const DWORD bundleSize = SizeofResource(nullptr, resource);
    HGLOBAL loaded = LoadResource(nullptr, resource);
    const char* bundle = loaded ? static_cast<const char*>(LockResource(loaded)) : nullptr;
    if (!bundle || bundleSize < 32) { error = "Three.js bundle unreadable"; return false; }

    runtime = JS_NewRuntime();
    if (!runtime) { error = "QuickJS runtime allocation failed"; return false; }
    JS_SetMemoryLimit(runtime, 256ULL * 1024 * 1024);
    JS_SetMaxStackSize(runtime, 8ULL * 1024 * 1024);
    ctx = JS_NewContext(runtime);
    if (!ctx) { error = "QuickJS context allocation failed"; WebApp_Shutdown(); return false; }
    if (!evaluate(bundle, bundleSize, "three-runtime.bundle.js", error) ||
        !evaluate(shim, std::strlen(shim), "native-webapp-dom.js", error) ||
        !evaluate(appScript.data(), appScript.size(), match[1].str().c_str(), error)) {
      WebApp_Shutdown();
      return false;
    }
    initialized = true;
    return true;
  } catch (const std::exception& e) {
    error = e.what();
    WebApp_Shutdown();
    return false;
  }
}

bool WebApp_Tick(double timeMs, WebAppFrame& out, std::string& error) {
  if (!initialized) { error = "WebApp not initialized"; return false; }
  JSValue global = JS_GetGlobalObject(ctx);
  JS_SetPropertyStr(ctx, global, "__nativeTimeMs", JS_NewFloat64(ctx, timeMs));
  JSValue callback = JS_GetPropertyStr(ctx, global, "__nextFrame");
  JS_SetPropertyStr(ctx, global, "__nextFrame", JS_UNDEFINED);
  if (!JS_IsFunction(ctx, callback)) {
    error = "WebApp did not request an animation frame";
    JS_FreeValue(ctx, callback);
    JS_FreeValue(ctx, global);
    return false;
  }
  JSValue timeArg = JS_NewFloat64(ctx, timeMs);
  JSValue result = JS_Call(ctx, callback, JS_UNDEFINED, 1, &timeArg);
  JS_FreeValue(ctx, timeArg);
  JS_FreeValue(ctx, callback);
  if (JS_IsException(result)) {
    error = "WebApp animation: " + jsError();
    JS_FreeValue(ctx, result);
    JS_FreeValue(ctx, global);
    return false;
  }
  JS_FreeValue(ctx, result);
  JSValue capture = JS_GetPropertyStr(ctx, global, "__nativeCapture");
  result = JS_Call(ctx, capture, JS_UNDEFINED, 0, nullptr);
  JS_FreeValue(ctx, capture);
  JS_FreeValue(ctx, global);
  if (JS_IsException(result)) {
    error = "WebApp scene export: " + jsError();
    JS_FreeValue(ctx, result);
    return false;
  }
  std::size_t offset = 0, bytes = 0, elementBytes = 0;
  JSValue buffer = JS_GetTypedArrayBuffer(ctx, result, &offset, &bytes, &elementBytes);
  if (JS_IsException(buffer) || elementBytes != sizeof(float) ||
      bytes != 19 * sizeof(float)) {
    error = "WebApp export must return Float32Array(19)";
    if (JS_IsException(buffer)) { JSValue exc = JS_GetException(ctx); JS_FreeValue(ctx, exc); }
    else JS_FreeValue(ctx, buffer);
    JS_FreeValue(ctx, result);
    return false;
  }
  std::size_t total = 0;
  const auto* data = JS_GetArrayBuffer(ctx, &total, buffer);
  if (!data || offset > total || bytes > total - offset) {
    error = "WebApp export array bounds invalid";
    JS_FreeValue(ctx, buffer);
    JS_FreeValue(ctx, result);
    return false;
  }
  const float* values = reinterpret_cast<const float*>(data + offset);
  for (int i=0; i<19; ++i)
    if (!std::isfinite(values[i])) {
      error = "WebApp produced a non-finite matrix or color";
      JS_FreeValue(ctx, buffer); JS_FreeValue(ctx, result); return false;
    }
  std::memcpy(out.model, values, 16 * sizeof(float));
  std::memcpy(out.rgb, values+16, 3 * sizeof(float));
  JS_FreeValue(ctx, buffer);
  JS_FreeValue(ctx, result);
  return true;
}

void WebApp_Shutdown() {
  initialized = false;
  if (ctx) { JS_FreeContext(ctx); ctx = nullptr; }
  if (runtime) { JS_FreeRuntime(runtime); runtime = nullptr; }
}
