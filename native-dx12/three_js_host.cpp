#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <cmath>
#include <cstddef>
#include <cstring>
#include <cstdio>
#include <string>
#include <vector>
#include "quickjs.h"
#include "three_js_host.h"
#include "navigation_service.h"
#include <algorithm>
#include <memory>
#include <thread>

namespace {
constexpr std::size_t MATRIX_FLOATS = 11000 * 16;
JSRuntime *runtime = nullptr;
JSContext *context = nullptr;
JSValue frameFunction = JS_UNDEFINED;
JSValue lightFunction = JS_UNDEFINED;
JSValue navStatusFunction = JS_UNDEFINED;
JSValue pathSegmentsFunction = JS_UNDEFINED;
bool ready = false;
std::unique_ptr<native_three::NavigationService> navService;

// Optional generic native-navigation API. Existing games need no migration:
// callers that use it avoid A* searches on the JS/render thread.
JSValue jsNavigationConfigure(JSContext* ctx,JSValueConst,int argc,JSValueConst* argv) {
    if(argc<3)return JS_ThrowTypeError(ctx,"configure(width,height,Uint8Array obstacles)");
    std::uint32_t width=0,height=0;
    if(JS_ToUint32(ctx,&width,argv[0])<0||JS_ToUint32(ctx,&height,argv[1])<0)
        return JS_EXCEPTION;
    size_t offset=0,bytes=0,itemBytes=0;
    JSValue buffer=JS_GetTypedArrayBuffer(ctx,argv[2],&offset,&bytes,&itemBytes);
    if(JS_IsException(buffer))return buffer;
    size_t bufferBytes=0;
    const std::uint8_t* data=JS_GetArrayBuffer(ctx,&bufferBytes,buffer);
    const bool valid=data && width>0&&height>0&&
          std::uint64_t(width)*height==bytes&&itemBytes==1&&offset+bytes<=bufferBytes;
    if(!valid){
        JS_FreeValue(ctx,buffer);
        return JS_ThrowRangeError(ctx,"Expected grid-sized Uint8Array of blocked cells");
    }
    std::vector<std::uint8_t> blocked(data+offset,data+offset+bytes);
    JS_FreeValue(ctx,buffer);
    if(!navService){
        const unsigned hardware=std::thread::hardware_concurrency();
        navService=std::make_unique<native_three::NavigationService>(
            std::max(1u,std::min(4u,hardware>2?hardware-2:1u)));
    }
    navService->setMap(width,height,std::move(blocked));
    return JS_NewBool(ctx,true);
}
JSValue jsNavigationUpdateAgents(JSContext* ctx,JSValueConst,int argc,JSValueConst* argv) {
    if(!navService)return JS_ThrowTypeError(ctx,"Call configure before updateAgents");
    if(argc<2)return JS_ThrowTypeError(ctx,"updateAgents(Int32Array occupied,Int32Array reserved)");
    std::vector<std::int32_t> lists[2];
    for(int i=0;i<2;i++){
        size_t off=0,bytes=0,width=0,total=0;
        JSValue buffer=JS_GetTypedArrayBuffer(ctx,argv[i],&off,&bytes,&width);
        if(JS_IsException(buffer))return buffer;
        const std::uint8_t* ptr=JS_GetArrayBuffer(ctx,&total,buffer);
        if(!ptr||width!=sizeof(std::int32_t)||off+bytes>total||
           bytes%sizeof(std::int32_t)){
            JS_FreeValue(ctx,buffer);
            return JS_ThrowTypeError(ctx,"Expected Int32Array cell indices");
        }
        lists[i].resize(bytes/sizeof(std::int32_t));
        std::memcpy(lists[i].data(),ptr+off,bytes);
        JS_FreeValue(ctx,buffer);
    }
    navService->updateAgents(lists[0],lists[1]);
    return JS_UNDEFINED;
}
JSValue jsNavigationRequest(JSContext* ctx,JSValueConst,int argc,JSValueConst* argv) {
    if(!navService)return JS_ThrowTypeError(ctx,"Call NativeThreeNavigation.configure first");
    if(argc<2)return JS_ThrowTypeError(ctx,"request(startCell,goalCell,urgent=false)");
    std::uint32_t start=0,goal=0;
    if(JS_ToUint32(ctx,&start,argv[0])<0||JS_ToUint32(ctx,&goal,argv[1])<0)
        return JS_EXCEPTION;
    const bool urgent=argc>2 && JS_ToBool(ctx,argv[2])>0;
    return JS_NewInt64(ctx,(std::int64_t)navService->request(start,goal,urgent));
}
JSValue jsNavigationPoll(JSContext* ctx,JSValueConst,int argc,JSValueConst* argv) {
    JSValue array=JS_NewArray(ctx);
    if(!navService)return array;
    std::uint32_t maxResults=32;
    if(argc>0 && JS_ToUint32(ctx,&maxResults,argv[0])<0){
        JS_FreeValue(ctx,array);return JS_EXCEPTION;
    }
    maxResults=std::min(maxResults,128u);
    for(std::uint32_t i=0;i<maxResults;i++){
        native_three::RouteResult route;
        if(!navService->poll(route))break;
        JSValue result=JS_NewObject(ctx);
        JS_SetPropertyStr(ctx,result,"token",JS_NewInt64(ctx,(std::int64_t)route.token));
        JS_SetPropertyStr(ctx,result,"status",JS_NewInt32(ctx,(int)route.status));
        JSValue cells=JS_NewArray(ctx);
        for(std::uint32_t c=0;c<route.cells.size();c++)
            JS_SetPropertyUint32(ctx,cells,c,JS_NewUint32(ctx,route.cells[c]));
        JS_SetPropertyStr(ctx,result,"cells",cells);
        JS_SetPropertyUint32(ctx,array,i,result);
    }
    return array;
}
JSValue jsNavigationCancel(JSContext* ctx,JSValueConst,int argc,JSValueConst* argv) {
    if(!navService||argc<1)return JS_NewBool(ctx,false);
    std::int64_t token=0;
    if(JS_ToInt64(ctx,&token,argv[0])<0)return JS_EXCEPTION;
    return JS_NewBool(ctx,navService->cancel((std::uint64_t)token));
}
JSValue jsNavigationPending(JSContext* ctx,JSValueConst,int,JSValueConst*) {
    return JS_NewInt32(ctx,navService?(int)navService->pending():0);
}
void installNativeNavigation(JSContext* ctx) {
    JSValue global=JS_GetGlobalObject(ctx),api=JS_NewObject(ctx);
    JS_SetPropertyStr(ctx,api,"configure",JS_NewCFunction(ctx,jsNavigationConfigure,"configure",3));
    JS_SetPropertyStr(ctx,api,"updateAgents",
                      JS_NewCFunction(ctx,jsNavigationUpdateAgents,"updateAgents",2));
    JS_SetPropertyStr(ctx,api,"request",JS_NewCFunction(ctx,jsNavigationRequest,"request",3));
    JS_SetPropertyStr(ctx,api,"poll",JS_NewCFunction(ctx,jsNavigationPoll,"poll",1));
    JS_SetPropertyStr(ctx,api,"cancel",JS_NewCFunction(ctx,jsNavigationCancel,"cancel",1));
    JS_SetPropertyStr(ctx,api,"pending",JS_NewCFunction(ctx,jsNavigationPending,"pending",0));
    JS_SetPropertyStr(ctx,global,"NativeThreeNavigation",api);
    JS_FreeValue(ctx,global);
}


[[noreturn]] void die(const char *msg) {
    if (GetEnvironmentVariableA("CI", nullptr, 0) == 0)
        MessageBoxA(nullptr, msg, "NativeThreeBridge: Three.js runtime failure", MB_OK | MB_ICONERROR);
    std::fprintf(stderr, "%s\\n", msg);
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

// A separate scene.js is loaded relative to this EXE. No browser APIs.
static std::string loadGameScene() {
    wchar_t fullPath[MAX_PATH] = {};
    DWORD n = GetModuleFileNameW(nullptr, fullPath, MAX_PATH);
    if (!n || n >= MAX_PATH) die("Cannot find executable path.");
    std::wstring filename(fullPath, n);
    size_t slash = filename.find_last_of(L"\\/");
    if (slash == std::wstring::npos) die("Cannot locate executable folder.");
    filename.resize(slash);
    filename += L"\\game\\scene.js";
    HANDLE f = CreateFileW(filename.c_str(), GENERIC_READ, FILE_SHARE_READ,
                            nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (f == INVALID_HANDLE_VALUE)
        die("Missing game/scene.js. Extract the complete Windows ZIP beside the EXE.");
    LARGE_INTEGER size = {};
    if (!GetFileSizeEx(f, &size) || size.QuadPart < 32 || size.QuadPart > (8 * 1024 * 1024)) {
        CloseHandle(f);
        die("game/scene.js is empty, invalid or larger than 8 MB.");
    }
    std::string source(static_cast<size_t>(size.QuadPart), '\0');
    DWORD received = 0;
    BOOL ok = ReadFile(f, source.data(), static_cast<DWORD>(source.size()), &received, nullptr);
    CloseHandle(f);
    if (!ok || received != source.size()) die("Unable to read game/scene.js.");
    return source;
}

void NativeThreeJS_Init() {
    HRSRC res = FindResourceW(nullptr, MAKEINTRESOURCEW(301), RT_RCDATA);
    if (!res) die("Missing bundled official Three.js core (resource 301).");
    const DWORD size = SizeofResource(nullptr, res);
    HGLOBAL bytes = LoadResource(nullptr, res);
    const char *script = bytes ? static_cast<const char *>(LockResource(bytes)) : nullptr;
    if (!script || size < 32) die("Cannot read embedded official Three.js core.");

    runtime = JS_NewRuntime();
    if (!runtime) die("Cannot create QuickJS-NG runtime.");
    JS_SetMemoryLimit(runtime, 256ULL * 1024ULL * 1024ULL);
    JS_SetMaxStackSize(runtime, 8ULL * 1024ULL * 1024ULL);
    context = JS_NewContext(runtime);
    if (!context) die("Cannot create QuickJS-NG context.");

    JSValue result = JS_Eval(context, script, size, "three-runtime.bundle.js", JS_EVAL_TYPE_GLOBAL);
    if (JS_IsException(result)) dieWithJS("Three.js core evaluation failed");
    JS_FreeValue(context, result);
    installNativeNavigation(context);
    const std::string gameScript = loadGameScene();
    result = JS_Eval(context, gameScript.data(), gameScript.size(), "game/scene.js", JS_EVAL_TYPE_GLOBAL);
    if (JS_IsException(result)) dieWithJS("Game scene.js evaluation failed");
    JS_FreeValue(context, result);

    JSValue global = JS_GetGlobalObject(context);
    frameFunction = JS_GetPropertyStr(context, global, "__nativeThreeFrame");
    lightFunction = JS_GetPropertyStr(context, global, "__nativeThreeLightFrame");
    navStatusFunction = JS_GetPropertyStr(context, global, "__nativeThreeNavStats");
    pathSegmentsFunction = JS_GetPropertyStr(context, global, "__nativeThreeDebugSegments");
    JSValue diagnostics = JS_GetPropertyStr(context, global, "__nativeThreeDiagnostics");
    if (!JS_IsFunction(context, frameFunction) ||
        !JS_IsFunction(context, lightFunction) ||
        !JS_IsFunction(context, navStatusFunction) ||
        !JS_IsFunction(context, pathSegmentsFunction) ||
        !JS_IsFunction(context, diagnostics))
        die("Real Three.js scene or dynamic light bridge API missing");
    JSValue check = JS_Call(context, diagnostics, JS_UNDEFINED, 0, nullptr);
    if (JS_IsException(check)) dieWithJS("Three.js scene diagnostics failed");
    JSValue count = JS_GetPropertyStr(context, check, "unitCount");
    JSValue trees = JS_GetPropertyStr(context, check, "treeCount");
    JSValue armies = JS_GetPropertyStr(context, check, "armyCount");
    JSValue failures = JS_GetPropertyStr(context, check, "routeFailures");
    int soldiers=0,pines=0,armyCount=0,pathFailures=0;
    JS_ToInt32(context,&soldiers,count);
    JS_ToInt32(context,&pines,trees);
    JS_ToInt32(context,&armyCount,armies);
    JS_ToInt32(context,&pathFailures,failures);
    JS_FreeValue(context, count);
    JS_FreeValue(context, trees);
    JS_FreeValue(context, armies);
    JS_FreeValue(context, failures);
    JS_FreeValue(context, check);
    JS_FreeValue(context, diagnostics);
    JS_FreeValue(context, global);
    if (soldiers != 1000 || armyCount != 2 || pines != 10000 || pathFailures != 0)
        die("Unexpected JS scene: expected 10000 pines and two 500-soldier armies");
    // Starting the JS scene must NOT precompute all 500 soldiers' routes.
    JSValue nav=JS_GetGlobalObject(context);
    JSValue navFunction=JS_GetPropertyStr(context,nav,"__nativeThreeNavStats");
    JSValue state=JS_Call(context,navFunction,JS_UNDEFINED,0,nullptr);
    if(JS_IsException(state))dieWithJS("Initial dynamic pathfinding state");
    JSValue searches=JS_GetPropertyStr(context,state,"searches");
    int precomputed=0;
    JS_ToInt32(context,&precomputed,searches);
    JS_FreeValue(context,searches);
    JS_FreeValue(context,state);
    JS_FreeValue(context,navFunction);
    JS_FreeValue(context,nav);
    if(precomputed!=0)die("Navigation routes must be calculated on demand, not during scene init");
    ready = true;
}
void NativeThreeJS_FrameFrom(float deltaSeconds, float *outMatrices,
                             std::size_t capacity,std::size_t firstChangedInstance) {
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
        die("Three.js frame must produce Float32Array(176000): 10000 trees + 1000 soldiers");
    }
    size_t arrayBytes = 0;
    uint8_t *bytes = JS_GetArrayBuffer(context, &arrayBytes, arrayBuffer);
    if (!bytes || offset + length > arrayBytes) die("Three.js matrix array bounds error");
    const std::size_t firstFloat=firstChangedInstance*16;
    if(firstChangedInstance>MATRIX_FLOATS/16)
        die("NativeThreeJS_FrameFrom offset outside scene");
    if(firstFloat==0) {
        std::memcpy(outMatrices, bytes + offset, length);
    } else {
        // Static or unchanged prefix remains in the persistent native buffer.
        std::memcpy(outMatrices+firstFloat,bytes+offset+firstFloat*sizeof(float),
                    length-firstFloat*sizeof(float));
    }
    JS_FreeValue(context, arrayBuffer);
    JS_FreeValue(context, transforms);
}
void NativeThreeJS_Frame(float deltaSeconds, float *outMatrices, std::size_t capacity) {
    NativeThreeJS_FrameFrom(deltaSeconds,outMatrices,capacity,0);
}
void NativeThreeJS_Lights(float *outLights, std::size_t capacity) {
    constexpr size_t FLOATS = 1000 * 8;
    if (!ready || !outLights || capacity < FLOATS)
        die("NativeThreeJS_Lights invalid state");
    JSValue result = JS_Call(context, lightFunction, JS_UNDEFINED, 0, nullptr);
    if (JS_IsException(result)) dieWithJS("Three.js light bridge failed");
    size_t offset=0, bytes=0, elementBytes=0;
    JSValue buffer = JS_GetTypedArrayBuffer(context, result, &offset, &bytes, &elementBytes);
    if (JS_IsException(buffer) || elementBytes != sizeof(float) ||
        bytes != FLOATS * sizeof(float)) die("Expected 1000 Three.js SpotLight records");
    size_t totalBytes=0;
    uint8_t *address = JS_GetArrayBuffer(context, &totalBytes, buffer);
    if (!address || offset + bytes > totalBytes) die("Three.js lights array bounds error");
    std::memcpy(outLights, address+offset, bytes);
    JS_FreeValue(context, buffer);
    JS_FreeValue(context, result);
}
void NativeThreeJS_GetNavStatus(NativeThreeNavStatus *out) {
    if (!ready || !out) die("Navigation status: runtime not ready");
    JSValue stats = JS_Call(context,navStatusFunction,JS_UNDEFINED,0,nullptr);
    if (JS_IsException(stats)) dieWithJS("Read real-time A* movement status");
    const char *keys[]={"routeFailures","moved","active","arrived","routeSteps",
                        "searches","replans","blockedMoves","planned"};
    int *values[]={&out->routeFailures,&out->moved,&out->active,&out->arrived,&out->routeSteps,
                   &out->searches,&out->replans,&out->blockedMoves,&out->planned};
    for (int i=0;i<9;i++) {
        JSValue v=JS_GetPropertyStr(context,stats,keys[i]);
        if (JS_IsException(v) || JS_ToInt32(context,values[i],v)<0)
            dieWithJS("Invalid Three.js navigation status field");
        JS_FreeValue(context,v);
    }
    JS_FreeValue(context,stats);
}
std::size_t NativeThreeJS_DebugSegments(float *outSegments, std::size_t capacity) {
    if (!ready || !outSegments) die("A* visual route buffer unavailable");
    JSValue value=JS_Call(context,pathSegmentsFunction,JS_UNDEFINED,0,nullptr);
    if(JS_IsException(value))dieWithJS("Read Three.js A* path visualization");
    size_t offset=0,bytes=0,itemBytes=0;
    JSValue buffer=JS_GetTypedArrayBuffer(context,value,&offset,&bytes,&itemBytes);
    if(JS_IsException(buffer) || itemBytes!=sizeof(float) ||
       bytes%sizeof(float) || (bytes/sizeof(float))%5 ||
       bytes>capacity*sizeof(float))
        die("Invalid/oversized Three.js A* path debug segment array");
    size_t bufferBytes=0;
    uint8_t *ptr=JS_GetArrayBuffer(context,&bufferBytes,buffer);
    if(!ptr || offset+bytes>bufferBytes)die("A* route buffer bounds error");
    std::memcpy(outSegments,ptr+offset,bytes);
    JS_FreeValue(context,buffer);
    JS_FreeValue(context,value);
    return bytes/sizeof(float);
}
void NativeThreeJS_Shutdown() {
    // Worker pool may own in-flight navigation requests. Shutdown does not
    // wait for queued work to finish, and no worker touches the JS context.
    navService.reset();
    if (!ready) return;
    JS_FreeValue(context,pathSegmentsFunction);
    JS_FreeValue(context,navStatusFunction);
    JS_FreeValue(context,lightFunction);
    JS_FreeValue(context,frameFunction);
    JS_FreeContext(context);
    JS_FreeRuntime(runtime);
    frameFunction=JS_UNDEFINED;
    lightFunction=JS_UNDEFINED;
    navStatusFunction=JS_UNDEFINED;
    pathSegmentsFunction=JS_UNDEFINED;
    context=nullptr;
    runtime=nullptr;
    ready=false;
}
