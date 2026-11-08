// Standalone DX12 window for the first native HTML/Three.js prototype.
// Its sole draw type is one colored BoxGeometry. This is NOT a general
// browser or a full WebGL/Three.js renderer. The old forest EXE is untouched.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <d3d12.h>
#include <dxgi1_4.h>
#include <d3dcompiler.h>
#include <DirectXMath.h>
#include <wrl/client.h>
#include <array>
#include <vector>
#include <stdexcept>
#include <string>
#include <cstdio>
#include <cstring>
#include "app_host.h"
using Microsoft::WRL::ComPtr;
using namespace DirectX;

namespace {
constexpr UINT WIDTH=960, HEIGHT=640, FRAMES=2;
HWND windowHandle=nullptr;
void check(HRESULT hr, const char* label) {
  if (FAILED(hr)) {
    char message[256];
    std::snprintf(message,sizeof(message),"%s failed (HRESULT 0x%08lX)", label,
                  static_cast<unsigned long>(hr));
    throw std::runtime_error(message);
  }
}
LRESULT CALLBACK windowProc(HWND w,UINT msg,WPARAM wp,LPARAM lp) {
  if(msg==WM_CLOSE){DestroyWindow(w);return 0;}
  if(msg==WM_DESTROY){PostQuitMessage(0);return 0;}
  if(msg==WM_KEYDOWN && wp==VK_ESCAPE){DestroyWindow(w);return 0;}
  return DefWindowProcW(w,msg,wp,lp);
}
struct Vertex { float xyz[3], face[3]; };
struct alignas(256) Constants {
  XMFLOAT4X4 mvp;
  float tint[4];
  float unused[44]{};
};
static_assert(sizeof(Constants)==256, "CBV constants must be 256 bytes");

struct Renderer {
  ComPtr<ID3D12Device> device;
  ComPtr<ID3D12CommandQueue> queue;
  ComPtr<IDXGISwapChain3> swap;
  ComPtr<ID3D12DescriptorHeap> rtvHeap,depthHeap;
  ComPtr<ID3D12Resource> backBuffers[FRAMES],depth,vertices,constants;
  ComPtr<ID3D12CommandAllocator> allocator;
  ComPtr<ID3D12GraphicsCommandList> list;
  ComPtr<ID3D12PipelineState> pso;
  ComPtr<ID3D12RootSignature> root;
  ComPtr<ID3D12Fence> fence;
  HANDLE eventHandle=nullptr;
  UINT64 fenceValue=0;
  UINT rtvStride=0;
  D3D12_VERTEX_BUFFER_VIEW vbv{};

  ~Renderer() {
    if (eventHandle) {
      if(queue && fence) {
        queue->Signal(fence.Get(),++fenceValue);
        if(fence->GetCompletedValue()<fenceValue) {
          fence->SetEventOnCompletion(fenceValue,eventHandle);
          WaitForSingleObject(eventHandle,3000);
        }
      }
      CloseHandle(eventHandle);
    }
  }

