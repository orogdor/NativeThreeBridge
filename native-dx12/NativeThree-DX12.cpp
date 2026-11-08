// NativeThreeBridge DX12 benchmark v0.8.0.
// 1000 original Sapling pine trees + two 10-spearman A* armies in real Three.js.
// Assets are generated from pinned GLBs and embedded as RCDATA by GitHub Actions.
// No Chromium, WebView, Node, Deno or Python is used at runtime.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <windowsx.h>
#include <d3d12.h>
#include <dxgi1_6.h>
#include <d3dcompiler.h>
#include <DirectXMath.h>
#include <wrl/client.h>
#include <cstdint>
#include <cstring>
#include <cmath>
#include <cstdio>
#include <cwchar>
#include <vector>
#include <algorithm>
#include "three_js_host.h"
#include "spatial_index.h"
#include "fixed_stepper.h"
#include "scene_registry.h"
#include "frame_profiler.h"

#pragma comment(lib,"d3d12.lib")
#pragma comment(lib,"dxgi.lib")
#pragma comment(lib,"d3dcompiler.lib")
#pragma comment(lib,"user32.lib")

using Microsoft::WRL::ComPtr;
using namespace DirectX;

static const UINT WIDTH=1152, HEIGHT=768, FRAME_COUNT=2, MESH_COUNT=4;
static const UINT SHADOW_COUNT=16, SHADOW_SIZE=256;
static const UINT TREE_COUNT=10000, LIGHT_COUNT=1000, PER_ARMY=500, INSTANCE_COUNT=11000;
static const UINT GRID_DIM=16, MAX_CELL_LIGHTS=16;
static HWND gWindow=nullptr;
static float gYaw=0.52f, gPitch=0.85f, gDistance=780.0f;
static UINT gCameraMode=0; // 1=red, 2=blue, 0=forest overview
static float gCameraFocusX=0.0f,gCameraFocusZ=0.0f;
static bool gShowDebugPaths=false; // avoid bright diagnostic overlay during night lighting tests
static ULONGLONG gLastPathRefresh=0;
static bool gEnableShadows=true;
static bool gVSync=false; // F6 toggles VSync for uncapped benchmarking
static bool gNightMode=true; // Night default; F7 toggles day/night
static double gPreviousFrameSeconds=0;
static double gJsCpuMsTotal=0,gLightCpuMsTotal=0,gRecordCpuMsTotal=0,gPresentCpuMsTotal=0;
static double gLastJSms=0,gLastLightMs=0,gLastRecordMs=0,gLastPresentMs=0,gLastFenceMs=0;
static UINT64 gTotalFrames=0;
static native_three::AsyncCsvLogger gPerfLog("NativeThreeBridge-frames.csv");
static double cpuSeconds() {
    LARGE_INTEGER ticks{},frequency{};
    QueryPerformanceCounter(&ticks);
    static const double inverseFrequency=[](){
        LARGE_INTEGER freq{};QueryPerformanceFrequency(&freq);
        return 1.0/(double)freq.QuadPart;
    }();
    return (double)ticks.QuadPart*inverseFrequency;
}
static bool gDrag=false,gPause=false;
static int gMouseX=0,gMouseY=0;
static ULONGLONG gStatStart=0, gPreviousFrame=0;
static UINT gStatFrames=0;
static wchar_t gAdapterName[128]=L"Unknown GPU";
static bool gUsingWARP=false;

static ComPtr<ID3D12Device> gDevice;
static ComPtr<ID3D12CommandQueue> gQueue;
static ComPtr<IDXGISwapChain3> gSwap;
static ComPtr<ID3D12DescriptorHeap> gRTVHeap,gDSVHeap,gSRVHeap;
static ComPtr<ID3D12Resource> gTargets[FRAME_COUNT],gDepth;
static ComPtr<ID3D12CommandAllocator> gAllocator;
static ComPtr<ID3D12GraphicsCommandList> gCmd;
static ComPtr<ID3D12Fence> gFence;
static ComPtr<ID3D12RootSignature> gRoot;
static ComPtr<ID3D12PipelineState> gPSO,gShadowPSO;
static ComPtr<ID3D12Resource> gFrameCB,gInstancesCB,gSoldierCB,gLightsCB,gGridCB,gShadowCameraCB,gShadowDepth;
static ComPtr<ID3D12QueryHeap> gGpuTimingQueries;
static ComPtr<ID3D12Resource> gGpuTimingReadback;
static UINT64 gGpuTimingFrequency=0;
static double gGpuShadowTotal=0,gGpuMainTotal=0;
static double gLastGpuShadowMs=0,gLastGpuMainMs=0;
static UINT gGpuTimingSamples=0;
static const UINT GPU_TIMESTAMPS_PER_FRAME=3;
static bool gTreesUploaded=false;
static ComPtr<ID3D12Resource> gDebugPathVB;
static D3D12_VERTEX_BUFFER_VIEW gDebugPathVBV{};
static UINT gDebugRedVertices=0,gDebugBlueVertices=0;
static UINT gShadowSourceIndices[SHADOW_COUNT]{};
static UINT gShadowVisibleCounts[SHADOW_COUNT][3]{};
static ComPtr<ID3D12Resource> gShadowIndexBuffers[FRAME_COUNT],gShadowIndexCB;
static D3D12_GPU_DESCRIPTOR_HANDLE gShadowIndexSRV[FRAME_COUNT]{};
static HANDLE gFenceEvent=NULL;
static UINT64 gFenceValue=0;
struct RetiredResource { UINT64 fenceValue; ComPtr<ID3D12Resource> resource; };
static std::vector<RetiredResource> gRetiredResources;
static ComPtr<ID3D12CommandAllocator> gFrameAllocators[FRAME_COUNT];
static ComPtr<ID3D12Resource> gCameraBuffers[FRAME_COUNT],gSoldierBuffers[FRAME_COUNT],
    gLightBuffers[FRAME_COUNT],gGridBuffers[FRAME_COUNT],gShadowCameraBuffers[FRAME_COUNT];
static UINT64 gFrameFenceValues[FRAME_COUNT]={};
static UINT gRTVStep=0,gSRVStep=0;
static D3D12_CPU_DESCRIPTOR_HANDLE gShadowDSV[SHADOW_COUNT]{};
static D3D12_GPU_DESCRIPTOR_HANDLE gShadowSRV{},gTreeSRV{};
static UINT gMainVisibleTrees=0;
// Shared engine spatial lookups. Object classes do not affect the index.
static native_three::SpatialIndex2D gStaticObjects(36.f);
static native_three::SpatialIndex2D gDynamicLights(36.f);
static bool gStaticObjectsRegistered=false;
static native_three::SceneRegistry gSceneRegistry;
static std::vector<native_three::ObjectHandle> gMovingObjectHandles;
static UINT gDirtySceneObjects=0;
static UINT gLightCandidateChecks=0,gShadowTreeCandidateChecks=0,gVisibleTreeCandidateChecks=0;
static double gFenceWaitTotal=0,gWorstFrameMs=0,gLastFrameEndSeconds=0;
static D3D12_VIEWPORT gViewport={0,0,(float)WIDTH,(float)HEIGHT,0,1};
static D3D12_RECT gScissor={0,0,(LONG)WIDTH,(LONG)HEIGHT};

struct Vertex {float x,y,z,nx,ny,nz,u,v;};
struct MeshHeader {char magic[4];uint32_t vertices,indices,reserved;};
struct DrawParams {UINT kind;float scale;float yOffset;float alphaCut;float tint[4];UINT shadowOffset=0,shadowPass=0;float night=1.f;};
struct Mesh {
    ComPtr<ID3D12Resource> vertices,indices,texture;
    D3D12_VERTEX_BUFFER_VIEW vbv={};
    D3D12_INDEX_BUFFER_VIEW ibv={};
    UINT indexCount=0;
    D3D12_GPU_DESCRIPTOR_HANDLE srv={};
    DrawParams draw={};
};
static Mesh gMesh[MESH_COUNT];

