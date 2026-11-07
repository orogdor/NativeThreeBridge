#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <cmath>
#include <cstddef>
#include <cstring>
#include <string>
#include "quickjs.h"
#include "three_js_host.h"

namespace {
constexpr std::size_t MATRIX_FLOATS = 20 * 16;
JSRuntime *runtime = nullptr;
JSContext *context = nullptr;
JSValue frameFunction = JS_UNDEFINED;
bool ready = false;

[[noreturn]] void die(const char *msg) {
    MessageBoxA(nullptr, msg, "NativeThreeBridge: Three.js runtime failure", MB_OK | MB_ICONERROR);
    ExitProcess(41);
}
std::string errorString() {
    if (!context) return "QuickJS context unavailable";
    JSValue exception = JS_GetException(context);
    JSValue stack = JS_GetPropertyStr(context, exception, "stack");
    JSValue chosen = JS_IsUndefined(stack) ? JS_DupValue(context, exception) : JS_DupValue(context, stack);
    const char *str = JS_ToCString(context, chosen);
    std::string out = str ? str : "(exception without text)";
    if (str) JS_FreeCString(context, str);
    JS_FreeValue(context, chosen);
    JS_FreeValue(context, stack);
    JS_FreeValue(context, exception);
    return out;
}
void dieWithJS(const char *phase) {
    const std::string msg = std::string(phase) + ":\n" + errorString();
    die(msg.c_str());
}
} // namespace

void NativeThreeJS_Init() {
    HRSRC res = FindResourceW(nullptr, MAKEINTRESOURCEW(301), RT_RCDATA);
    if (!res) die("Missing bundled official Three.js scene script (resource 301).");
    const DWORD size = SizeofResource(nullptr, res);
    HGLOBAL bytes = LoadResource(nullptr, res);
    const char *script = bytes ? static_cast<const char *>(LockResource(bytes)) : nullptr;
    if (!script || size < 32) die("Cannot read bundled Three.js script.");

    runtime = JS_NewRuntime();
    if (!runtime) die("Cannot create QuickJS-NG runtime.");
    JS_SetMemoryLimit(runtime, 256ULL * 1024ULL * 1024ULL);
    JS_SetMaxStackSize(runtime, 8ULL * 1024ULL * 1024ULL);
    context = JS_NewContext(runtime);
    if (!context) die("Cannot create QuickJS-NG context.");

    JSValue result = JS_Eval(context, script, size, "three-scene.bundle.js", JS_EVAL_TYPE_GLOBAL);
    if (JS_IsException(result)) dieWithJS("Three.js bundle evaluation failed");
    JS_FreeValue(context, result);

    JSValue global = JS_GetGlobalObject(context);
    frameFunction = JS_GetPropertyStr(context, global, "__nativeThreeFrame");
    JSValue diagnostics = JS_GetPropertyStr(context, global, "__nativeThreeDiagnostics");
    if (!JS_IsFunction(context, frameFunction) || !JS_IsFunction(context, diagnostics))
        die("Real Three.js scene bridge API missing");
    JSValue check = JS_Call(context, diagnostics, JS_UNDEFINED, 0, nullptr);
    if (JS_IsException(check)) dieWithJS("Three.js scene diagnostics failed");
    JSValue count = JS_GetPropertyStr(context, check, "houseCount");
    JSValue trees = JS_GetPropertyStr(context, check, "treeCount");
    int houses=0,pines=0;
    JS_ToInt32(context,&houses,count);
    JS_ToInt32(context,&pines,trees);
    JS_FreeValue(context, count);
    JS_FreeValue(context, trees);
    JS_FreeValue(context, check);
    JS_FreeValue(context, diagnostics);
    JS_FreeValue(context, global);
    if (houses != 10 || pines != 10)
        die("Unexpected Three.js scene: 10 houses and 10 pines expected");
    ready = true;
}
void NativeThreeJS_Frame(float deltaSeconds, float *outMatrices, std::size_t capacity) {
    if (!ready || !outMatrices || capacity < MATRIX_FLOATS)
        die("NativeThreeJS_Frame invalid state");
    JSValue delta = JS_NewFloat64(context, deltaSeconds);
    JSValue transforms = JS_Call(context, frameFunction, JS_UNDEFINED, 1, &delta);
    JS_FreeValue(context, delta);
    if (JS_IsException(transforms)) dieWithJS("Three.js frame failed");

    size_t offset = 0, length = 0, elementBytes = 0;
    JSValue arrayBuffer = JS_GetTypedArrayBuffer(context, transforms, &offset, &length, &elementBytes);
    if (JS_IsException(arrayBuffer) || elementBytes != sizeof(float) ||
        length != MATRIX_FLOATS * sizeof(float)) {
        die("Three.js frame must produce Float32Array(320)");
    }
    size_t arrayBytes = 0;
    uint8_t *bytes = JS_GetArrayBuffer(context, &arrayBytes, arrayBuffer);
    if (!bytes || offset + length > arrayBytes) die("Three.js matrix array bounds error");
    std::memcpy(outMatrices, bytes + offset, length);
    JS_FreeValue(context, arrayBuffer);
    JS_FreeValue(context, transforms);
}
void NativeThreeJS_Shutdown() {
    if (!ready) return;
    JS_FreeValue(context,frameFunction);
    JS_FreeContext(context);
    JS_FreeRuntime(runtime);
    frameFunction=JS_UNDEFINED;
    context=nullptr;
    runtime=nullptr;
    ready=false;
}