  static D3D12_RESOURCE_DESC bufferDesc(UINT64 bytes) {
    D3D12_RESOURCE_DESC d{};
    d.Dimension=D3D12_RESOURCE_DIMENSION_BUFFER;
    d.Width=bytes;d.Height=1;d.DepthOrArraySize=1;d.MipLevels=1;
    d.SampleDesc.Count=1;d.Layout=D3D12_TEXTURE_LAYOUT_ROW_MAJOR;
    return d;
  }
  ComPtr<ID3D12Resource> makeUpload(const void* data,UINT64 bytes) {
    D3D12_HEAP_PROPERTIES heap{};heap.Type=D3D12_HEAP_TYPE_UPLOAD;
    auto desc=bufferDesc(bytes);
    ComPtr<ID3D12Resource> resource;
    check(device->CreateCommittedResource(&heap,D3D12_HEAP_FLAG_NONE,&desc,
          D3D12_RESOURCE_STATE_GENERIC_READ,nullptr,IID_PPV_ARGS(&resource)),
          "Create upload resource");
    if(data){
      void* mapped=nullptr;
      check(resource->Map(0,nullptr,&mapped),"Map upload resource");
      std::memcpy(mapped,data,(std::size_t)bytes);
      resource->Unmap(0,nullptr);
    }
    return resource;
  }
  void waitGPU() {
    check(queue->Signal(fence.Get(),++fenceValue),"Queue fence signal");
    if(fence->GetCompletedValue()<fenceValue){
      check(fence->SetEventOnCompletion(fenceValue,eventHandle),"Fence completion event");
      WaitForSingleObject(eventHandle,INFINITE);
    }
  }
  void init(HWND hwnd) {
    ComPtr<IDXGIFactory4> factory;
    check(CreateDXGIFactory1(IID_PPV_ARGS(&factory)),"CreateDXGIFactory1");
    check(D3D12CreateDevice(nullptr,D3D_FEATURE_LEVEL_11_0,IID_PPV_ARGS(&device)),
          "D3D12CreateDevice");
    D3D12_COMMAND_QUEUE_DESC q{};
    q.Type=D3D12_COMMAND_LIST_TYPE_DIRECT;
    check(device->CreateCommandQueue(&q,IID_PPV_ARGS(&queue)),"CreateCommandQueue");

    DXGI_SWAP_CHAIN_DESC1 sw{};
    sw.Width=WIDTH;sw.Height=HEIGHT;sw.Format=DXGI_FORMAT_R8G8B8A8_UNORM;
    sw.BufferUsage=DXGI_USAGE_RENDER_TARGET_OUTPUT;
    sw.BufferCount=FRAMES;sw.SampleDesc.Count=1;
    sw.SwapEffect=DXGI_SWAP_EFFECT_FLIP_DISCARD;
    ComPtr<IDXGISwapChain1> swap1;
    check(factory->CreateSwapChainForHwnd(queue.Get(),hwnd,&sw,nullptr,nullptr,&swap1),
          "CreateSwapChainForHwnd");
    check(swap1.As(&swap),"Query IDXGISwapChain3");

    D3D12_DESCRIPTOR_HEAP_DESC heapDesc{};
    heapDesc.NumDescriptors=FRAMES;heapDesc.Type=D3D12_DESCRIPTOR_HEAP_TYPE_RTV;
    check(device->CreateDescriptorHeap(&heapDesc,IID_PPV_ARGS(&rtvHeap)),"Create RTV heap");
    rtvStride=device->GetDescriptorHandleIncrementSize(D3D12_DESCRIPTOR_HEAP_TYPE_RTV);
    auto rtv=rtvHeap->GetCPUDescriptorHandleForHeapStart();
    for(UINT i=0;i<FRAMES;i++){
      check(swap->GetBuffer(i,IID_PPV_ARGS(&backBuffers[i])),"GetBuffer");
      device->CreateRenderTargetView(backBuffers[i].Get(),nullptr,rtv);
      rtv.ptr+=rtvStride;
    }
    heapDesc.NumDescriptors=1;heapDesc.Type=D3D12_DESCRIPTOR_HEAP_TYPE_DSV;
    check(device->CreateDescriptorHeap(&heapDesc,IID_PPV_ARGS(&depthHeap)),"Create DSV heap");
    D3D12_RESOURCE_DESC depthDesc{};
    depthDesc.Dimension=D3D12_RESOURCE_DIMENSION_TEXTURE2D;
    depthDesc.Width=WIDTH;depthDesc.Height=HEIGHT;
    depthDesc.DepthOrArraySize=1;depthDesc.MipLevels=1;
    depthDesc.Format=DXGI_FORMAT_D32_FLOAT;
    depthDesc.SampleDesc.Count=1;
    depthDesc.Flags=D3D12_RESOURCE_FLAG_ALLOW_DEPTH_STENCIL;
    D3D12_CLEAR_VALUE clear{};clear.Format=DXGI_FORMAT_D32_FLOAT;
    clear.DepthStencil.Depth=1.0f;
    D3D12_HEAP_PROPERTIES gpuHeap{};gpuHeap.Type=D3D12_HEAP_TYPE_DEFAULT;
    check(device->CreateCommittedResource(&gpuHeap,D3D12_HEAP_FLAG_NONE,&depthDesc,
          D3D12_RESOURCE_STATE_DEPTH_WRITE,&clear,IID_PPV_ARGS(&depth)),"Create depth texture");
    device->CreateDepthStencilView(depth.Get(),nullptr,
                                  depthHeap->GetCPUDescriptorHandleForHeapStart());

    D3D12_ROOT_PARAMETER param{};
    param.ParameterType=D3D12_ROOT_PARAMETER_TYPE_CBV;
    param.Descriptor.ShaderRegister=0;
    param.ShaderVisibility=D3D12_SHADER_VISIBILITY_VERTEX;
    D3D12_ROOT_SIGNATURE_DESC sig{};
    sig.NumParameters=1;sig.pParameters=&param;
    sig.Flags=D3D12_ROOT_SIGNATURE_FLAG_ALLOW_INPUT_ASSEMBLER_INPUT_LAYOUT;
    ComPtr<ID3DBlob> rootBlob,errors;
    check(D3D12SerializeRootSignature(&sig,D3D_ROOT_SIGNATURE_VERSION_1,
          &rootBlob,&errors),"Serialize root signature");
    check(device->CreateRootSignature(0,rootBlob->GetBufferPointer(),
          rootBlob->GetBufferSize(),IID_PPV_ARGS(&root)),"CreateRootSignature");

    const char* shader=R"HLSL(
cbuffer C : register(b0) { row_major float4x4 mvp; float4 tint; };
struct In { float3 xyz:POSITION; float3 face:COLOR; };
struct Out { float4 pos:SV_POSITION; float3 face:COLOR; };
Out VS(In i) { Out o; o.pos=mul(float4(i.xyz,1),mvp); o.face=i.face; return o; }
float4 PS(Out i):SV_TARGET {
  float3 linear = saturate(tint.rgb*i.face);
  return float4(pow(linear,float3(1.0/2.2,1.0/2.2,1.0/2.2)),1);
}
)HLSL";
    ComPtr<ID3DBlob> vs,ps;
    check(D3DCompile(shader,std::strlen(shader),nullptr,nullptr,nullptr,"VS",
          "vs_5_0",D3DCOMPILE_ENABLE_STRICTNESS,0,&vs,&errors),"Compile vertex shader");
    errors.Reset();
    check(D3DCompile(shader,std::strlen(shader),nullptr,nullptr,nullptr,"PS",
          "ps_5_0",D3DCOMPILE_ENABLE_STRICTNESS,0,&ps,&errors),"Compile pixel shader");
    D3D12_INPUT_ELEMENT_DESC layout[]={
      {"POSITION",0,DXGI_FORMAT_R32G32B32_FLOAT,0,0,D3D12_INPUT_CLASSIFICATION_PER_VERTEX_DATA,0},
      {"COLOR",0,DXGI_FORMAT_R32G32B32_FLOAT,0,12,D3D12_INPUT_CLASSIFICATION_PER_VERTEX_DATA,0}
    };
    D3D12_GRAPHICS_PIPELINE_STATE_DESC pipe{};
    pipe.pRootSignature=root.Get();
    pipe.InputLayout={layout,2};
    pipe.VS={vs->GetBufferPointer(),vs->GetBufferSize()};
    pipe.PS={ps->GetBufferPointer(),ps->GetBufferSize()};
    pipe.RasterizerState.FillMode=D3D12_FILL_MODE_SOLID;
    pipe.RasterizerState.CullMode=D3D12_CULL_MODE_NONE;
    pipe.RasterizerState.DepthClipEnable=TRUE;
    pipe.BlendState.RenderTarget[0].RenderTargetWriteMask=D3D12_COLOR_WRITE_ENABLE_ALL;
    pipe.DepthStencilState.DepthEnable=TRUE;
    pipe.DepthStencilState.DepthWriteMask=D3D12_DEPTH_WRITE_MASK_ALL;
    pipe.DepthStencilState.DepthFunc=D3D12_COMPARISON_FUNC_LESS;
    pipe.SampleMask=UINT_MAX;
    pipe.PrimitiveTopologyType=D3D12_PRIMITIVE_TOPOLOGY_TYPE_TRIANGLE;
    pipe.NumRenderTargets=1;
    pipe.RTVFormats[0]=DXGI_FORMAT_R8G8B8A8_UNORM;
    pipe.DSVFormat=DXGI_FORMAT_D32_FLOAT;
    pipe.SampleDesc.Count=1;
    check(device->CreateGraphicsPipelineState(&pipe,IID_PPV_ARGS(&pso)),
          "Create cube pipeline");