static void fatal(const char *step,HRESULT hr) {
    char text[400];
    sprintf_s(text,"NativeThreeBridge DX12 v0.9 failed at:\n%s\nHRESULT: 0x%08X\n\nSee the Windows graphics driver and DX12 support.",step,(unsigned int)hr);
    MessageBoxA(gWindow,text,"NativeThreeBridge DX12 error",MB_OK|MB_ICONERROR);
    ExitProcess(10);
}
static void check(HRESULT hr,const char *step) {if(FAILED(hr))fatal(step,hr);}
static D3D12_HEAP_PROPERTIES heapProperties(D3D12_HEAP_TYPE type) {
    D3D12_HEAP_PROPERTIES p={};p.Type=type;
    p.CPUPageProperty=D3D12_CPU_PAGE_PROPERTY_UNKNOWN;
    p.MemoryPoolPreference=D3D12_MEMORY_POOL_UNKNOWN;
    p.CreationNodeMask=1;p.VisibleNodeMask=1;return p;
}
static D3D12_RESOURCE_DESC bufferDescription(UINT64 length) {
    D3D12_RESOURCE_DESC d={};d.Dimension=D3D12_RESOURCE_DIMENSION_BUFFER;
    d.Width=length;d.Height=1;d.DepthOrArraySize=1;d.MipLevels=1;
    d.Format=DXGI_FORMAT_UNKNOWN;d.SampleDesc.Count=1;
    d.Layout=D3D12_TEXTURE_LAYOUT_ROW_MAJOR;return d;
}
static ComPtr<ID3D12Resource> uploadBuffer(const void *bytes,UINT64 length) {
    ComPtr<ID3D12Resource> out;
    auto heap=heapProperties(D3D12_HEAP_TYPE_UPLOAD);
    auto desc=bufferDescription(length);
    check(gDevice->CreateCommittedResource(&heap,D3D12_HEAP_FLAG_NONE,&desc,
        D3D12_RESOURCE_STATE_GENERIC_READ,NULL,IID_PPV_ARGS(&out)),"Create upload buffer");
    if(bytes) {
        void *mapped=nullptr;
        check(out->Map(0,nullptr,&mapped),"Map upload buffer");
        memcpy(mapped,bytes,(size_t)length);
        out->Unmap(0,nullptr);
    }
    return out;
}
static D3D12_RESOURCE_BARRIER transition(ID3D12Resource *resource,D3D12_RESOURCE_STATES before,D3D12_RESOURCE_STATES after) {
    D3D12_RESOURCE_BARRIER b={};
    b.Type=D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;
    b.Transition.pResource=resource;
    b.Transition.Subresource=D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES;
    b.Transition.StateBefore=before;b.Transition.StateAfter=after;
    return b;
}
static void waitGPU() {
    const UINT64 value=++gFenceValue;
    check(gQueue->Signal(gFence.Get(),value),"Signal GPU fence");
    if(gFence->GetCompletedValue()<value) {
        check(gFence->SetEventOnCompletion(value,gFenceEvent),"Fence event");
        WaitForSingleObject(gFenceEvent,INFINITE);
    }
}
// Static geometry lives in GPU-local DEFAULT memory; upload heaps are staging only.
static ComPtr<ID3D12Resource> staticGpuBuffer(const void *bytes,UINT64 length,
                                              D3D12_RESOURCE_STATES finalState) {
    ComPtr<ID3D12Resource> gpu;
    auto heap=heapProperties(D3D12_HEAP_TYPE_DEFAULT);
    auto desc=bufferDescription(length);
    check(gDevice->CreateCommittedResource(&heap,D3D12_HEAP_FLAG_NONE,&desc,
          D3D12_RESOURCE_STATE_COPY_DEST,nullptr,IID_PPV_ARGS(&gpu)),
          "Create GPU-local mesh buffer");
    auto staging=uploadBuffer(bytes,length);
    check(gAllocator->Reset(),"Reset static mesh upload allocator");
    check(gCmd->Reset(gAllocator.Get(),nullptr),"Reset static mesh upload commands");
    gCmd->CopyBufferRegion(gpu.Get(),0,staging.Get(),0,length);
    auto barrier=transition(gpu.Get(),D3D12_RESOURCE_STATE_COPY_DEST,finalState);
    gCmd->ResourceBarrier(1,&barrier);
    check(gCmd->Close(),"Close static mesh upload commands");
    ID3D12CommandList *lists[]={gCmd.Get()};
    gQueue->ExecuteCommandLists(1,lists);
    waitGPU(); // Initialization only: GPU must complete copy before releasing staging.
    return gpu;
}
static const BYTE *resourceBytes(int id,DWORD *size) {
    HRSRC res=FindResourceW(NULL,MAKEINTRESOURCEW(id),RT_RCDATA);
    if(!res)fatal("Missing embedded original GLB model resource",HRESULT_FROM_WIN32(GetLastError()));
    HGLOBAL h=LoadResource(NULL,res);
    if(!h)fatal("Load embedded model",HRESULT_FROM_WIN32(GetLastError()));
    *size=SizeofResource(NULL,res);
    const BYTE *p=(const BYTE*)LockResource(h);
    if(!p || !*size)fatal("Empty embedded model",E_INVALIDARG);
    return p;
}
static void makeTexture(UINT meshIndex,int resourceID) {
    DWORD size=0;
    const BYTE *raw=resourceBytes(resourceID,&size);
    if(size<8)fatal("Invalid packed RGBA header",E_INVALIDARG);
    UINT width=0,height=0;
    memcpy(&width,raw,4);memcpy(&height,raw+4,4);
    if(!width||!height||width>4096||height>4096||(UINT64)width*height*4+8!=size)
        fatal("Invalid packed RGBA pixels",E_INVALIDARG);

    D3D12_RESOURCE_DESC desc={};
    desc.Dimension=D3D12_RESOURCE_DIMENSION_TEXTURE2D;
    desc.Width=width;desc.Height=height;desc.DepthOrArraySize=1;
    desc.MipLevels=1;desc.Format=DXGI_FORMAT_R8G8B8A8_UNORM;
    desc.SampleDesc.Count=1;desc.Layout=D3D12_TEXTURE_LAYOUT_UNKNOWN;
    auto heap=heapProperties(D3D12_HEAP_TYPE_DEFAULT);
    check(gDevice->CreateCommittedResource(&heap,D3D12_HEAP_FLAG_NONE,&desc,
          D3D12_RESOURCE_STATE_COPY_DEST,nullptr,IID_PPV_ARGS(&gMesh[meshIndex].texture)),
          "Create model texture");
    D3D12_PLACED_SUBRESOURCE_FOOTPRINT fp={};
    UINT rows=0;UINT64 rowSize=0,totalBytes=0;
    gDevice->GetCopyableFootprints(&desc,0,1,0,&fp,&rows,&rowSize,&totalBytes);
    auto staging=uploadBuffer(nullptr,totalBytes);
    BYTE *dst=nullptr;
    check(staging->Map(0,nullptr,(void**)&dst),"Map texture staging");
    for(UINT y=0;y<height;y++)
        memcpy(dst+fp.Offset+(UINT64)y*fp.Footprint.RowPitch,
               raw+8+(UINT64)y*width*4,(size_t)width*4);
    staging->Unmap(0,nullptr);

    check(gAllocator->Reset(),"Reset allocator for texture");
    check(gCmd->Reset(gAllocator.Get(),nullptr),"Reset command list for texture");
    D3D12_TEXTURE_COPY_LOCATION src={},tgt={};
    src.pResource=staging.Get();src.Type=D3D12_TEXTURE_COPY_TYPE_PLACED_FOOTPRINT;
    src.PlacedFootprint=fp;
    tgt.pResource=gMesh[meshIndex].texture.Get();
    tgt.Type=D3D12_TEXTURE_COPY_TYPE_SUBRESOURCE_INDEX;
    tgt.SubresourceIndex=0;
    gCmd->CopyTextureRegion(&tgt,0,0,0,&src,nullptr);
    auto b=transition(gMesh[meshIndex].texture.Get(),
                      D3D12_RESOURCE_STATE_COPY_DEST,D3D12_RESOURCE_STATE_PIXEL_SHADER_RESOURCE);
    gCmd->ResourceBarrier(1,&b);
    check(gCmd->Close(),"Close upload command list");
    ID3D12CommandList *lists[]={gCmd.Get()};
    gQueue->ExecuteCommandLists(1,lists);
    waitGPU();

    D3D12_SHADER_RESOURCE_VIEW_DESC view={};
    view.Format=DXGI_FORMAT_R8G8B8A8_UNORM;
    view.ViewDimension=D3D12_SRV_DIMENSION_TEXTURE2D;
    view.Shader4ComponentMapping=D3D12_DEFAULT_SHADER_4_COMPONENT_MAPPING;
    view.Texture2D.MipLevels=1;
    D3D12_CPU_DESCRIPTOR_HANDLE cpu=gSRVHeap->GetCPUDescriptorHandleForHeapStart();
    cpu.ptr+=(SIZE_T)meshIndex*gSRVStep;
    gDevice->CreateShaderResourceView(gMesh[meshIndex].texture.Get(),&view,cpu);
    gMesh[meshIndex].srv=gSRVHeap->GetGPUDescriptorHandleForHeapStart();
    gMesh[meshIndex].srv.ptr+=(UINT64)meshIndex*gSRVStep;
}
static void loadMesh(UINT meshIndex,int meshRes,int texRes,DrawParams draw) {
    DWORD size=0;
    const BYTE *raw=resourceBytes(meshRes,&size);
    if(size<sizeof(MeshHeader))fatal("Packed mesh header missing",E_INVALIDARG);
    MeshHeader h={};memcpy(&h,raw,sizeof(h));
    const UINT64 vertexBytes=(UINT64)h.vertices*sizeof(Vertex);
    const UINT64 indexBytes=(UINT64)h.indices*sizeof(uint32_t);
    if(memcmp(h.magic,"NTM1",4)||!h.vertices||!h.indices||h.indices%3 ||
       sizeof(h)+vertexBytes+indexBytes!=size)
        fatal("Packed mesh invalid",E_INVALIDARG);
    Mesh &m=gMesh[meshIndex];
    m.vertices=staticGpuBuffer(raw+sizeof(h),vertexBytes,
                               D3D12_RESOURCE_STATE_VERTEX_AND_CONSTANT_BUFFER);
    m.indices=staticGpuBuffer(raw+sizeof(h)+vertexBytes,indexBytes,
                              D3D12_RESOURCE_STATE_INDEX_BUFFER);
    m.vbv.BufferLocation=m.vertices->GetGPUVirtualAddress();
    m.vbv.SizeInBytes=(UINT)vertexBytes;
    m.vbv.StrideInBytes=sizeof(Vertex);
    m.ibv.BufferLocation=m.indices->GetGPUVirtualAddress();
    m.ibv.SizeInBytes=(UINT)indexBytes;
    m.ibv.Format=DXGI_FORMAT_R32_UINT;
    m.indexCount=h.indices;
    m.draw=draw;
    makeTexture(meshIndex,texRes);
}

static void createDebugRouteGeometry() {
    // Exactly the A* routes produced by game/scene.js, not hand-authored lines.
    // Each record is [team,x1,z1,x2,z2]. Build static emissive triangle strips.
    std::vector<float> segments(60000);
    const size_t used=NativeThreeJS_DebugSegments(segments.data(),segments.size());
    std::vector<Vertex> red,blue;
    red.reserve(used/5*3);blue.reserve(used/5*3);
    for(size_t i=0;i+4<used;i+=5){
        const int team=(int)segments[i];
        const float x1=segments[i+1],z1=segments[i+2];
        const float x2=segments[i+3],z2=segments[i+4];
        if((team!=0 && team!=1) || !std::isfinite(x1) || !std::isfinite(z1) ||
           !std::isfinite(x2) || !std::isfinite(z2))
            fatal("A* path overlay contains invalid coordinates",E_INVALIDARG);
        const float dx=x2-x1,dz=z2-z1;
        const float len=sqrtf(dx*dx+dz*dz);
        if(len<0.001f)continue;
        const float halfWidth=0.30f;
        const float px=-dz/len*halfWidth,pz=dx/len*halfWidth;
        const Vertex a={x1+px,0.12f,z1+pz,0,1,0,0,0};
        const Vertex b={x1-px,0.12f,z1-pz,0,1,0,0,0};
        const Vertex c={x2+px,0.12f,z2+pz,0,1,0,0,0};
        const Vertex d={x2-px,0.12f,z2-pz,0,1,0,0,0};
        auto &v=team==0?red:blue;
        v.push_back(a);v.push_back(b);v.push_back(c);
        v.push_back(c);v.push_back(b);v.push_back(d);
    }
    // Some units may reach their goal; one army having no remaining route
    // is normal and must not crash the renderer.
    if(red.empty()&&blue.empty()){
        if(gDebugPathVB)gRetiredResources.push_back({gFenceValue,gDebugPathVB});
        gDebugPathVB.Reset();
        gDebugRedVertices=0;gDebugBlueVertices=0;
        return;
    }
    gDebugRedVertices=(UINT)red.size();
    gDebugBlueVertices=(UINT)blue.size();
    red.insert(red.end(),blue.begin(),blue.end());
    const UINT64 bytes=(UINT64)red.size()*sizeof(Vertex);
    if(gDebugPathVB)gRetiredResources.push_back({gFenceValue,gDebugPathVB});
    gDebugPathVB=uploadBuffer(red.data(),bytes);
    gDebugPathVBV.BufferLocation=gDebugPathVB->GetGPUVirtualAddress();
    gDebugPathVBV.StrideInBytes=sizeof(Vertex);
    gDebugPathVBV.SizeInBytes=(UINT)bytes;
}

