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
#include "three_js_host.h"

#pragma comment(lib,"d3d12.lib")
#pragma comment(lib,"dxgi.lib")
#pragma comment(lib,"d3dcompiler.lib")
#pragma comment(lib,"user32.lib")

using Microsoft::WRL::ComPtr;
using namespace DirectX;

static const UINT WIDTH=1152, HEIGHT=768, FRAME_COUNT=2, MESH_COUNT=4;
static const UINT SHADOW_COUNT=16, SHADOW_SIZE=256;
static const UINT TREE_COUNT=1000, LIGHT_COUNT=500, PER_ARMY=250, INSTANCE_COUNT=1500;
static const UINT GRID_DIM=16, MAX_CELL_LIGHTS=16;
static HWND gWindow=nullptr;
static float gYaw=0.45f, gPitch=0.90f, gDistance=640.0f;
static bool gDrag=false,gPause=false;
static int gMouseX=0,gMouseY=0;
static ULONGLONG gStatStart=0, gPreviousFrame=0;
static UINT gStatFrames=0;

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
static bool gTreesUploaded=false;
static UINT gShadowSourceIndices[SHADOW_COUNT]{};
static HANDLE gFenceEvent=NULL;
static UINT64 gFenceValue=0;
static UINT gRTVStep=0,gSRVStep=0;
static D3D12_CPU_DESCRIPTOR_HANDLE gShadowDSV[SHADOW_COUNT]{};
static D3D12_GPU_DESCRIPTOR_HANDLE gShadowSRV{};
static D3D12_VIEWPORT gViewport={0,0,(float)WIDTH,(float)HEIGHT,0,1};
static D3D12_RECT gScissor={0,0,(LONG)WIDTH,(LONG)HEIGHT};