    // 6 independent faces, 2 triangles per face (36 vertices).
    std::vector<Vertex> mesh;
    const float points[][3]={
      {-1,-1,-1},{1,-1,-1},{1,1,-1},{-1,1,-1},
      {-1,-1, 1},{1,-1, 1},{1,1, 1},{-1,1, 1}
    };
    const int faces[6][4]={
      {4,5,6,7},{1,0,3,2},{0,4,7,3},
      {5,1,2,6},{3,7,6,2},{0,1,5,4}
    };
    const float shades[6]={1.f,.48f,.67f,.82f,.94f,.58f};
    const int triangles[]={0,1,2,0,2,3};
    for(int side=0;side<6;side++){
      for(int t:triangles){
        Vertex v{};
        std::memcpy(v.xyz,points[faces[side][t]],sizeof(v.xyz));
        v.face[0]=shades[side];v.face[1]=shades[side];v.face[2]=shades[side];
        mesh.push_back(v);
      }
    }
    vertices=makeUpload(mesh.data(),mesh.size()*sizeof(Vertex));
    vbv.BufferLocation=vertices->GetGPUVirtualAddress();
    vbv.SizeInBytes=(UINT)(mesh.size()*sizeof(Vertex));
    vbv.StrideInBytes=sizeof(Vertex);
    constants=makeUpload(nullptr,sizeof(Constants));
    check(device->CreateCommandAllocator(D3D12_COMMAND_LIST_TYPE_DIRECT,
          IID_PPV_ARGS(&allocator)),"CreateCommandAllocator");
    check(device->CreateCommandList(0,D3D12_COMMAND_LIST_TYPE_DIRECT,allocator.Get(),
          pso.Get(),IID_PPV_ARGS(&list)),"CreateCommandList");
    check(list->Close(),"Close initial command list");
    check(device->CreateFence(0,D3D12_FENCE_FLAG_NONE,IID_PPV_ARGS(&fence)),"CreateFence");
    eventHandle=CreateEventW(nullptr,FALSE,FALSE,nullptr);
    if(!eventHandle)throw std::runtime_error("CreateEvent failed");
  }
  void render(const WebAppFrame& frame) {
    XMMATRIX model = XMMatrixSet(
      frame.model[0],frame.model[1],frame.model[2],frame.model[3],
      frame.model[4],frame.model[5],frame.model[6],frame.model[7],
      frame.model[8],frame.model[9],frame.model[10],frame.model[11],
      frame.model[12],frame.model[13],frame.model[14],frame.model[15]);
    const XMMATRIX view=XMMatrixLookAtRH(XMVectorSet(0,0,6,1),
                                        XMVectorZero(),XMVectorSet(0,1,0,0));
    const XMMATRIX proj=XMMatrixPerspectiveFovRH(XMConvertToRadians(60.f),
                                                 float(WIDTH)/HEIGHT,.1f,100.f);
    Constants data{};
    XMStoreFloat4x4(&data.mvp,model*view*proj);
    data.tint[0]=frame.rgb[0];data.tint[1]=frame.rgb[1];
    data.tint[2]=frame.rgb[2];data.tint[3]=1.f;
    void* mapped=nullptr;
    check(constants->Map(0,nullptr,&mapped),"Map constant buffer");
    std::memcpy(mapped,&data,sizeof(data));
    constants->Unmap(0,nullptr);

    const UINT index=swap->GetCurrentBackBufferIndex();
    check(allocator->Reset(),"Reset command allocator");
    check(list->Reset(allocator.Get(),pso.Get()),"Reset graphics list");
    D3D12_RESOURCE_BARRIER barrier{};
    barrier.Type=D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;
    barrier.Transition.pResource=backBuffers[index].Get();
    barrier.Transition.Subresource=D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES;
    barrier.Transition.StateBefore=D3D12_RESOURCE_STATE_PRESENT;
    barrier.Transition.StateAfter=D3D12_RESOURCE_STATE_RENDER_TARGET;
    list->ResourceBarrier(1,&barrier);

    D3D12_VIEWPORT viewport{0.f,0.f,float(WIDTH),float(HEIGHT),0.f,1.f};
    D3D12_RECT scissor{0,0,(LONG)WIDTH,(LONG)HEIGHT};
    list->RSSetViewports(1,&viewport);
    list->RSSetScissorRects(1,&scissor);
    auto rtv=rtvHeap->GetCPUDescriptorHandleForHeapStart();
    rtv.ptr+=index*rtvStride;
    auto dsv=depthHeap->GetCPUDescriptorHandleForHeapStart();
    const float background[]={.01f,.018f,.035f,1.f};
    list->ClearRenderTargetView(rtv,background,0,nullptr);
    list->ClearDepthStencilView(dsv,D3D12_CLEAR_FLAG_DEPTH,1.f,0,0,nullptr);
    list->OMSetRenderTargets(1,&rtv,FALSE,&dsv);
    list->SetGraphicsRootSignature(root.Get());
    list->SetGraphicsRootConstantBufferView(0,constants->GetGPUVirtualAddress());
    list->IASetPrimitiveTopology(D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
    list->IASetVertexBuffers(0,1,&vbv);
    list->DrawInstanced(36,1,0,0);
    barrier.Transition.StateBefore=D3D12_RESOURCE_STATE_RENDER_TARGET;
    barrier.Transition.StateAfter=D3D12_RESOURCE_STATE_PRESENT;
    list->ResourceBarrier(1,&barrier);
    check(list->Close(),"Close render commands");
    ID3D12CommandList* lists[]={list.Get()};
    queue->ExecuteCommandLists(1,lists);
    check(swap->Present(1,0),"SwapChain Present");
    waitGPU(); // Prototype simplicity; does not modify the optimized forest renderer.
  }
};
} // namespace