static void makeGround() {
    Vertex v[]={
        {-540,0,-540,0,1,0,0,0},{540,0,-540,0,1,0,1,0},
        {-540,0,540,0,1,0,0,1},{540,0,540,0,1,0,1,1}
    };
    uint32_t idx[]={0,2,1,1,2,3};
    Mesh &m=gMesh[3];
    m.vertices=staticGpuBuffer(v,sizeof(v),D3D12_RESOURCE_STATE_VERTEX_AND_CONSTANT_BUFFER);
    m.indices=staticGpuBuffer(idx,sizeof(idx),D3D12_RESOURCE_STATE_INDEX_BUFFER);
    m.vbv={m.vertices->GetGPUVirtualAddress(),sizeof(v),sizeof(Vertex)};
    m.ibv={m.indices->GetGPUVirtualAddress(),sizeof(idx),DXGI_FORMAT_R32_UINT};
    m.indexCount=6;
    m.draw={2,1.0f,0,0,{0.25f,0.35f,0.27f,1.0f}};
    // reuse the 1x1 bark "white" texture from converted mesh 1, but tint green.
    m.srv=gMesh[1].srv;
}
static const char *SHADER=R"(
cbuffer Camera : register(b0) { float4x4 gViewProjection; };
cbuffer Draw : register(b1) {
    uint gKind;
    float gScale;
    float gYOffset;
    float gAlphaCut;
    float4 gTint;
    uint gShadowOffset;
    uint gShadowPass;
    float gNight;
};
// 10000 trees require 640 KB: too large for the DX12 64 KB constant buffer limit.
StructuredBuffer<float4x4> gTreeInstances : register(t3);
cbuffer SoldierTransforms : register(b5) { float4x4 gSoldierInstances[1000]; };
cbuffer Lights : register(b3) {
    float4x4 gLightVP[16];
    float4 gLightPosRadius[1000];
    float4 gLightColorIntensity[1000];
    float4 gShadowSlots[1000];
};
cbuffer LightGrid : register(b4) {
    uint4 gGridCounts[64];
    uint4 gGridIndices[1024];
};
Texture2D gTexture : register(t0);
Texture2DArray gShadowDepthTexture : register(t1);
Buffer<uint> gShadowInstanceIDs : register(t2);
SamplerState gSampler : register(s0);
SamplerState gShadowSampler : register(s1);
struct Vin { float3 p:POSITION; float3 n:NORMAL; float2 uv:TEXCOORD0; };
struct Vout {
    float4 p:SV_POSITION;
    float3 n:NORMAL;
    float2 uv:TEXCOORD0;
    float3 worldPos:TEXCOORD1;
};
Vout VSMain(Vin v, uint instance:SV_InstanceID) {
    Vout o;
    uint sourceInstance=gShadowPass!=0 ? gShadowInstanceIDs[gShadowOffset+instance] : instance;
    float3 p=v.p*gScale+float3(0,gYOffset,0);
    float3 n=v.n;
    if(gKind!=2 && gKind!=4){
        float4x4 instanceTransform;
        if(gKind==0) instanceTransform=gTreeInstances[sourceInstance];
        else instanceTransform=gSoldierInstances[sourceInstance+(gKind==3?500:0)];
        p=mul(instanceTransform,float4(v.p*gScale,1)).xyz+
          float3(0,gYOffset,0);
        n=mul((float3x3)instanceTransform,v.n);
    }
    o.p=mul(float4(p,1),gViewProjection);
    o.n=normalize(n);
    o.uv=v.uv;
    o.worldPos=p;
    return o;
}
void PSShadow(Vout v) {
    if(gAlphaCut>0) clip(gTexture.Sample(gSampler,v.uv).a-gAlphaCut);
}
float shadowVisibility(float3 worldPos,uint li) {
    int slot=(int)gShadowSlots[li].x;
    if(slot<0 || slot>=16) return 1;
    float4 shadowPos=mul(float4(worldPos,1),gLightVP[slot]);
    if(shadowPos.w<=0.001) return 1;
    float3 ndc=shadowPos.xyz/shadowPos.w;
    float2 uv=float2(ndc.x*0.5+0.5,0.5-ndc.y*0.5);
    if(any(uv<0) || any(uv>1) || ndc.z<0 || ndc.z>1) return 1;
    float sampled=gShadowDepthTexture.SampleLevel(
        gShadowSampler,float3(uv,(float)slot),0).r;
    return (ndc.z-0.0015<=sampled)?1.0:0.20;
}
float4 PSMain(Vout v):SV_TARGET {
    // A* route guides: emissive red/yellow and cyan ground stripes.
    if(gKind==4) return float4(gTint.rgb,1);
    float4 albedo=gTexture.Sample(gSampler,v.uv)*gTint;
    if(gAlphaCut>0)clip(albedo.a-gAlphaCut);
    float3 normal=normalize(v.n);
    float diffuseSky=abs(dot(normal,normalize(float3(0.32,0.84,0.41))));
    float day=lerp(0.20+0.34*diffuseSky,0.018+0.026*diffuseSky,gNight);
    float3 illumination=day.xxx;
    // CPU bins all 1000 moving lights into 16x16 tiles across the expanded forest.
    // Only the nearest 16 in this tile are evaluated per pixel.
    int gx=clamp((int)floor((v.worldPos.x+540.0)/67.5),0,15);
    int gz=clamp((int)floor((v.worldPos.z+540.0)/67.5),0,15);
    uint cell=(uint)(gz*16+gx);
    uint count=gGridCounts[cell/4][cell%4];
    [loop] for(uint k=0;k<count;k++){
        uint index=gGridIndices[cell*4+k/4][k%4];
        if(index>=1000)continue;
        float3 toLight=gLightPosRadius[index].xyz-v.worldPos;
        float distSq=dot(toLight,toLight);
        float radius=gLightPosRadius[index].w;
        if(distSq<0.000001 || distSq>=radius*radius)continue;
        float invDist=rsqrt(distSq);
        float dist=distSq*invDist;
        float3 direction=toLight*invDist;
        // All offset lamps aim diagonally back toward their soldiers.
        float cone=dot(direction,normalize(float3(6.0,12.5,4.0)));
        if(cone<0.5)continue;
        float diff=saturate(dot(normal,direction));
        if(diff<=0)continue;
        float fade=saturate((cone-0.5)/0.22);
        float falloff=saturate(1.0-dist/radius);
        float vis=shadowVisibility(v.worldPos,index);
        illumination+=gLightColorIntensity[index].rgb*
            (gLightColorIntensity[index].a*falloff*falloff*fade*diff*vis*lerp(0.42,0.90,gNight));
    }
    return float4(saturate(albedo.rgb*illumination),1);
}
)";
static void makePipeline() {
    D3D12_ROOT_PARAMETER rp[9]={};
    rp[0].ParameterType=D3D12_ROOT_PARAMETER_TYPE_CBV;
    rp[0].Descriptor.ShaderRegister=0;
    rp[0].ShaderVisibility=D3D12_SHADER_VISIBILITY_VERTEX;
    rp[1].ParameterType=D3D12_ROOT_PARAMETER_TYPE_32BIT_CONSTANTS;
    rp[1].Constants.ShaderRegister=1;
    rp[1].Constants.Num32BitValues=11;
    rp[1].ShaderVisibility=D3D12_SHADER_VISIBILITY_ALL;
    D3D12_DESCRIPTOR_RANGE ranges[4]={};
    for(UINT i=0;i<3;i++){
        ranges[i].RangeType=D3D12_DESCRIPTOR_RANGE_TYPE_SRV;
        ranges[i].NumDescriptors=1;
        ranges[i].BaseShaderRegister=i;
    }
    rp[2].ParameterType=D3D12_ROOT_PARAMETER_TYPE_DESCRIPTOR_TABLE;
    rp[2].DescriptorTable.NumDescriptorRanges=1;
    rp[2].DescriptorTable.pDescriptorRanges=&ranges[0];
    rp[2].ShaderVisibility=D3D12_SHADER_VISIBILITY_PIXEL;
    // Tree instance transforms are an SRV (10000 * 64B), not a 64KB CBV.
    ranges[3].RangeType=D3D12_DESCRIPTOR_RANGE_TYPE_SRV;
    ranges[3].NumDescriptors=1;
    ranges[3].BaseShaderRegister=3;
    rp[3].ParameterType=D3D12_ROOT_PARAMETER_TYPE_DESCRIPTOR_TABLE;
    rp[3].DescriptorTable.NumDescriptorRanges=1;
    rp[3].DescriptorTable.pDescriptorRanges=&ranges[3];
    rp[3].ShaderVisibility=D3D12_SHADER_VISIBILITY_VERTEX;
    rp[4].ParameterType=D3D12_ROOT_PARAMETER_TYPE_DESCRIPTOR_TABLE;
    rp[4].DescriptorTable.NumDescriptorRanges=1;
    rp[4].DescriptorTable.pDescriptorRanges=&ranges[1];
    rp[4].ShaderVisibility=D3D12_SHADER_VISIBILITY_PIXEL;
    rp[5].ParameterType=D3D12_ROOT_PARAMETER_TYPE_CBV;
    rp[5].Descriptor.ShaderRegister=3;
    rp[5].ShaderVisibility=D3D12_SHADER_VISIBILITY_PIXEL;
    rp[6].ParameterType=D3D12_ROOT_PARAMETER_TYPE_CBV;
    rp[6].Descriptor.ShaderRegister=4;
    rp[6].ShaderVisibility=D3D12_SHADER_VISIBILITY_PIXEL;
    rp[7].ParameterType=D3D12_ROOT_PARAMETER_TYPE_CBV;
    rp[7].Descriptor.ShaderRegister=5;
    rp[7].ShaderVisibility=D3D12_SHADER_VISIBILITY_VERTEX;
    rp[8].ParameterType=D3D12_ROOT_PARAMETER_TYPE_DESCRIPTOR_TABLE;
    rp[8].DescriptorTable.NumDescriptorRanges=1;
    rp[8].DescriptorTable.pDescriptorRanges=&ranges[2];
    rp[8].ShaderVisibility=D3D12_SHADER_VISIBILITY_VERTEX;
    D3D12_STATIC_SAMPLER_DESC samplers[2]={};
    samplers[0].Filter=D3D12_FILTER_MIN_MAG_MIP_LINEAR;
    samplers[0].AddressU=samplers[0].AddressV=samplers[0].AddressW=D3D12_TEXTURE_ADDRESS_MODE_WRAP;
    samplers[0].ComparisonFunc=D3D12_COMPARISON_FUNC_ALWAYS;
    samplers[0].MaxLOD=D3D12_FLOAT32_MAX;
    samplers[0].ShaderRegister=0;
    samplers[0].ShaderVisibility=D3D12_SHADER_VISIBILITY_PIXEL;
    samplers[1]=samplers[0];
    samplers[1].Filter=D3D12_FILTER_MIN_MAG_MIP_POINT;
    samplers[1].AddressU=samplers[1].AddressV=samplers[1].AddressW=D3D12_TEXTURE_ADDRESS_MODE_CLAMP;
    samplers[1].ShaderRegister=1;
    D3D12_ROOT_SIGNATURE_DESC rs={};
    rs.NumParameters=9;rs.pParameters=rp;
    rs.NumStaticSamplers=2;rs.pStaticSamplers=samplers;
    rs.Flags=D3D12_ROOT_SIGNATURE_FLAG_ALLOW_INPUT_ASSEMBLER_INPUT_LAYOUT;
    ComPtr<ID3DBlob> signature,error;
    HRESULT hr=D3D12SerializeRootSignature(&rs,D3D_ROOT_SIGNATURE_VERSION_1,&signature,&error);
    if(FAILED(hr)){
        if(error)MessageBoxA(gWindow,(char*)error->GetBufferPointer(),"Root Signature",MB_OK);
        fatal("D3D12SerializeRootSignature",hr);
    }
    check(gDevice->CreateRootSignature(0,signature->GetBufferPointer(),
          signature->GetBufferSize(),IID_PPV_ARGS(&gRoot)),"Create root signature");

    ComPtr<ID3DBlob> vs,ps,shadowPS;
    hr=D3DCompile(SHADER,strlen(SHADER),"shader",nullptr,nullptr,"VSMain","vs_5_0",
                  D3DCOMPILE_ENABLE_STRICTNESS|D3DCOMPILE_OPTIMIZATION_LEVEL3,0,&vs,&error);
    if(FAILED(hr)){
        if(error)MessageBoxA(gWindow,(char*)error->GetBufferPointer(),"Vertex Shader",MB_OK);
        fatal("Compile vertex shader",hr);
    }
    error.Reset();
    hr=D3DCompile(SHADER,strlen(SHADER),"shader",nullptr,nullptr,"PSMain","ps_5_0",
                  D3DCOMPILE_ENABLE_STRICTNESS|D3DCOMPILE_OPTIMIZATION_LEVEL3,0,&ps,&error);
    if(FAILED(hr)){
        if(error)MessageBoxA(gWindow,(char*)error->GetBufferPointer(),"Pixel Shader",MB_OK);
        fatal("Compile pixel shader",hr);
    }
    error.Reset();
    hr=D3DCompile(SHADER,strlen(SHADER),"shader",nullptr,nullptr,"PSShadow","ps_5_0",
                  D3DCOMPILE_ENABLE_STRICTNESS|D3DCOMPILE_OPTIMIZATION_LEVEL3,0,
                  &shadowPS,&error);
    if(FAILED(hr)){
        if(error)MessageBoxA(gWindow,(char*)error->GetBufferPointer(),"Shadow Shader",MB_OK);
        fatal("Compile shadow map pixel shader",hr);
    }
    D3D12_INPUT_ELEMENT_DESC input[]={
        {"POSITION",0,DXGI_FORMAT_R32G32B32_FLOAT,0,0,D3D12_INPUT_CLASSIFICATION_PER_VERTEX_DATA,0},
        {"NORMAL",0,DXGI_FORMAT_R32G32B32_FLOAT,0,12,D3D12_INPUT_CLASSIFICATION_PER_VERTEX_DATA,0},
        {"TEXCOORD",0,DXGI_FORMAT_R32G32_FLOAT,0,24,D3D12_INPUT_CLASSIFICATION_PER_VERTEX_DATA,0}
    };
    D3D12_GRAPHICS_PIPELINE_STATE_DESC p={};
    p.pRootSignature=gRoot.Get();
    p.VS={vs->GetBufferPointer(),vs->GetBufferSize()};
    p.PS={ps->GetBufferPointer(),ps->GetBufferSize()};
    p.BlendState.RenderTarget[0].RenderTargetWriteMask=D3D12_COLOR_WRITE_ENABLE_ALL;
    p.SampleMask=UINT_MAX;
    p.RasterizerState.FillMode=D3D12_FILL_MODE_SOLID;
    p.RasterizerState.CullMode=D3D12_CULL_MODE_NONE;
    p.RasterizerState.DepthClipEnable=TRUE;
    p.DepthStencilState.DepthEnable=TRUE;
    p.DepthStencilState.DepthWriteMask=D3D12_DEPTH_WRITE_MASK_ALL;
    p.DepthStencilState.DepthFunc=D3D12_COMPARISON_FUNC_LESS;
    p.InputLayout={input,(UINT)_countof(input)};
    p.PrimitiveTopologyType=D3D12_PRIMITIVE_TOPOLOGY_TYPE_TRIANGLE;
    p.NumRenderTargets=1;p.RTVFormats[0]=DXGI_FORMAT_R8G8B8A8_UNORM;
    p.DSVFormat=DXGI_FORMAT_D32_FLOAT;p.SampleDesc.Count=1;
    check(gDevice->CreateGraphicsPipelineState(&p,IID_PPV_ARGS(&gPSO)),
          "Create pipeline state");
    p.PS={shadowPS->GetBufferPointer(),shadowPS->GetBufferSize()};
    p.NumRenderTargets=0;
    p.RTVFormats[0]=DXGI_FORMAT_UNKNOWN;
    p.RasterizerState.DepthBias=1250;
    p.RasterizerState.SlopeScaledDepthBias=1.4f;
    p.RasterizerState.DepthBiasClamp=0.005f;
    check(gDevice->CreateGraphicsPipelineState(&p,IID_PPV_ARGS(&gShadowPSO)),
          "Create shadow-map pipeline state");
}
static void initializeDX12() {
    ComPtr<IDXGIFactory4> factory;
    check(CreateDXGIFactory2(0,IID_PPV_ARGS(&factory)),"Create DXGI factory");
    // Explicit high-performance adapter selection prevents an accidental iGPU/WARP test.
    ComPtr<IDXGIFactory6> factory6;
    if(SUCCEEDED(factory.As(&factory6))) {
        for(UINT i=0;;i++) {
            ComPtr<IDXGIAdapter1> adapter;
            if(factory6->EnumAdapterByGpuPreference(i,DXGI_GPU_PREFERENCE_HIGH_PERFORMANCE,
                   IID_PPV_ARGS(&adapter))==DXGI_ERROR_NOT_FOUND)break;
            DXGI_ADAPTER_DESC1 info={};
            adapter->GetDesc1(&info);
            if(info.Flags&DXGI_ADAPTER_FLAG_SOFTWARE)continue;
            if(SUCCEEDED(D3D12CreateDevice(adapter.Get(),D3D_FEATURE_LEVEL_11_0,
                                          IID_PPV_ARGS(&gDevice)))) {
                wcscpy_s(gAdapterName,info.Description);
                break;
            }
        }
    }
    if(!gDevice) {
        // Older systems without Factory6: attempt the default hardware device first.
        HRESULT hr=D3D12CreateDevice(nullptr,D3D_FEATURE_LEVEL_11_0,IID_PPV_ARGS(&gDevice));
        if(SUCCEEDED(hr)) {
            ComPtr<IDXGIDevice> dxgiDevice;
            ComPtr<IDXGIAdapter> adapter;
            DXGI_ADAPTER_DESC info={};
            if(SUCCEEDED(gDevice.As(&dxgiDevice))&&
               SUCCEEDED(dxgiDevice->GetAdapter(&adapter))&&
               SUCCEEDED(adapter->GetDesc(&info)))wcscpy_s(gAdapterName,info.Description);
        } else {
            ComPtr<IDXGIAdapter> warp;
            check(factory->EnumWarpAdapter(IID_PPV_ARGS(&warp)),"Find DX12 WARP adapter");
            check(D3D12CreateDevice(warp.Get(),D3D_FEATURE_LEVEL_11_0,IID_PPV_ARGS(&gDevice)),
                  "Create DX12 device");
            gUsingWARP=true;
            wcscpy_s(gAdapterName,L"SOFTWARE WARP");
        }
    }
    D3D12_COMMAND_QUEUE_DESC q={};q.Type=D3D12_COMMAND_LIST_TYPE_DIRECT;
    check(gDevice->CreateCommandQueue(&q,IID_PPV_ARGS(&gQueue)),"Create GPU queue");
    // Optional hardware GPU timestamps. No GPU timing is ever inferred from CPU
    // command-recording duration; failed query support only disables this metric.
    if(SUCCEEDED(gQueue->GetTimestampFrequency(&gGpuTimingFrequency)) &&
       gGpuTimingFrequency>0){
        D3D12_QUERY_HEAP_DESC desc{};
        desc.Type=D3D12_QUERY_HEAP_TYPE_TIMESTAMP;
        desc.Count=FRAME_COUNT*GPU_TIMESTAMPS_PER_FRAME;
        if(SUCCEEDED(gDevice->CreateQueryHeap(&desc,IID_PPV_ARGS(&gGpuTimingQueries)))){
            auto heap=heapProperties(D3D12_HEAP_TYPE_READBACK);
            auto data=bufferDescription(desc.Count*sizeof(UINT64));
            if(FAILED(gDevice->CreateCommittedResource(&heap,D3D12_HEAP_FLAG_NONE,
                  &data,D3D12_RESOURCE_STATE_COPY_DEST,nullptr,
                  IID_PPV_ARGS(&gGpuTimingReadback)))){
                gGpuTimingQueries.Reset();gGpuTimingFrequency=0;
            }
        }
    }
    DXGI_SWAP_CHAIN_DESC1 sd={};
    sd.Width=WIDTH;sd.Height=HEIGHT;sd.Format=DXGI_FORMAT_R8G8B8A8_UNORM;
    sd.SampleDesc.Count=1;sd.BufferUsage=DXGI_USAGE_RENDER_TARGET_OUTPUT;
    sd.BufferCount=FRAME_COUNT;sd.SwapEffect=DXGI_SWAP_EFFECT_FLIP_DISCARD;
    ComPtr<IDXGISwapChain1> temporary;
    check(factory->CreateSwapChainForHwnd(gQueue.Get(),gWindow,&sd,nullptr,nullptr,&temporary),
          "Create DXGI swap chain");
    check(temporary.As(&gSwap),"Convert swap chain");
    factory->MakeWindowAssociation(gWindow,DXGI_MWA_NO_ALT_ENTER);

    D3D12_DESCRIPTOR_HEAP_DESC heap={};
    heap.NumDescriptors=FRAME_COUNT;heap.Type=D3D12_DESCRIPTOR_HEAP_TYPE_RTV;
    check(gDevice->CreateDescriptorHeap(&heap,IID_PPV_ARGS(&gRTVHeap)),"Create RTV heap");
    gRTVStep=gDevice->GetDescriptorHandleIncrementSize(D3D12_DESCRIPTOR_HEAP_TYPE_RTV);
    heap.NumDescriptors=1+SHADOW_COUNT;heap.Type=D3D12_DESCRIPTOR_HEAP_TYPE_DSV;
    check(gDevice->CreateDescriptorHeap(&heap,IID_PPV_ARGS(&gDSVHeap)),"Create DSV heap");
    heap.NumDescriptors=4+FRAME_COUNT+1;heap.Type=D3D12_DESCRIPTOR_HEAP_TYPE_CBV_SRV_UAV;
    heap.Flags=D3D12_DESCRIPTOR_HEAP_FLAG_SHADER_VISIBLE;
    check(gDevice->CreateDescriptorHeap(&heap,IID_PPV_ARGS(&gSRVHeap)),"Create SRV heap");
    gSRVStep=gDevice->GetDescriptorHandleIncrementSize(D3D12_DESCRIPTOR_HEAP_TYPE_CBV_SRV_UAV);
    for(UINT i=0;i<FRAME_COUNT;i++){
        check(gSwap->GetBuffer(i,IID_PPV_ARGS(&gTargets[i])),"Get swap chain buffer");
        auto rtv=gRTVHeap->GetCPUDescriptorHandleForHeapStart();
        rtv.ptr+=(SIZE_T)i*gRTVStep;
        gDevice->CreateRenderTargetView(gTargets[i].Get(),nullptr,rtv);
    }

    D3D12_RESOURCE_DESC depth={};
    depth.Dimension=D3D12_RESOURCE_DIMENSION_TEXTURE2D;
    depth.Width=WIDTH;depth.Height=HEIGHT;
    depth.DepthOrArraySize=1;depth.MipLevels=1;
    depth.Format=DXGI_FORMAT_D32_FLOAT;depth.SampleDesc.Count=1;
    depth.Flags=D3D12_RESOURCE_FLAG_ALLOW_DEPTH_STENCIL;
    D3D12_CLEAR_VALUE clear={};clear.Format=DXGI_FORMAT_D32_FLOAT;
    clear.DepthStencil.Depth=1.0f;
    auto defaultHeap=heapProperties(D3D12_HEAP_TYPE_DEFAULT);
    check(gDevice->CreateCommittedResource(&defaultHeap,D3D12_HEAP_FLAG_NONE,&depth,
        D3D12_RESOURCE_STATE_DEPTH_WRITE,&clear,IID_PPV_ARGS(&gDepth)),"Create depth buffer");
    gDevice->CreateDepthStencilView(gDepth.Get(),nullptr,gDSVHeap->GetCPUDescriptorHandleForHeapStart());
    // 20 independent hardware depth maps: one 256x256 texture-array slice
    // per moving Three.js SpotLight. Each slice is both DSV and SRV.
    D3D12_RESOURCE_DESC shadow={};
    shadow.Dimension=D3D12_RESOURCE_DIMENSION_TEXTURE2D;
    shadow.Width=SHADOW_SIZE;
    shadow.Height=SHADOW_SIZE;
    shadow.DepthOrArraySize=(UINT16)SHADOW_COUNT;
    shadow.MipLevels=1;
    shadow.Format=DXGI_FORMAT_R32_TYPELESS;
    shadow.SampleDesc.Count=1;
    shadow.Flags=D3D12_RESOURCE_FLAG_ALLOW_DEPTH_STENCIL;
    D3D12_CLEAR_VALUE shadowClear={};
    shadowClear.Format=DXGI_FORMAT_D32_FLOAT;
    shadowClear.DepthStencil.Depth=1.0f;
    check(gDevice->CreateCommittedResource(&defaultHeap,D3D12_HEAP_FLAG_NONE,&shadow,
        D3D12_RESOURCE_STATE_DEPTH_WRITE,&shadowClear,IID_PPV_ARGS(&gShadowDepth)),
        "Create 20-slice DX12 shadow map");
    const UINT dsvStep=gDevice->GetDescriptorHandleIncrementSize(D3D12_DESCRIPTOR_HEAP_TYPE_DSV);
    const auto dsvBase=gDSVHeap->GetCPUDescriptorHandleForHeapStart();
    D3D12_DEPTH_STENCIL_VIEW_DESC shadowView={};
    shadowView.Format=DXGI_FORMAT_D32_FLOAT;
    shadowView.ViewDimension=D3D12_DSV_DIMENSION_TEXTURE2DARRAY;
    shadowView.Texture2DArray.ArraySize=1;
    for(UINT i=0;i<SHADOW_COUNT;i++){
        gShadowDSV[i]=dsvBase;
        gShadowDSV[i].ptr+=(SIZE_T)(i+1)*dsvStep;
        shadowView.Texture2DArray.FirstArraySlice=i;
        gDevice->CreateDepthStencilView(gShadowDepth.Get(),&shadowView,gShadowDSV[i]);
    }
    D3D12_SHADER_RESOURCE_VIEW_DESC shadowSrv={};
    shadowSrv.Shader4ComponentMapping=D3D12_DEFAULT_SHADER_4_COMPONENT_MAPPING;
    shadowSrv.Format=DXGI_FORMAT_R32_FLOAT;
    shadowSrv.ViewDimension=D3D12_SRV_DIMENSION_TEXTURE2DARRAY;
    shadowSrv.Texture2DArray.ArraySize=SHADOW_COUNT;
    shadowSrv.Texture2DArray.MipLevels=1;
    auto srvCpu=gSRVHeap->GetCPUDescriptorHandleForHeapStart();
    srvCpu.ptr+=(SIZE_T)3*gSRVStep;
    gDevice->CreateShaderResourceView(gShadowDepth.Get(),&shadowSrv,srvCpu);
    gShadowSRV=gSRVHeap->GetGPUDescriptorHandleForHeapStart();
    gShadowSRV.ptr+=(UINT64)3*gSRVStep;
    check(gDevice->CreateCommandAllocator(D3D12_COMMAND_LIST_TYPE_DIRECT,IID_PPV_ARGS(&gAllocator)),
          "Create command allocator");
    check(gDevice->CreateCommandList(0,D3D12_COMMAND_LIST_TYPE_DIRECT,gAllocator.Get(),nullptr,
          IID_PPV_ARGS(&gCmd)),"Create command list");
    check(gCmd->Close(),"Close initial command list");
    check(gDevice->CreateFence(0,D3D12_FENCE_FLAG_NONE,IID_PPV_ARGS(&gFence)),"Create fence");
    gFenceEvent=CreateEventW(nullptr,FALSE,FALSE,nullptr);
    if(!gFenceEvent)fatal("Create GPU fence event",HRESULT_FROM_WIN32(GetLastError()));

    // Each in-flight backbuffer has dedicated upload buffers and allocator.
    // gInstancesCB is created on first real JS frame in GPU-local DEFAULT memory.
    // Static tree transforms never need a per-frame UPLOAD heap.
    for(UINT frame=0;frame<FRAME_COUNT;frame++) {
        if(frame==0)gFrameAllocators[frame]=gAllocator;
        else check(gDevice->CreateCommandAllocator(D3D12_COMMAND_LIST_TYPE_DIRECT,
                   IID_PPV_ARGS(&gFrameAllocators[frame])),"Create frame allocator");
        gCameraBuffers[frame]=uploadBuffer(nullptr,256);
        gSoldierBuffers[frame]=uploadBuffer(nullptr,65536); // 1000 matrices = 64000 bytes
        gLightBuffers[frame]=uploadBuffer(nullptr,49152); // 1000 lights + 16 shadow matrices
        gGridBuffers[frame]=uploadBuffer(nullptr,17408);
        gShadowCameraBuffers[frame]=uploadBuffer(nullptr,SHADOW_COUNT*256);
        // 16 shadow casters x 1500 possible tree/soldier instance indices.
        gShadowIndexBuffers[frame]=uploadBuffer(nullptr,
                                   (SHADOW_COUNT*INSTANCE_COUNT+TREE_COUNT)*sizeof(UINT));
        D3D12_SHADER_RESOURCE_VIEW_DESC idsView={};
        idsView.Format=DXGI_FORMAT_R32_UINT;
        idsView.ViewDimension=D3D12_SRV_DIMENSION_BUFFER;
        idsView.Shader4ComponentMapping=D3D12_DEFAULT_SHADER_4_COMPONENT_MAPPING;
        idsView.Buffer.NumElements=SHADOW_COUNT*INSTANCE_COUNT+TREE_COUNT;
        auto idsCpu=gSRVHeap->GetCPUDescriptorHandleForHeapStart();
        idsCpu.ptr+=(SIZE_T)(4+frame)*gSRVStep;
        gDevice->CreateShaderResourceView(gShadowIndexBuffers[frame].Get(),&idsView,idsCpu);
        gShadowIndexSRV[frame]=gSRVHeap->GetGPUDescriptorHandleForHeapStart();
        gShadowIndexSRV[frame].ptr+=(UINT64)(4+frame)*gSRVStep;
    }
    gShadowIndexCB=gShadowIndexBuffers[0];
    gFrameCB=gCameraBuffers[0];gSoldierCB=gSoldierBuffers[0];
    gLightsCB=gLightBuffers[0];gGridCB=gGridBuffers[0];
    gShadowCameraCB=gShadowCameraBuffers[0];
    makePipeline();

    // Original Kuningriigid odamees model is centered around y=0.
    DrawParams soldier={1,3.5f,1.77f,0,{0.99f,0.46f,0.43f,1.0f}};
    DrawParams bark={0,0.46f,0,0,{0.27f,0.20f,0.14f,1.0f}};
    DrawParams needles={0,0.46f,0,0.40f,{1,1,1,1}};
    loadMesh(0,101,201,soldier);
    loadMesh(1,102,202,bark);
    loadMesh(2,103,203,needles);
    makeGround();
}
struct LightConstants {
    XMFLOAT4X4 viewProjections[SHADOW_COUNT];  // 16 actual shadow-casting lights
    XMFLOAT4 positionsRadius[LIGHT_COUNT];    // all 500 moving spotlights
    XMFLOAT4 colorsIntensity[LIGHT_COUNT];
    XMFLOAT4 shadowSlots[LIGHT_COUNT];        // -1 = unshadowed this frame
};
struct LightGridConstants {
    XMUINT4 counts[GRID_DIM*GRID_DIM/4];
    XMUINT4 indices[GRID_DIM*GRID_DIM*MAX_CELL_LIGHTS/4];
};
static_assert(sizeof(LightConstants)==49024,"1000-light CB layout mismatch");
static_assert(sizeof(LightGridConstants)==17408,"16x16 light-bin CB layout mismatch");

