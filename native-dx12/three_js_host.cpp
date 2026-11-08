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
JSValue combatFunction = JS_UNDEFINED;
JSValue battleStatusFunction = JS_UNDEFINED;
JSValue quickBattleFunction = JS_UNDEFINED;
bool ready = false;
std::unique_ptr<native_three::NavigationService> navService;
std::vector<native_three::AudioCommand> audioQueue; // shared on the JS/main thread
constexpr std::size_t kAudioMaxQueue=64;
JSValue jsAudioPlay(JSContext* ctx,JSValueConst,int argc,JSValueConst* argv){
    if(argc<1)return JS_ThrowTypeError(ctx,
        "NativeThreeAudio.play(name,x,y,z,volume,spatial=false,loop=false)");
    const char* name=JS_ToCString(ctx,argv[0]);
    if(!name)return JS_EXCEPTION;
    const std::string id(name);
    JS_FreeCString(ctx,name);
    if(!native_three::legalAudioAsset(id))
        return JS_ThrowTypeError(ctx,"Audio ID must be 1-63 ASCII letters, numbers, hyphens or underscores");
    native_three::AudioCommand command{};
    std::memcpy(command.asset,id.c_str(),id.size());
    double* values[4];double x=0,y=0,z=0,volume=1;
    values[0]=&x;values[1]=&y;values[2]=&z;values[3]=&volume;
    for(int i=1;i<argc&&i<=4;i++){
        if(JS_ToFloat64(ctx,values[i-1],argv[i])<0)return JS_EXCEPTION;
    }
    if(!std::isfinite(x)||!std::isfinite(y)||!std::isfinite(z)||
       !std::isfinite(volume)||volume<0||volume>1)
        return JS_ThrowRangeError(ctx,"Audio coordinates/volume must be finite; volume in 0..1");
    command.x=(float)x;command.y=(float)y;command.z=(float)z;
    command.volume=(float)volume;
    if(argc>5)command.spatial=JS_ToBool(ctx,argv[5])>0;
    if(argc>6)command.loop=JS_ToBool(ctx,argv[6])>0;
    if(audioQueue.size()>=kAudioMaxQueue)return JS_NewBool(ctx,false);
    audioQueue.push_back(command);
    return JS_NewBool(ctx,true);
}
void installNativeAudio(JSContext* ctx){
    JSValue global=JS_GetGlobalObject(ctx),api=JS_NewObject(ctx);
    JS_SetPropertyStr(ctx,api,"play",
        JS_NewCFunction(ctx,jsAudioPlay,"play",7));
    JS_SetPropertyStr(ctx,global,"NativeThreeAudio",api);
    JS_FreeValue(ctx,global);
}

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