int WINAPI wWinMain(HINSTANCE instance,HINSTANCE,LPWSTR,int show) {
  try {
    WNDCLASSW cls{};
    cls.lpfnWndProc=windowProc;cls.hInstance=instance;
    cls.lpszClassName=L"NativeThree-WebApp-DX12";
    cls.hCursor=LoadCursor(nullptr,IDC_ARROW);
    if(!RegisterClassW(&cls))throw std::runtime_error("RegisterClassW failed");
    RECT r{0,0,(LONG)WIDTH,(LONG)HEIGHT};
    AdjustWindowRect(&r,WS_OVERLAPPED|WS_CAPTION|WS_SYSMENU|WS_MINIMIZEBOX,FALSE);
    windowHandle=CreateWindowW(cls.lpszClassName,
      L"NativeThreeBridge v0.26 WebApp prototype - real Three.js + DX12",
      WS_OVERLAPPED|WS_CAPTION|WS_SYSMENU|WS_MINIMIZEBOX,
      CW_USEDEFAULT,CW_USEDEFAULT,r.right-r.left,r.bottom-r.top,
      nullptr,nullptr,instance,nullptr);
    if(!windowHandle)throw std::runtime_error("CreateWindowW failed");
    ShowWindow(windowHandle,show);

    wchar_t module[MAX_PATH]{};
    DWORD n=GetModuleFileNameW(nullptr,module,MAX_PATH);
    if(!n || n>=MAX_PATH)throw std::runtime_error("GetModuleFileNameW failed");
    std::wstring base(module,n);
    base.resize(base.find_last_of(L"\\/"));
    std::string jsError;
    if(!WebApp_Init(base+L"\\webapp\\index.html",jsError))
      throw std::runtime_error("Cannot open webapp/index.html:\n"+jsError);
    Renderer dx12;dx12.init(windowHandle);
    LARGE_INTEGER freq{},start{},clock{};
    QueryPerformanceFrequency(&freq);
    QueryPerformanceCounter(&start);
    MSG message{};
    bool running=true;
    while(running) {
      while(PeekMessageW(&message,nullptr,0,0,PM_REMOVE)){
        if(message.message==WM_QUIT){running=false;break;}
        TranslateMessage(&message);DispatchMessageW(&message);
      }
      if(!running)break;
      QueryPerformanceCounter(&clock);
      const double ms=1000.0*(clock.QuadPart-start.QuadPart)/freq.QuadPart;
      WebAppFrame frame{};
      if(!WebApp_Tick(ms,frame,jsError))
        throw std::runtime_error("Three.js WebApp frame failed:\n"+jsError);
      dx12.render(frame);
    }
    WebApp_Shutdown();
    return 0;
  } catch(const std::exception& e) {
    WebApp_Shutdown();
    MessageBoxA(windowHandle,e.what(),"NativeThreeBridge WebApp error",MB_OK|MB_ICONERROR);
    return 1;
  }
}