static void updateLightsAndShadowCameras(const float *matrices,const float *lights) {
    LightConstants constants{};
    gDynamicLights.clear();
    float maximumLightRange=0.f;
    for(UINT li=0;li<LIGHT_COUNT;li++) {
        const float *l=lights+li*8;
        gDynamicLights.insert(li,l[0],l[2]);
        maximumLightRange=std::max(maximumLightRange,l[3]);
    }
    gLightCandidateChecks=gShadowTreeCandidateChecks=0;
    for(UINT li=0;li<LIGHT_COUNT;li++) {
        const float *l=lights+li*8;
        constants.positionsRadius[li]={l[0],l[1],l[2],l[3]};
        constants.colorsIntensity[li]={l[4],l[5],l[6],l[7]};
        constants.shadowSlots[li]={-1,0,0,0};
    }
    // Render shadow maps for the 16 lights NEAREST THE CAMERA'S FOCUS,
    // not the 16 nearest forest centre. The old approach selected offscreen
    // lights during battle and appeared to have no shadows.
    float bestD[SHADOW_COUNT]{};
    UINT bestI[SHADOW_COUNT]{};
    for(UINT k=0;k<SHADOW_COUNT;k++){bestD[k]=1.e30f;bestI[k]=k;}
    for(UINT i=0;i<LIGHT_COUNT;i++) {
        const float dx=lights[i*8]-gCameraFocusX;
        const float dz=lights[i*8+2]-gCameraFocusZ;
        const float d=dx*dx+dz*dz;
        if(d>=bestD[SHADOW_COUNT-1])continue;
        UINT p=SHADOW_COUNT-1;
        while(p>0 && d<bestD[p-1]){
            bestD[p]=bestD[p-1];bestI[p]=bestI[p-1];--p;
        }
        bestD[p]=d;bestI[p]=i;
    }
    for(UINT k=0;k<SHADOW_COUNT;k++){
        const UINT li=bestI[k];
        gShadowSourceIndices[k]=li;
        constants.shadowSlots[li].x=gEnableShadows?(float)k:-1.f;
    }

    // Compact the visible instances per light. This avoids rendering the entire
    // 1000-tree forest and both armies into each of the 16 spotlight shadow maps.
    // The conservative tree margin covers wide crowns and tall branches.
    if(gEnableShadows) {
        UINT *ids=nullptr;
        check(gShadowIndexCB->Map(0,nullptr,(void**)&ids),"Map shadow visibility indices");
        for(UINT slot=0;slot<SHADOW_COUNT;slot++) {
            const float *light=lights+gShadowSourceIndices[slot]*8;
            const float lx=light[0],lz=light[2];
            const float treeRange=light[3]+28.f,unitRange=light[3]+8.f;
            const float treeDist2=treeRange*treeRange,unitDist2=unitRange*unitRange;
            const UINT base=slot*INSTANCE_COUNT;
            UINT trees=0,reds=0,blues=0;
            // Query nearby static chunks once, not all 10,000 trees per light.
            gStaticObjects.queryRadius(lx,lz,treeRange,[&](const native_three::SpatialItem& entry){
                ++gShadowTreeCandidateChecks;
                ids[base+trees++]=entry.id;
            });
            for(UINT i=0;i<PER_ARMY;i++){
                const UINT red=TREE_COUNT+i,blue=TREE_COUNT+PER_ARMY+i;
                const float rx=matrices[red*16+12]-lx,rz=matrices[red*16+14]-lz;
                const float bx=matrices[blue*16+12]-lx,bz=matrices[blue*16+14]-lz;
                if(rx*rx+rz*rz<=unitDist2)ids[base+TREE_COUNT+reds++]=i;
                if(bx*bx+bz*bz<=unitDist2)ids[base+TREE_COUNT+PER_ARMY+blues++]=i;
            }
            gShadowVisibleCounts[slot][0]=trees;
            gShadowVisibleCounts[slot][1]=reds;
            gShadowVisibleCounts[slot][2]=blues;
        }
        gShadowIndexCB->Unmap(0,nullptr);
    }
    BYTE *shadowCameras=nullptr;
    check(gShadowCameraCB->Map(0,nullptr,(void**)&shadowCameras),
          "Map 16 moving soldier shadow cameras");
    for(UINT i=0;i<SHADOW_COUNT;i++) {
        const float *l=lights+gShadowSourceIndices[i]*8;
        const XMVECTOR eye=XMVectorSet(l[0],l[1],l[2],1.f);
        const XMVECTOR target=XMVectorSet(l[0]-6.f,0.f,l[2]-4.f,1.f);
        const XMMATRIX view=XMMatrixLookAtLH(eye,target,XMVectorSet(0,0,1,0));
        const XMMATRIX projection=XMMatrixPerspectiveFovLH(
            XMConvertToRadians(118.f),1.f,0.1f,32.f);
        XMStoreFloat4x4(&constants.viewProjections[i],
                        XMMatrixTranspose(view*projection));
        memcpy(shadowCameras+(size_t)i*256,
               &constants.viewProjections[i],sizeof(XMFLOAT4X4));
    }
    gShadowCameraCB->Unmap(0,nullptr);

    LightGridConstants grid{};
    // 16x16 tiles, 30 world units each, spanning the 480-unit-wide world.
    // Each pixel evaluates at most 16 nearby lights, instead of all 500.
    for(UINT cell=0;cell<GRID_DIM*GRID_DIM;cell++) {
        const UINT cx=cell%GRID_DIM,cz=cell/GRID_DIM;
        const float worldX=-540.0f+((float)cx+0.5f)*67.5f;
        const float worldZ=-540.0f+((float)cz+0.5f)*67.5f;
        float bestDist[MAX_CELL_LIGHTS];
        UINT bestIndex[MAX_CELL_LIGHTS];
        for(UINT k=0;k<MAX_CELL_LIGHTS;k++) {
            bestDist[k]=1.e30f;bestIndex[k]=0;
        }
        UINT count=0;
        // Search only light chunks whose influence can touch this tile.
        gDynamicLights.queryRadius(worldX,worldZ,maximumLightRange+48.f,
          [&](const native_three::SpatialItem& lightItem) {
            ++gLightCandidateChecks;
            const UINT li=lightItem.id;
            const float *l=lights+li*8;
            const float dx=l[0]-worldX,dz=l[2]-worldZ;
            const float d2=dx*dx+dz*dz;
            const float radius=l[3]+48.0f; // conservative tile-diagonal margin
            if(d2>radius*radius || (count==MAX_CELL_LIGHTS && d2>=bestDist[count-1]))
                return;
            UINT pos=count<MAX_CELL_LIGHTS?count:MAX_CELL_LIGHTS-1;
            if(count<MAX_CELL_LIGHTS)++count;
            while(pos>0 && d2<bestDist[pos-1]) {
                bestDist[pos]=bestDist[pos-1];
                bestIndex[pos]=bestIndex[pos-1];
                --pos;
            }
            bestDist[pos]=d2;bestIndex[pos]=li;
        });
        reinterpret_cast<UINT*>(&grid.counts[cell/4])[cell%4]=count;
        for(UINT k=0;k<count;k++) {
            UINT word=cell*MAX_CELL_LIGHTS/4+k/4;
            reinterpret_cast<UINT*>(&grid.indices[word])[k%4]=bestIndex[k];
        }
    }
    void *data=nullptr;
    check(gLightsCB->Map(0,nullptr,&data),"Map 500 dynamic light records");
    memcpy(data,&constants,sizeof(constants));
    gLightsCB->Unmap(0,nullptr);
    check(gGridCB->Map(0,nullptr,&data),"Map 16x16 light index grid");
    memcpy(data,&grid,sizeof(grid));
    gGridCB->Unmap(0,nullptr);
}