// The ONLY v0.26.0 engine change: resolve game JS from a local webapp
// index.html manifest. The actual scene bytes, JS runtime, scene ABI, DX12
// renderer, memory allocations, GPU paths and simulation remain unchanged.
static std::string readGameFile(const std::wstring& filename, DWORD maxBytes,
                                const char* missingFile) {
    HANDLE f = CreateFileW(filename.c_str(), GENERIC_READ, FILE_SHARE_READ,
                            nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (f == INVALID_HANDLE_VALUE) die(missingFile);
    LARGE_INTEGER size = {};
    if (!GetFileSizeEx(f, &size) || size.QuadPart < 32 || size.QuadPart > maxBytes) {
        CloseHandle(f);
        die("Webapp entry or game script is empty, invalid or too large.");
    }
    std::string source(static_cast<size_t>(size.QuadPart), '\0');
    DWORD received = 0;
    BOOL ok = ReadFile(f, source.data(), static_cast<DWORD>(source.size()), &received, nullptr);
    CloseHandle(f);
    if (!ok || received != source.size()) die("Unable to read webapp entry or game script.");
    return source;
}
static std::string loadGameScene() {
    wchar_t fullPath[MAX_PATH] = {};
    DWORD n = GetModuleFileNameW(nullptr, fullPath, MAX_PATH);
    if (!n || n >= MAX_PATH) die("Cannot find executable path.");
    std::wstring root(fullPath, n);
    size_t slash = root.find_last_of(L"\\/");
    if (slash == std::wstring::npos) die("Cannot locate executable folder.");
    root.resize(slash);
    root += L"\\game\\";
    // A small, explicit entry point: do not introduce DOM, a browser,
    // WebGLRenderer adapter or a second scene-rendering implementation.
    const std::string html = readGameFile(root + L"index.html", 64 * 1024,
        "Missing game/index.html. Extract the complete webapp ZIP beside the EXE.");
    constexpr const char* tag = "<meta name=\"native-three-entry\" content=\"";
    const size_t start = html.find(tag);
    if (start == std::string::npos)
        die("game/index.html must declare <meta name=\"native-three-entry\" content=\"scene.js\">.");
    const size_t from = start + std::strlen(tag);
    const size_t to = html.find('"', from);
    if (to == std::string::npos || to == from || to - from > 120)
        die("Invalid native-three-entry script name.");
    const std::string entry = html.substr(from, to - from);
    // Single JS asset in the webapp folder only; no traversal or remote URLs.
    if (entry.size() < 4 || entry.substr(entry.size() - 3) != ".js" ||
        entry.find_first_not_of("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-." ) != std::string::npos ||
        entry == "." || entry == "..")
        die("Webapp entry must be a local JS filename in game/.");
    const std::wstring jsFile(entry.begin(), entry.end()); // validated ASCII
    return readGameFile(root + jsFile, 8 * 1024 * 1024,
        "Webapp JavaScript file is missing beside game/index.html.");
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
    installNativeAudio(context);
    const std::string gameScript = loadGameScene();
    result = JS_Eval(context, gameScript.data(), gameScript.size(), "game/scene.js", JS_EVAL_TYPE_GLOBAL);
    if (JS_IsException(result)) dieWithJS("Game scene.js evaluation failed");
    JS_FreeValue(context, result);

    JSValue global = JS_GetGlobalObject(context);
    frameFunction = JS_GetPropertyStr(context, global, "__nativeThreeFrame");
    lightFunction = JS_GetPropertyStr(context, global, "__nativeThreeLightFrame");
    navStatusFunction = JS_GetPropertyStr(context, global, "__nativeThreeNavStats");
    pathSegmentsFunction = JS_GetPropertyStr(context, global, "__nativeThreeDebugSegments");
    combatFunction = JS_GetPropertyStr(context,global,"__nativeThreeCombatFrame");
    battleStatusFunction = JS_GetPropertyStr(context,global,"__nativeThreeBattleStatus");
    quickBattleFunction = JS_GetPropertyStr(context,global,"__nativeThreeQuickBattle");
    JSValue diagnostics = JS_GetPropertyStr(context, global, "__nativeThreeDiagnostics");
    if (!JS_IsFunction(context, frameFunction) ||
        !JS_IsFunction(context, lightFunction) ||
        !JS_IsFunction(context, navStatusFunction) ||
        !JS_IsFunction(context, pathSegmentsFunction) ||
        !JS_IsFunction(context, combatFunction) ||
        !JS_IsFunction(context, battleStatusFunction) ||
        !JS_IsFunction(context, quickBattleFunction) ||
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
void NativeThreeJS_CombatStates(float* out,std::size_t capacity) {
    constexpr std::size_t count=1000*4;
    if(!ready||!out||capacity<count)die("Combat state buffer invalid");
    JSValue result=JS_Call(context,combatFunction,JS_UNDEFINED,0,nullptr);
    if(JS_IsException(result))dieWithJS("Combat poses from JavaScript");
    size_t offset=0,length=0,elementBytes=0;
    JSValue buffer=JS_GetTypedArrayBuffer(context,result,&offset,&length,&elementBytes);
    if(JS_IsException(buffer)||elementBytes!=sizeof(float)||
       length!=count*sizeof(float))die("Combat poses require Float32Array(4000)");
    size_t bufferLength=0;
    uint8_t* bytes=JS_GetArrayBuffer(context,&bufferLength,buffer);
    if(!bytes||offset+length>bufferLength)die("Combat data outside ArrayBuffer");
    std::memcpy(out,bytes+offset,length);
    JS_FreeValue(context,buffer);
    JS_FreeValue(context,result);
}
void NativeThreeJS_GetBattleStatus(NativeThreeBattleStatus* out){
    if(!ready||!out)die("Battle status: runtime unavailable");
    JSValue stats=JS_Call(context,battleStatusFunction,JS_UNDEFINED,0,nullptr);
    if(JS_IsException(stats))dieWithJS("Battle status call");
    const char* keys[]={"aliveRed","aliveBlue","deaths","hits","attacks","engaged",
                         "frontHits","sideHits","rearHits","winner","returning","returned"};
    int* dest[]={&out->aliveRed,&out->aliveBlue,&out->deaths,&out->hits,
                 &out->attacks,&out->engaged,&out->frontHits,&out->sideHits,
                 &out->rearHits,&out->winner,&out->returning,&out->returned};
    for(int i=0;i<12;i++){
        JSValue v=JS_GetPropertyStr(context,stats,keys[i]);
        if(JS_IsException(v)||JS_ToInt32(context,dest[i],v)<0)
            dieWithJS("Invalid battle counter");
        JS_FreeValue(context,v);
    }
    JS_FreeValue(context,stats);
}
bool NativeThreeJS_QuickBattle(){
    if(!ready)return false;
    JSValue result=JS_Call(context,quickBattleFunction,JS_UNDEFINED,0,nullptr);
    if(JS_IsException(result))dieWithJS("F12 quick battle");
    const bool success=JS_ToBool(context,result)>0;
    JS_FreeValue(context,result);
    return success;
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
std::size_t NativeThreeJS_PopAudioCommands(native_three::AudioCommand* out,
                                           std::size_t capacity){
    if(!out||!capacity)return 0;
    const auto count=std::min(capacity,audioQueue.size());
    std::copy_n(audioQueue.begin(),count,out);
    audioQueue.erase(audioQueue.begin(),audioQueue.begin()+count);
    return count;
}
bool NativeThreeJS_TriggerAudioTest(){
    if(!ready)return false;
    JSValue global=JS_GetGlobalObject(context);
    JSValue func=JS_GetPropertyStr(context,global,"__nativeThreeAudioTest");
    bool success=false;
    if(JS_IsFunction(context,func)){
        JSValue result=JS_Call(context,func,JS_UNDEFINED,0,nullptr);
        if(JS_IsException(result))dieWithJS("NativeThreeAudio test dispatch");
        success=JS_ToBool(context,result)>0;
        JS_FreeValue(context,result);
    }
    JS_FreeValue(context,func);
    JS_FreeValue(context,global);
    return success;
}
void NativeThreeJS_Restart() {
    NativeThreeJS_Shutdown();
    NativeThreeJS_Init();
}
void NativeThreeJS_Shutdown() {
    audioQueue.clear(); // no sound from a previous game's lifetime leaks in
    // Worker pool may own in-flight navigation requests. Shutdown does not
    // wait for queued work to finish, and no worker touches the JS context.
    navService.reset();
    if (!ready) return;
    JS_FreeValue(context,pathSegmentsFunction);
    JS_FreeValue(context,combatFunction);
    JS_FreeValue(context,battleStatusFunction);
    JS_FreeValue(context,quickBattleFunction);
    JS_FreeValue(context,navStatusFunction);
    JS_FreeValue(context,lightFunction);
    JS_FreeValue(context,frameFunction);
    JS_FreeContext(context);
    JS_FreeRuntime(runtime);
    frameFunction=JS_UNDEFINED;
    lightFunction=JS_UNDEFINED;
    navStatusFunction=JS_UNDEFINED;
    pathSegmentsFunction=JS_UNDEFINED;
    combatFunction=JS_UNDEFINED;
    battleStatusFunction=JS_UNDEFINED;
    quickBattleFunction=JS_UNDEFINED;
    context=nullptr;
    runtime=nullptr;
    ready=false;
}