struct Vertex {float x,y,z,nx,ny,nz,u,v;};
struct MeshHeader {char magic[4];uint32_t vertices,indices,reserved;};
struct DrawParams {UINT kind;float scale;float yOffset;float alphaCut;float tint[4];};
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
    m.vertices=uploadBuffer(raw+sizeof(h),vertexBytes);
    m.indices=uploadBuffer(raw+sizeof(h)+vertexBytes,indexBytes);
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
static void makeGround() {
    Vertex v[]={
        {-250,0,-250,0,1,0,0,0},{250,0,-250,0,1,0,1,0},
        {-250,0,250,0,1,0,0,1},{250,0,250,0,1,0,1,1}
    };
    uint32_t idx[]={0,2,1,1,2,3};
    Mesh &m=gMesh[3];
    m.vertices=uploadBuffer(v,sizeof(v));m.indices=uploadBuffer(idx,sizeof(idx));
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
};
// Two CBVs: one 64000-byte buffer for 1000 static pines and one for 500 soldiers.
cbuffer TreeTransforms : register(b2) { float4x4 gTreeInstances[1000]; };
cbuffer SoldierTransforms : register(b5) { float4x4 gSoldierInstances[500]; };
cbuffer Lights : register(b3) {
    float4x4 gLightVP[16];
    float4 gLightPosRadius[500];
    float4 gLightColorIntensity[500];
    float4 gShadowSlots[500];
};
cbuffer LightGrid : register(b4) {
    uint4 gGridCounts[64];
    uint4 gGridIndices[1024];
};
Texture2D gTexture : register(t0);
Texture2DArray gShadowDepthTexture : register(t1);
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
    float3 p=v.p*gScale+float3(0,gYOffset,0);
    float3 n=v.n;
    if(gKind!=2){
        float4x4 instanceTransform;
        if(gKind==0) instanceTransform=gTreeInstances[instance];
        else instanceTransform=gSoldierInstances[instance+(gKind==3?250:0)];
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
    float4 albedo=gTexture.Sample(gSampler,v.uv)*gTint;
    if(gAlphaCut>0)clip(albedo.a-gAlphaCut);
    float3 normal=normalize(v.n);
    float day=0.20+0.34*abs(dot(normal,normalize(float3(0.32,0.84,0.41))));
    float3 illumination=day.xxx;
    // CPU bins all 500 moving lights into 16x16 tiles across the expanded forest.
    // Only the nearest 16 in this tile are evaluated per pixel.
    int gx=clamp((int)floor((v.worldPos.x+240.0)/30.0),0,15);
    int gz=clamp((int)floor((v.worldPos.z+240.0)/30.0),0,15);
    uint cell=(uint)(gz*16+gx);
    uint count=gGridCounts[cell/4][cell%4];
    [loop] for(uint k=0;k<count;k++){
        uint index=gGridIndices[cell*4+k/4][k%4];
        if(index>=500)continue;
        float3 toLight=gLightPosRadius[index].xyz-v.worldPos;
        float dist=length(toLight);
        float radius=gLightPosRadius[index].w;
        if(dist<0.001 || dist>=radius)continue;
        float3 direction=toLight/dist;
        float cone=direction.y;
        if(cone<0.5)continue;
        float diff=saturate(dot(normal,direction));
        if(diff<=0)continue;
        float fade=saturate((cone-0.5)/0.22);
        float falloff=saturate(1.0-dist/radius);
        float vis=shadowVisibility(v.worldPos,index);
        illumination+=gLightColorIntensity[index].rgb*
            (gLightColorIntensity[index].a*falloff*falloff*fade*diff*vis*0.42);
    }
    return float4(saturate(albedo.rgb*illumination),1);
}
)";
static void makePipeline() {
    D3D12_ROOT_PARAMETER rp[8]={};
    rp[0].ParameterType=D3D12_ROOT_PARAMETER_TYPE_CBV;
    rp[0].Descriptor.ShaderRegister=0;
    rp[0].ShaderVisibility=D3D12_SHADER_VISIBILITY_VERTEX;
    rp[1].ParameterType=D3D12_ROOT_PARAMETER_TYPE_32BIT_CONSTANTS;
    rp[1].Constants.ShaderRegister=1;
    rp[1].Constants.Num32BitValues=8;
    rp[1].ShaderVisibility=D3D12_SHADER_VISIBILITY_ALL;
    D3D12_DESCRIPTOR_RANGE ranges[2]={};
    for(UINT i=0;i<2;i++){
        ranges[i].RangeType=D3D12_DESCRIPTOR_RANGE_TYPE_SRV;
        ranges[i].NumDescriptors=1;
        ranges[i].BaseShaderRegister=i;
    }
    rp[2].ParameterType=D3D12_ROOT_PARAMETER_TYPE_DESCRIPTOR_TABLE;
    rp[2].DescriptorTable.NumDescriptorRanges=1;
    rp[2].DescriptorTable.pDescriptorRanges=&ranges[0];
    rp[2].ShaderVisibility=D3D12_SHADER_VISIBILITY_PIXEL;
    rp[3].ParameterType=D3D12_ROOT_PARAMETER_TYPE_CBV;
    rp[3].Descriptor.ShaderRegister=2;
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
    rs.NumParameters=8;rs.pParameters=rp;
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
    HRESULT hr=D3D12CreateDevice(nullptr,D3D_FEATURE_LEVEL_11_0,IID_PPV_ARGS(&gDevice));
    if(FAILED(hr)) {
        ComPtr<IDXGIAdapter> warp;
        check(factory->EnumWarpAdapter(IID_PPV_ARGS(&warp)),"Find DX12 WARP adapter");
        check(D3D12CreateDevice(warp.Get(),D3D_FEATURE_LEVEL_11_0,IID_PPV_ARGS(&gDevice)),
              "Create DX12 device");
    }
    D3D12_COMMAND_QUEUE_DESC q={};q.Type=D3D12_COMMAND_LIST_TYPE_DIRECT;
    check(gDevice->CreateCommandQueue(&q,IID_PPV_ARGS(&gQueue)),"Create GPU queue");
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
    heap.NumDescriptors=4;heap.Type=D3D12_DESCRIPTOR_HEAP_TYPE_CBV_SRV_UAV;
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

    gFrameCB=uploadBuffer(nullptr,256);
    // A DX12 CBV must not exceed 65536 bytes. Split 1500 Matrix4 transforms:
    // 1000 static trees = 64000B, 500 moving soldiers = 32000B.
    gInstancesCB=uploadBuffer(nullptr,65536);
    gSoldierCB=uploadBuffer(nullptr,32768);
    // 16 shadow matrices + 500 lights (xyz/radius, rgb/intensity, slot).
    gLightsCB=uploadBuffer(nullptr,32768);
    // 16x16 world-space bins x up to 16 light indices, packed as uint4.
    gGridCB=uploadBuffer(nullptr,17408);
    gShadowCameraCB=uploadBuffer(nullptr,SHADOW_COUNT*256);
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
static_assert(sizeof(LightConstants)==25024,"500-light CB layout mismatch");
static_assert(sizeof(LightGridConstants)==17408,"16x16 light-bin CB layout mismatch");

static void updateLightsAndShadowCameras() {
    float lights[LIGHT_COUNT*8]{};
    NativeThreeJS_Lights(lights,LIGHT_COUNT*8);
    LightConstants constants{};
    for(UINT li=0;li<LIGHT_COUNT;li++) {
        const float *l=lights+li*8;
        constants.positionsRadius[li]={l[0],l[1],l[2],l[3]};
        constants.colorsIntensity[li]={l[4],l[5],l[6],l[7]};
        constants.shadowSlots[li]={-1,0,0,0};
    }
    // For the two armies, select eight nearest-to-forest lights each.
    // All 500 lights contribute to illumination; 16 have up-to-date
    // depth shadows (rather than a disastrous 500 depth passes/frame).
    for(UINT army=0;army<2;army++) {
        float bestD[SHADOW_COUNT/2];
        UINT bestI[SHADOW_COUNT/2];
        for(UINT k=0;k<SHADOW_COUNT/2;k++){bestD[k]=1.e30f;bestI[k]=army*PER_ARMY;}
        for(UINT j=0;j<PER_ARMY;j++) {
            UINT i=army*PER_ARMY+j;
            float x=lights[i*8],z=lights[i*8+2],d=x*x+z*z;
            if(d>=bestD[SHADOW_COUNT/2-1])continue;
            UINT p=SHADOW_COUNT/2-1;
            while(p>0 && d<bestD[p-1]) {
                bestD[p]=bestD[p-1];bestI[p]=bestI[p-1];--p;
            }
            bestD[p]=d;bestI[p]=i;
        }
        for(UINT k=0;k<SHADOW_COUNT/2;k++){
            const UINT slot=army*(SHADOW_COUNT/2)+k,li=bestI[k];
            gShadowSourceIndices[slot]=li;
            constants.shadowSlots[li].x=(float)slot;
        }
    }

    BYTE *shadowCameras=nullptr;
    check(gShadowCameraCB->Map(0,nullptr,(void**)&shadowCameras),
          "Map 16 moving soldier shadow cameras");
    for(UINT i=0;i<SHADOW_COUNT;i++) {
        const float *l=lights+gShadowSourceIndices[i]*8;
        const XMVECTOR eye=XMVectorSet(l[0],l[1],l[2],1.f);
        const XMVECTOR target=XMVectorSet(l[0],l[1]-1.f,l[2],1.f);
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
        const float worldX=-240.0f+((float)cx+0.5f)*30.0f;
        const float worldZ=-240.0f+((float)cz+0.5f)*30.0f;
        float bestDist[MAX_CELL_LIGHTS];
        UINT bestIndex[MAX_CELL_LIGHTS];
        for(UINT k=0;k<MAX_CELL_LIGHTS;k++) {
            bestDist[k]=1.e30f;bestIndex[k]=0;
        }
        UINT count=0;
        for(UINT li=0;li<LIGHT_COUNT;li++) {
            const float *l=lights+li*8;
            const float dx=l[0]-worldX,dz=l[2]-worldZ;
            const float d2=dx*dx+dz*dz;
            const float radius=l[3]+22.0f; // include diagonal of 30x30 tile
            if(d2>radius*radius || (count==MAX_CELL_LIGHTS && d2>=bestDist[count-1]))
                continue;
            UINT pos=count<MAX_CELL_LIGHTS?count:MAX_CELL_LIGHTS-1;
            if(count<MAX_CELL_LIGHTS)++count;
            while(pos>0 && d2<bestDist[pos-1]) {
                bestDist[pos]=bestDist[pos-1];
                bestIndex[pos]=bestIndex[pos-1];
                --pos;
            }
            bestDist[pos]=d2;bestIndex[pos]=li;
        }
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
    const D3D12_VIEWPORT shadowViewport={0,0,(float)SHADOW_SIZE,(float)SHADOW_SIZE,0,1};
    const D3D12_RECT shadowScissor={0,0,(LONG)SHADOW_SIZE,(LONG)SHADOW_SIZE};
    gCmd->SetPipelineState(gShadowPSO.Get());
    gCmd->SetGraphicsRootSignature(gRoot.Get());
    ID3D12DescriptorHeap *heaps[]={gSRVHeap.Get()};
    gCmd->SetDescriptorHeaps(1,heaps);
    gCmd->RSSetViewports(1,&shadowViewport);
    gCmd->RSSetScissorRects(1,&shadowScissor);
    gCmd->IASetPrimitiveTopology(D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
    gCmd->SetGraphicsRootConstantBufferView(3,gInstancesCB->GetGPUVirtualAddress());
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
            if(p==3) draw.kind=3; // blue soldier CBV range 250..499
            gCmd->SetGraphicsRoot32BitConstants(1,8,&draw,0);
            gCmd->SetGraphicsRootDescriptorTable(2,m.srv);
            gCmd->IASetVertexBuffers(0,1,&m.vbv);
            gCmd->IASetIndexBuffer(&m.ibv);
            gCmd->DrawIndexedInstanced(m.indexCount,p<2?TREE_COUNT:PER_ARMY,0,0,0);
        }
    }
    auto ready=transition(gShadowDepth.Get(),D3D12_RESOURCE_STATE_DEPTH_WRITE,
                          D3D12_RESOURCE_STATE_PIXEL_SHADER_RESOURCE);
    gCmd->ResourceBarrier(1,&ready);
}

static void renderFrame() {
    // The matrices are computed by real live THREE.InstancedMesh / Group / Scene
    // objects in QuickJS, not hardcoded into C++ instance positioning.
    float matrices[INSTANCE_COUNT*16]={};
    const ULONGLONG tick=GetTickCount64();
    const float dt = gPreviousFrame ? (float)(tick-gPreviousFrame)/1000.0f : (1.0f/60.0f);
    gPreviousFrame=tick;
    NativeThreeJS_Frame(dt,matrices,INSTANCE_COUNT*16);
    updateLightsAndShadowCameras();
    // Tree geometry is static; write its 1000 matrices once, not every frame.
    if(!gTreesUploaded){
        void *treeData=nullptr;
        check(gInstancesCB->Map(0,nullptr,&treeData),"Map static 1000-tree matrices");
        memcpy(treeData,matrices,TREE_COUNT*16*sizeof(float));
        gInstancesCB->Unmap(0,nullptr);
        gTreesUploaded=true;
    }
    void *soldierData=nullptr;
    check(gSoldierCB->Map(0,nullptr,&soldierData),"Map 500 moving soldier matrices");
    memcpy(soldierData,matrices+TREE_COUNT*16,LIGHT_COUNT*16*sizeof(float));
    gSoldierCB->Unmap(0,nullptr);
    XMVECTOR eye=XMVectorSet(
        sinf(gYaw)*cosf(gPitch)*gDistance,
        sinf(gPitch)*gDistance,
        -cosf(gYaw)*cosf(gPitch)*gDistance,1.0f);
    XMVECTOR target=XMVectorSet(0,1.5f,0.0f,1);
    XMMATRIX view=XMMatrixLookAtLH(eye,target,XMVectorSet(0,1,0,0));
    XMMATRIX proj=XMMatrixPerspectiveFovLH(XMConvertToRadians(57.0f),
                 (float)WIDTH/HEIGHT,0.1f,2200.0f);
    XMFLOAT4X4 vp;
    XMStoreFloat4x4(&vp,XMMatrixTranspose(view*proj));
    void *cbptr=nullptr;
    check(gFrameCB->Map(0,nullptr,&cbptr),"Map view projection buffer");
    memcpy(cbptr,&vp,sizeof(vp));
    gFrameCB->Unmap(0,nullptr);

    const UINT back=gSwap->GetCurrentBackBufferIndex();
    check(gAllocator->Reset(),"Reset draw allocator");
    check(gCmd->Reset(gAllocator.Get(),gShadowPSO.Get()),"Reset draw commands");
    drawShadowMaps();
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
    float bg[]={0.075f,0.11f,0.18f,1};
    gCmd->ClearRenderTargetView(rtv,bg,0,nullptr);
    gCmd->ClearDepthStencilView(dsv,D3D12_CLEAR_FLAG_DEPTH,1.0f,0,0,nullptr);
    gCmd->SetGraphicsRootSignature(gRoot.Get());
    ID3D12DescriptorHeap *heaps[]={gSRVHeap.Get()};
    gCmd->SetDescriptorHeaps(1,heaps);
    gCmd->SetGraphicsRootConstantBufferView(0,gFrameCB->GetGPUVirtualAddress());
    gCmd->SetGraphicsRootConstantBufferView(3,gInstancesCB->GetGPUVirtualAddress());
    gCmd->SetGraphicsRootConstantBufferView(7,gSoldierCB->GetGPUVirtualAddress());
    gCmd->SetGraphicsRootDescriptorTable(4,gShadowSRV);
    gCmd->SetGraphicsRootConstantBufferView(5,gLightsCB->GetGPUVirtualAddress());
    gCmd->SetGraphicsRootConstantBufferView(6,gGridCB->GetGPUVirtualAddress());
    gCmd->IASetPrimitiveTopology(D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
    // Four instanced draws for 600 logical objects: two tree parts,
    // 250 red soldiers, 250 blue soldiers; plus one ground draw.
    const UINT order[]={3,1,2,0,0};
    for(UINT p=0;p<5;p++) {
        Mesh &m=gMesh[order[p]];
        DrawParams draw=m.draw;
        if(p==4){
            draw.kind=3; // selects 250 blue soldiers in second army CBV range
            draw.tint[0]=0.40f;draw.tint[1]=0.66f;draw.tint[2]=1.0f;
        }
        gCmd->SetGraphicsRoot32BitConstants(1,8,&draw,0);
        gCmd->SetGraphicsRootDescriptorTable(2,m.srv);
        gCmd->IASetVertexBuffers(0,1,&m.vbv);
        gCmd->IASetIndexBuffer(&m.ibv);
        gCmd->DrawIndexedInstanced(m.indexCount,p==0?1:(p==1||p==2?TREE_COUNT:PER_ARMY),0,0,0);
    }
    auto toPresent=transition(gTargets[back].Get(),
                            D3D12_RESOURCE_STATE_RENDER_TARGET,D3D12_RESOURCE_STATE_PRESENT);
    gCmd->ResourceBarrier(1,&toPresent);
    // Prepare depth layers for the next frame, after the forward shading pass.
    auto shadowWritable=transition(gShadowDepth.Get(),
        D3D12_RESOURCE_STATE_PIXEL_SHADER_RESOURCE,D3D12_RESOURCE_STATE_DEPTH_WRITE);
    gCmd->ResourceBarrier(1,&shadowWritable);
    check(gCmd->Close(),"Close draw commands");
    ID3D12CommandList *lists[]={gCmd.Get()};
    gQueue->ExecuteCommandLists(1,lists);
    check(gSwap->Present(1,0),"Present frame");
    waitGPU(); // simple safe prototype; future versions will use multi-frame buffering
    ++gStatFrames;
    ULONGLONG t=GetTickCount64();
    if(t-gStatStart>=1000) {
        int frames=(int)(gStatFrames*1000/(t-gStatStart));
        wchar_t title[256];
        swprintf_s(title,L"NativeThreeBridge v0.9 DX12 | FPS %d | 20 moving spotlights + 20 shadow maps | 1000 trees | 2 armies",frames);
        SetWindowTextW(gWindow,title);
        gStatFrames=0;
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
    gWindow=CreateWindowW(wc.lpszClassName,L"NativeThreeBridge v0.9 | 1000 trees + 20 shadow-casting lights",
       WS_OVERLAPPED|WS_CAPTION|WS_SYSMENU|WS_MINIMIZEBOX,
       CW_USEDEFAULT,CW_USEDEFAULT,rc.right-rc.left,rc.bottom-rc.top,
       nullptr,nullptr,instance,nullptr);
    if(!gWindow)return 2;
    initializeDX12();
    NativeThreeJS_Init();
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