static void drawShadowMaps() {
    // End-of-frame barrier already leaves the array in DEPTH_WRITE.
    // No duplicate transition from SRV is needed at next frame start.
    const D3D12_VIEWPORT shadowViewport={0,0,(float)SHADOW_SIZE,(float)SHADOW_SIZE,0,1};
    const D3D12_RECT shadowScissor={0,0,(LONG)SHADOW_SIZE,(LONG)SHADOW_SIZE};
    gCmd->SetPipelineState(gShadowPSO.Get());
    gCmd->SetGraphicsRootSignature(gRoot.Get());
    ID3D12DescriptorHeap *heaps[]={gSRVHeap.Get()};
    gCmd->SetDescriptorHeaps(1,heaps);
    gCmd->SetGraphicsRootDescriptorTable(8,
              gShadowIndexSRV[gSwap->GetCurrentBackBufferIndex()]);
    gCmd->RSSetViewports(1,&shadowViewport);
    gCmd->RSSetScissorRects(1,&shadowScissor);
    gCmd->IASetPrimitiveTopology(D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
    gCmd->SetGraphicsRootDescriptorTable(3,gTreeSRV);
    gCmd->SetGraphicsRootConstantBufferView(7,gSoldierCB->GetGPUVirtualAddress());
    // Four instanced batches per spotlight: tree trunks, alpha-cut foliage,
    // and the two distinct army instance ranges. The depth texture is shared
    // as a 20-layer texture array and sampled by the forward lighting pass.
    for(UINT li=0;li<SHADOW_COUNT;li++) {
        const auto dsv=gShadowDSV[li];
        gCmd->OMSetRenderTargets(0,nullptr,FALSE,&dsv);
        gCmd->ClearDepthStencilView(dsv,D3D12_CLEAR_FLAG_DEPTH,1.f,0,0,nullptr);
        gCmd->SetGraphicsRootConstantBufferView(
            0,gShadowCameraCB->GetGPUVirtualAddress()+(UINT64)li*256);
        const UINT order[]={1,2,0,0};
        for(UINT p=0;p<4;p++){
            Mesh &m=gMesh[order[p]];
            DrawParams draw=m.draw;
            draw.night=gNightMode?1.f:0.f;
            if(p==3) draw.kind=3; // blue soldier CBV range 250..499
            draw.shadowPass=1;
            draw.shadowOffset=li*INSTANCE_COUNT+
                (p<2?0:(p==2?TREE_COUNT:TREE_COUNT+PER_ARMY));
            gCmd->SetGraphicsRoot32BitConstants(1,11,&draw,0);
            gCmd->SetGraphicsRootDescriptorTable(2,m.srv);
            gCmd->IASetVertexBuffers(0,1,&m.vbv);
            gCmd->IASetIndexBuffer(&m.ibv);
            const UINT visible=gShadowVisibleCounts[li][p<2?0:(p==2?1:2)];
            if(visible)gCmd->DrawIndexedInstanced(m.indexCount,visible,0,0,0);
        }
    }
    auto ready=transition(gShadowDepth.Get(),D3D12_RESOURCE_STATE_DEPTH_WRITE,
                          D3D12_RESOURCE_STATE_PIXEL_SHADER_RESOURCE);
    gCmd->ResourceBarrier(1,&ready);
}

// All 10000 trees exist in the scene, but only the ones intersecting the
// camera view are submitted for the main two instanced tree draw calls.
// The shadow passes maintain their own separate, per-light visibility lists.
static void updateMainTreeVisibility(const float *matrices,
                                     FXMMATRIX viewProjection,FXMMATRIX projection) {
    UINT *ids=nullptr;
    check(gShadowIndexCB->Map(0,nullptr,(void**)&ids),"Map camera-visible tree IDs");
    const UINT offset=SHADOW_COUNT*INSTANCE_COUNT;
    const float padX=XMVectorGetX(projection.r[0])*14.f;
    const float padY=XMVectorGetY(projection.r[1])*20.f;
    UINT visible=0;
    gVisibleTreeCandidateChecks=0;
    gStaticObjects.forEachChunk([&](int cx,int cz,
                           const std::vector<native_three::SpatialItem>& entries){
        // Reject an entire spatial chunk only if all eight corners of its
        // conservative 3D bounds are outside the SAME clip-space plane.
        // Unknown trees/methods remain visible rather than risk false culls.
        const float size=gStaticObjects.chunkSize();
        const float x0=cx*size-18.f,x1=(cx+1)*size+18.f;
        const float z0=cz*size-18.f,z1=(cz+1)*size+18.f;
        int rejectedLeft=0,rejectedRight=0,rejectedBelow=0,rejectedAbove=0;
        for(int corner=0;corner<8;corner++){
            const float x=(corner&1)?x1:x0,z=(corner&2)?z1:z0;
            const float y=(corner&4)?36.f:-2.f;
            const XMVECTOR clip=XMVector4Transform(XMVectorSet(x,y,z,1.f),viewProjection);
            const float w=XMVectorGetW(clip),px=XMVectorGetX(clip),py=XMVectorGetY(clip);
            rejectedLeft+=(px < -w-padX);
            rejectedRight+=(px > w+padX);
            rejectedBelow+=(py < -w-padY);
            rejectedAbove+=(py > w+padY);
        }
        if(rejectedLeft==8 || rejectedRight==8 || rejectedBelow==8 || rejectedAbove==8)
            return;
        for(const auto& entry:entries){
            ++gVisibleTreeCandidateChecks;
            const UINT i=entry.id;
            const XMVECTOR at=XMVectorSet(entry.x,8.f,entry.z,1.f);
            const XMVECTOR clip=XMVector4Transform(at,viewProjection);
            const float w=XMVectorGetW(clip);
            if(w<=-18.f)continue;
            const float x=XMVectorGetX(clip),y=XMVectorGetY(clip);
            if(x < -w-padX || x > w+padX ||
               y < -w-padY || y > w+padY)continue;
            ids[offset+visible++]=i;
        }
    });
    gMainVisibleTrees=visible;
    gShadowIndexCB->Unmap(0,nullptr);
}

static void renderFrame() {
    const UINT back=gSwap->GetCurrentBackBufferIndex();
    // Do not block after Present; wait only when reusing a busy buffer.
    const UINT64 reuseFence=gFrameFenceValues[back];
    gLastFenceMs=0;
    if(reuseFence && gFence->GetCompletedValue()<reuseFence) {
        const double waitBegin=cpuSeconds();
        check(gFence->SetEventOnCompletion(reuseFence,gFenceEvent),"Frame reuse event");
        WaitForSingleObject(gFenceEvent,INFINITE);
        gLastFenceMs=(cpuSeconds()-waitBegin)*1000.0;
        gFenceWaitTotal+=gLastFenceMs;
    }
    // Read last use of this buffer only after its GPU fence has completed.
    if(reuseFence && gGpuTimingReadback && gGpuTimingFrequency){
        const UINT64 byteOffset=(UINT64)back*GPU_TIMESTAMPS_PER_FRAME*sizeof(UINT64);
        const D3D12_RANGE range={(SIZE_T)byteOffset,
                       (SIZE_T)(byteOffset+GPU_TIMESTAMPS_PER_FRAME*sizeof(UINT64))};
        UINT8* bytes=nullptr;
        if(SUCCEEDED(gGpuTimingReadback->Map(0,&range,(void**)&bytes)) && bytes){
            const UINT64* stamps=(const UINT64*)(bytes+byteOffset);
            if(stamps[0]<=stamps[1] && stamps[1]<=stamps[2]){
                const double scale=1000.0/(double)gGpuTimingFrequency;
                gLastGpuShadowMs=(double)(stamps[1]-stamps[0])*scale;
                gLastGpuMainMs=(double)(stamps[2]-stamps[1])*scale;
                gGpuShadowTotal+=gLastGpuShadowMs;
                gGpuMainTotal+=gLastGpuMainMs;
                ++gGpuTimingSamples;
            }
            const D3D12_RANGE noCpuWrites={0,0};
            gGpuTimingReadback->Unmap(0,&noCpuWrites);
        }
    }
    const UINT64 completed=gFence->GetCompletedValue();
    gRetiredResources.erase(std::remove_if(gRetiredResources.begin(),
        gRetiredResources.end(),[completed](const RetiredResource &r){
            return r.fenceValue<=completed;
        }),gRetiredResources.end());
    gAllocator=gFrameAllocators[back];
    gFrameCB=gCameraBuffers[back];gSoldierCB=gSoldierBuffers[back];
    gLightsCB=gLightBuffers[back];gGridCB=gGridBuffers[back];
    gShadowCameraCB=gShadowCameraBuffers[back];
    gShadowIndexCB=gShadowIndexBuffers[back];
    // The matrices are computed by real live THREE.InstancedMesh / Group / Scene
    // objects in QuickJS, not hardcoded into C++ instance positioning.
    static std::vector<float> matrices(INSTANCE_COUNT*16,0.f);
    static std::vector<float> previous(INSTANCE_COUNT*16,0.f);
    static std::vector<float> renderMatrices(INSTANCE_COUNT*16,0.f);
    static std::vector<float> currentLights(LIGHT_COUNT*8,0.f);
    static std::vector<float> previousLights(LIGHT_COUNT*8,0.f);
    static std::vector<float> renderedLights(LIGHT_COUNT*8,0.f);
    static native_three::FixedStepper simulation(1.0/60.0,4);
    static bool firstSceneFrame=true;
    const ULONGLONG tick=GetTickCount64();
    const double now=cpuSeconds();
    const double dt=gPreviousFrameSeconds ?
        std::min(0.20,std::max(0.0,now-gPreviousFrameSeconds)) : (1.0/60.0);
    gPreviousFrameSeconds=now;
    const double jsStart=cpuSeconds();
    if(firstSceneFrame){
        // A fresh scene exposes all static and dynamic transforms exactly once.
        NativeThreeJS_FrameFrom(0.f,matrices.data(),INSTANCE_COUNT*16,0);
        previous=matrices;renderMatrices=matrices;
        NativeThreeJS_Lights(currentLights.data(),currentLights.size());
        previousLights=currentLights;
        firstSceneFrame=false;
    }
    const float alpha=simulation.advance(dt,[&](double step){
        std::copy(matrices.begin()+TREE_COUNT*16,matrices.end(),
                  previous.begin()+TREE_COUNT*16);
        previousLights=currentLights;
        NativeThreeJS_FrameFrom((float)step,matrices.data(),INSTANCE_COUNT*16,
                                gTreesUploaded ? TREE_COUNT : 0);
        NativeThreeJS_Lights(currentLights.data(),currentLights.size());
    });
    // Interpolate independently moving light objects, not assuming they are
    // attached to a soldier or occupy the same index as a mesh.
    for(UINT i=0;i<LIGHT_COUNT;i++){
        const size_t k=(size_t)i*8;
        memcpy(renderedLights.data()+k,currentLights.data()+k,8*sizeof(float));
        for(size_t c=0;c<3;c++)
            renderedLights[k+c]=previousLights[k+c]+
                                 (currentLights[k+c]-previousLights[k+c])*alpha;
    }
    // Native interpolator works on the generic transform matrix layout.
    // Only changed/animated instances are copied; static tree matrices stay.
    for(UINT i=TREE_COUNT;i<INSTANCE_COUNT;i++){
        const size_t off=(size_t)i*16;
        memcpy(renderMatrices.data()+off,matrices.data()+off,16*sizeof(float));
        for(size_t k=12;k<=14;k++)
            renderMatrices[off+k]=previous[off+k]+
                                  (matrices[off+k]-previous[off+k])*alpha;
    }
    gLastJSms=(cpuSeconds()-jsStart)*1000.0;
    gJsCpuMsTotal+=gLastJSms;
    // F4 route visualization tracks live replanning instead of showing
    // stale paths from launch time. The previous frame's waitGPU() fence
    // guarantees that replacing the upload resource is safe.
    if(gShowDebugPaths && (gLastPathRefresh==0 || tick-gLastPathRefresh>=2000)){
        createDebugRouteGeometry();
        gLastPathRefresh=tick;
    }
    const UINT followIndex= gCameraMode==2 ? TREE_COUNT+PER_ARMY : TREE_COUNT;
    gCameraFocusX=gCameraMode==0?0.f:matrices[followIndex*16+12];
    gCameraFocusZ=gCameraMode==0?0.f:matrices[followIndex*16+14];
    // Place the viewed soldier near the forest's edge for visible A* turns.
    if(gCameraMode==1) gCameraFocusX+=16.0f;
    if(gCameraMode==2) gCameraFocusX-=16.0f;
    // Static scene objects register once; moving objects use their own grid.
    if(!gStaticObjectsRegistered){
        gStaticObjects.reserve(1024);
        for(UINT i=0;i<TREE_COUNT;i++){
            const float x=matrices[i*16+12],z=matrices[i*16+14];
            const auto h=gSceneRegistry.create(native_three::ObjectKind::Mesh,x,0,z);
            gStaticObjects.insert(h.slot,x,z);
        }
        gMovingObjectHandles.reserve(LIGHT_COUNT);
        for(UINT i=0;i<LIGHT_COUNT;i++){
            const UINT index=TREE_COUNT+i;
            gMovingObjectHandles.push_back(gSceneRegistry.create(
                native_three::ObjectKind::Agent,
                matrices[index*16+12],0,matrices[index*16+14]));
        }
        gStaticObjectsRegistered=true;
    }
    for(UINT i=0;i<LIGHT_COUNT;i++){
        const UINT index=TREE_COUNT+i;
        gSceneRegistry.setPosition(gMovingObjectHandles[i],
            renderMatrices[index*16+12],0,renderMatrices[index*16+14]);
    }
    gDirtySceneObjects=0;
    gSceneRegistry.consumeChanges([&](native_three::ObjectHandle,
                       const native_three::SceneRecord&){++gDirtySceneObjects;});
    const double lightsStart=cpuSeconds();
    updateLightsAndShadowCameras(renderMatrices.data(),renderedLights.data());
    gLastLightMs=(cpuSeconds()-lightsStart)*1000.0;
    gLightCpuMsTotal+=gLastLightMs;
    // Tree geometry is static; write its 1000 matrices once, not every frame.
    if(!gTreesUploaded){
        // 1000 tree matrices = 64000 bytes, exactly within a DX12 root CBV.
        // One-time GPU-local upload avoids 1000 repeated vertex shader reads
        // from PCIe-visible UPLOAD memory on discrete GPUs.
        gInstancesCB=staticGpuBuffer(matrices.data(),TREE_COUNT*16*sizeof(float),
                         D3D12_RESOURCE_STATE_NON_PIXEL_SHADER_RESOURCE);
        D3D12_SHADER_RESOURCE_VIEW_DESC treeView={};
        treeView.Format=DXGI_FORMAT_UNKNOWN;
        treeView.ViewDimension=D3D12_SRV_DIMENSION_BUFFER;
        treeView.Shader4ComponentMapping=D3D12_DEFAULT_SHADER_4_COMPONENT_MAPPING;
        treeView.Buffer.NumElements=TREE_COUNT;
        treeView.Buffer.StructureByteStride=sizeof(XMFLOAT4X4);
        auto treeCpu=gSRVHeap->GetCPUDescriptorHandleForHeapStart();
        treeCpu.ptr+=(SIZE_T)(4+FRAME_COUNT)*gSRVStep;
        gDevice->CreateShaderResourceView(gInstancesCB.Get(),&treeView,treeCpu);
        gTreeSRV=gSRVHeap->GetGPUDescriptorHandleForHeapStart();
        gTreeSRV.ptr+=(UINT64)(4+FRAME_COUNT)*gSRVStep;
        gTreesUploaded=true;
    }
    void *soldierData=nullptr;
    check(gSoldierCB->Map(0,nullptr,&soldierData),"Map 500 moving soldier matrices");
    memcpy(soldierData,renderMatrices.data()+TREE_COUNT*16,
           LIGHT_COUNT*16*sizeof(float));
    gSoldierCB->Unmap(0,nullptr);
    XMVECTOR target=XMVectorSet(gCameraFocusX,1.5f,gCameraFocusZ,1);
    XMVECTOR eye=XMVectorAdd(target,XMVectorSet(
        sinf(gYaw)*cosf(gPitch)*gDistance,
        sinf(gPitch)*gDistance,
        -cosf(gYaw)*cosf(gPitch)*gDistance,0.0f));
    XMMATRIX view=XMMatrixLookAtLH(eye,target,XMVectorSet(0,1,0,0));
    XMMATRIX proj=XMMatrixPerspectiveFovLH(XMConvertToRadians(57.0f),
                 (float)WIDTH/HEIGHT,0.1f,2200.0f);
    XMFLOAT4X4 vp;
    XMStoreFloat4x4(&vp,XMMatrixTranspose(view*proj));
    updateMainTreeVisibility(renderMatrices.data(),view*proj,proj);
    void *cbptr=nullptr;
    check(gFrameCB->Map(0,nullptr,&cbptr),"Map view projection buffer");
    memcpy(cbptr,&vp,sizeof(vp));
    gFrameCB->Unmap(0,nullptr);

    const double recordStart=cpuSeconds();
    check(gAllocator->Reset(),"Reset draw allocator");
    check(gCmd->Reset(gAllocator.Get(),gShadowPSO.Get()),"Reset draw commands");
    const UINT queryBase=back*GPU_TIMESTAMPS_PER_FRAME;
    if(gGpuTimingQueries)
        gCmd->EndQuery(gGpuTimingQueries.Get(),D3D12_QUERY_TYPE_TIMESTAMP,queryBase);
    if(gEnableShadows)drawShadowMaps();
    else {
        // F5 now skips all shadow draw calls, not merely the final sampling.
        auto readable=transition(gShadowDepth.Get(),D3D12_RESOURCE_STATE_DEPTH_WRITE,
                                 D3D12_RESOURCE_STATE_PIXEL_SHADER_RESOURCE);
        gCmd->ResourceBarrier(1,&readable);
    }
    if(gGpuTimingQueries)
        gCmd->EndQuery(gGpuTimingQueries.Get(),D3D12_QUERY_TYPE_TIMESTAMP,queryBase+1);
    gCmd->SetPipelineState(gPSO.Get());
    auto toRT=transition(gTargets[back].Get(),
                         D3D12_RESOURCE_STATE_PRESENT,D3D12_RESOURCE_STATE_RENDER_TARGET);
    gCmd->ResourceBarrier(1,&toRT);
    D3D12_CPU_DESCRIPTOR_HANDLE rtv=gRTVHeap->GetCPUDescriptorHandleForHeapStart();
    rtv.ptr+=(SIZE_T)back*gRTVStep;
    D3D12_CPU_DESCRIPTOR_HANDLE dsv=gDSVHeap->GetCPUDescriptorHandleForHeapStart();
    gCmd->RSSetViewports(1,&gViewport);
    gCmd->RSSetScissorRects(1,&gScissor);
    gCmd->OMSetRenderTargets(1,&rtv,FALSE,&dsv);
    float bg[]={gNightMode?0.002f:0.075f,gNightMode?0.004f:0.11f,
                gNightMode?0.015f:0.18f,1};
    gCmd->ClearRenderTargetView(rtv,bg,0,nullptr);
    gCmd->ClearDepthStencilView(dsv,D3D12_CLEAR_FLAG_DEPTH,1.0f,0,0,nullptr);
    gCmd->SetGraphicsRootSignature(gRoot.Get());
    ID3D12DescriptorHeap *heaps[]={gSRVHeap.Get()};
    gCmd->SetDescriptorHeaps(1,heaps);
    gCmd->SetGraphicsRootConstantBufferView(0,gFrameCB->GetGPUVirtualAddress());
    gCmd->SetGraphicsRootDescriptorTable(3,gTreeSRV);
    gCmd->SetGraphicsRootConstantBufferView(7,gSoldierCB->GetGPUVirtualAddress());
    gCmd->SetGraphicsRootDescriptorTable(8,gShadowIndexSRV[back]);
    gCmd->SetGraphicsRootDescriptorTable(4,gShadowSRV);
    gCmd->SetGraphicsRootConstantBufferView(5,gLightsCB->GetGPUVirtualAddress());
    gCmd->SetGraphicsRootConstantBufferView(6,gGridCB->GetGPUVirtualAddress());
    gCmd->IASetPrimitiveTopology(D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
    // Instanced draws for 1500 objects: two tree parts,
    // 250 red soldiers, 250 blue soldiers; plus one ground draw.
    const UINT order[]={3,1,2,0,0};
    for(UINT p=0;p<5;p++) {
        Mesh &m=gMesh[order[p]];
        DrawParams draw=m.draw;
        draw.night=gNightMode?1.f:0.f;
        if(p==1||p==2){
            draw.shadowPass=1; // reuse the GPU index indirection for camera culling
            draw.shadowOffset=SHADOW_COUNT*INSTANCE_COUNT;
        }
        if(p==4){
            draw.kind=3; // selects 250 blue soldiers in second army CBV range
            draw.tint[0]=0.40f;draw.tint[1]=0.66f;draw.tint[2]=1.0f;
        }
        gCmd->SetGraphicsRoot32BitConstants(1,11,&draw,0);
        gCmd->SetGraphicsRootDescriptorTable(2,m.srv);
        gCmd->IASetVertexBuffers(0,1,&m.vbv);
        gCmd->IASetIndexBuffer(&m.ibv);
        gCmd->DrawIndexedInstanced(m.indexCount,p==0?1:(p==1||p==2?gMainVisibleTrees:PER_ARMY),0,0,0);
    }
    // Overlay 12 representative REAL A* routes over ground. F4 toggles them.
    // Warm yellow = red army; cyan = blue army. A bright diagnostic even
    // with zero visible sunlight/shadows, so movement is verifiable.
    if(gShowDebugPaths && gDebugPathVB) {
        gCmd->IASetVertexBuffers(0,1,&gDebugPathVBV);
        gCmd->SetGraphicsRootDescriptorTable(2,gMesh[1].srv);
        DrawParams overlay={4,1.0f,0.0f,0.0f,{1.f,0.68f,0.03f,1.f}};
        gCmd->SetGraphicsRoot32BitConstants(1,11,&overlay,0);
        gCmd->DrawInstanced(gDebugRedVertices,1,0,0);
        overlay.tint[0]=0.05f;overlay.tint[1]=0.93f;overlay.tint[2]=1.0f;
        gCmd->SetGraphicsRoot32BitConstants(1,11,&overlay,0);
        gCmd->DrawInstanced(gDebugBlueVertices,1,gDebugRedVertices,0);
    }
    auto toPresent=transition(gTargets[back].Get(),
                            D3D12_RESOURCE_STATE_RENDER_TARGET,D3D12_RESOURCE_STATE_PRESENT);
    gCmd->ResourceBarrier(1,&toPresent);
    // Prepare depth layers for the next frame, after the forward shading pass.
    auto shadowWritable=transition(gShadowDepth.Get(),
        D3D12_RESOURCE_STATE_PIXEL_SHADER_RESOURCE,D3D12_RESOURCE_STATE_DEPTH_WRITE);
    gCmd->ResourceBarrier(1,&shadowWritable);
    if(gGpuTimingQueries){
        gCmd->EndQuery(gGpuTimingQueries.Get(),D3D12_QUERY_TYPE_TIMESTAMP,queryBase+2);
        gCmd->ResolveQueryData(gGpuTimingQueries.Get(),D3D12_QUERY_TYPE_TIMESTAMP,
            queryBase,GPU_TIMESTAMPS_PER_FRAME,gGpuTimingReadback.Get(),
            (UINT64)queryBase*sizeof(UINT64));
    }
    check(gCmd->Close(),"Close draw commands");
    ID3D12CommandList *lists[]={gCmd.Get()};
    gQueue->ExecuteCommandLists(1,lists);
    gLastRecordMs=(cpuSeconds()-recordStart)*1000.0;
    gRecordCpuMsTotal+=gLastRecordMs;
    const double presentStart=cpuSeconds();
    check(gSwap->Present(gVSync?1:0,0),"Present frame");
    gLastPresentMs=(cpuSeconds()-presentStart)*1000.0;
    gPresentCpuMsTotal+=gLastPresentMs;
    const UINT64 submitted=++gFenceValue;
    check(gQueue->Signal(gFence.Get(),submitted),"Signal submitted frame");
    gFrameFenceValues[back]=submitted;
    ++gStatFrames;++gTotalFrames;
    const double endFrame=cpuSeconds();
    const double fullFrameMs=gLastFrameEndSeconds ?
        (endFrame-gLastFrameEndSeconds)*1000.0:0.0;
    if(gLastFrameEndSeconds)
        gWorstFrameMs=std::max(gWorstFrameMs,fullFrameMs);
    gLastFrameEndSeconds=endFrame;
    if(fullFrameMs>40.0){
        char csv[512];
        sprintf_s(csv,"spike,%llu,%.3f,%.3f,%.3f,%.3f,%.3f,%.3f,%.3f,%.3f,%u,%u,%u,%u",
            (unsigned long long)gTotalFrames,fullFrameMs,
            gLastJSms,gLastLightMs,gLastRecordMs,gLastPresentMs,
            gLastFenceMs,gLastGpuShadowMs,gLastGpuMainMs,gMainVisibleTrees,
            gDirtySceneObjects,gLightCandidateChecks,gShadowTreeCandidateChecks);
        gPerfLog.enqueue(csv);
    }
    ULONGLONG t=GetTickCount64();
    if(t-gStatStart>=1000) {
        int frames=(int)(gStatFrames*1000/(t-gStatStart));
        NativeThreeNavStatus navigation{};
        NativeThreeJS_GetNavStatus(&navigation);
        UINT shadowInstances=0;
        if(gEnableShadows)for(UINT i=0;i<SHADOW_COUNT;i++)
            shadowInstances+=2*gShadowVisibleCounts[i][0]+
                             gShadowVisibleCounts[i][1]+gShadowVisibleCounts[i][2];
        wchar_t title[760];
        const double inv=1.0/(double)gStatFrames;
        swprintf_s(title,
            L"DX12 %s | NIGHT %s | FPS %d | MAX %.1f FENCE %.2f | JS %.2f LIGHT %.2f DRAW %.2f PRESENT %.2f | GPU shadow %.2f main %.2f | TREES %u/10000 | dirty %u bins L%u S%u T%u | A* %d/1000 planned %d | shadows %u %s | VSync %s",
            gAdapterName,gNightMode?L"ON":L"OFF",frames,
            gWorstFrameMs,gFenceWaitTotal*inv,
            gJsCpuMsTotal*inv,gLightCpuMsTotal*inv,gRecordCpuMsTotal*inv,gPresentCpuMsTotal*inv,
            gGpuTimingSamples?gGpuShadowTotal/gGpuTimingSamples:0.0,
            gGpuTimingSamples?gGpuMainTotal/gGpuTimingSamples:0.0,
            gMainVisibleTrees,gDirtySceneObjects,
            gLightCandidateChecks,gShadowTreeCandidateChecks,gVisibleTreeCandidateChecks,
            navigation.moved,navigation.planned,shadowInstances,
            gEnableShadows?L"ON":L"OFF",gVSync?L"ON":L"OFF");
        SetWindowTextW(gWindow,title);
        char summary[512];
        sprintf_s(summary,"summary,%llu,%.3f,%.3f,%.3f,%.3f,%.3f,%.3f,%.3f,%.3f,%u,%u,%u,%u",
            (unsigned long long)gTotalFrames,gWorstFrameMs,
            gJsCpuMsTotal*inv,gLightCpuMsTotal*inv,
            gRecordCpuMsTotal*inv,gPresentCpuMsTotal*inv,
            gFenceWaitTotal*inv,
            gGpuTimingSamples?gGpuShadowTotal/gGpuTimingSamples:0.0,
            gGpuTimingSamples?gGpuMainTotal/gGpuTimingSamples:0.0,
            gMainVisibleTrees,gDirtySceneObjects,
            gLightCandidateChecks,gShadowTreeCandidateChecks);
        gPerfLog.enqueue(summary);
        gStatFrames=0;
        gGpuShadowTotal=gGpuMainTotal=0;
        gGpuTimingSamples=0;
        gJsCpuMsTotal=gLightCpuMsTotal=gRecordCpuMsTotal=gPresentCpuMsTotal=0;
        gFenceWaitTotal=gWorstFrameMs=0;
        gStatStart=t;
    }
}
static LRESULT CALLBACK WindowProc(HWND win,UINT msg,WPARAM wp,LPARAM lp) {
    switch(msg) {
        case WM_ERASEBKGND:return 1;
        case WM_LBUTTONDOWN:
            gDrag=true;gMouseX=GET_X_LPARAM(lp);gMouseY=GET_Y_LPARAM(lp);
            SetCapture(win);return 0;
        case WM_MOUSEMOVE:
            if(gDrag) {
                int x=GET_X_LPARAM(lp), y=GET_Y_LPARAM(lp);
                gYaw+=(x-gMouseX)*0.008f;gPitch+=(y-gMouseY)*0.005f;
                if(gPitch<0.17f)gPitch=0.17f;
                if(gPitch>1.38f)gPitch=1.38f;
                gMouseX=x;gMouseY=y;
            }
            return 0;
        case WM_LBUTTONUP:gDrag=false;ReleaseCapture();return 0;
        case WM_MOUSEWHEEL:
            gDistance*=GET_WHEEL_DELTA_WPARAM(wp)>0?0.9f:1.1f;
            if(gDistance<20)gDistance=20;
            if(gDistance>950)gDistance=950;
            return 0;
        case WM_KEYDOWN:
            if(wp==VK_ESCAPE)DestroyWindow(win);
            if(wp==VK_SPACE)gPause=!gPause;
            if(wp==VK_F1){gCameraMode=0;gDistance=780.f;}
            if(wp==VK_F2){gCameraMode=1;gDistance=92.f;}
            if(wp==VK_F3){gCameraMode=2;gDistance=92.f;}
            if(wp==VK_F4){
                gShowDebugPaths=!gShowDebugPaths;
                if(gShowDebugPaths)gLastPathRefresh=0;
            }
            if(wp==VK_F5)gEnableShadows=!gEnableShadows;
            if(wp==VK_F6)gVSync=!gVSync;
            if(wp==VK_F7)gNightMode=!gNightMode;
            return 0;
        case WM_DESTROY:PostQuitMessage(0);return 0;
    }
    return DefWindowProcW(win,msg,wp,lp);
}
int WINAPI wWinMain(HINSTANCE instance,HINSTANCE,LPWSTR,int show) {
    WNDCLASSW wc={};
    wc.lpfnWndProc=WindowProc;
    wc.hInstance=instance;
    wc.lpszClassName=L"NativeThreeDX12Window";
    wc.hCursor=LoadCursor(nullptr,IDC_ARROW);
    if(!RegisterClassW(&wc))return 1;
    RECT rc={0,0,(LONG)WIDTH,(LONG)HEIGHT};
    AdjustWindowRect(&rc,WS_OVERLAPPED|WS_CAPTION|WS_SYSMENU|WS_MINIMIZEBOX,FALSE);
    gWindow=CreateWindowW(wc.lpszClassName,L"NativeThreeBridge v0.18 NIGHT | 10k trees / 1k dynamic A* soldiers",
       WS_OVERLAPPED|WS_CAPTION|WS_SYSMENU|WS_MINIMIZEBOX,
       CW_USEDEFAULT,CW_USEDEFAULT,rc.right-rc.left,rc.bottom-rc.top,
       nullptr,nullptr,instance,nullptr);
    if(!gWindow)return 2;
    initializeDX12();
    NativeThreeJS_Init();
    // Debug route overlay is explicitly requested with F4, not precomputed at startup.
    ShowWindow(gWindow,show);
    UpdateWindow(gWindow);
    gStatStart=GetTickCount64();
    MSG message={};
    bool running=true;
    while(running) {
        while(PeekMessageW(&message,nullptr,0,0,PM_REMOVE)) {
            if(message.message==WM_QUIT){running=false;break;}
            TranslateMessage(&message);DispatchMessageW(&message);
        }
        if(!running)break;
        if(!gPause&&!IsIconic(gWindow))renderFrame();
        else Sleep(50);
    }
    waitGPU();
    NativeThreeJS_Shutdown();
    if(gFenceEvent)CloseHandle(gFenceEvent);
    return 0;
}
