// Generic DX12 renderer + Win32 window for ordinary Three.js webapps.
// The JS side (js/native-renderer.mjs) sends geometry, instance buffers and
// one packet per render() call; this file turns them into DX12 draws.
#include "webapp_dx12.h"

#include <windowsx.h>
#include <shellapi.h>
#include <d3d12.h>
#include <dxgi1_6.h>
#include <d3dcompiler.h>
#include <wrl/client.h>

#include <algorithm>
#include <chrono>
#include <climits>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <map>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

#include "webapp_host.h"
#include "webapp_resources.h"
#include "webapp_shader.h"

#pragma comment(lib, "d3d12.lib")
#pragma comment(lib, "dxgi.lib")
#pragma comment(lib, "d3dcompiler.lib")
#pragma comment(lib, "user32.lib")
#pragma comment(lib, "shell32.lib")

using Microsoft::WRL::ComPtr;
using native_three::WebappHost;

namespace {

constexpr UINT kFrameCount = 2;
constexpr UINT kVertexStride = 9 * sizeof(float);    // position, normal, colour
constexpr UINT kInstanceStride = 19 * sizeof(float); // 4x4 matrix + colour
constexpr UINT kFrameCBBytes = 1280;                 // see cbuffer Frame
constexpr UINT kDrawCBBytes = 256;
// Draw flags (js/native-renderer.mjs DrawFlags)
constexpr UINT F_TRANSPARENT = 1, F_DOUBLE = 2, F_BACK = 4, F_NO_DEPTH_WRITE = 32,
               F_NO_DEPTH_TEST = 64, F_LINES = 128, F_LINE_STRIP = 256;
constexpr UINT P_CLEAR_COLOR = 1, P_CLEAR_DEPTH = 2;

std::wstring widen(const std::string& s) {
    if (s.empty()) return {};
    const int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), nullptr, 0);
    std::wstring w(n, L'\0');
    MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), w.data(), n);
    return w;
}

D3D12_HEAP_PROPERTIES heapProps(D3D12_HEAP_TYPE type) {
    D3D12_HEAP_PROPERTIES p{};
    p.Type = type;
    p.CreationNodeMask = 1;
    p.VisibleNodeMask = 1;
    return p;
}
D3D12_RESOURCE_DESC bufferDesc(UINT64 bytes) {
    D3D12_RESOURCE_DESC d{};
    d.Dimension = D3D12_RESOURCE_DIMENSION_BUFFER;
    d.Width = std::max<UINT64>(bytes, 256);
    d.Height = 1;
    d.DepthOrArraySize = 1;
    d.MipLevels = 1;
    d.SampleDesc.Count = 1;
    d.Layout = D3D12_TEXTURE_LAYOUT_ROW_MAJOR;
    return d;
}

struct Geometry {
    ComPtr<ID3D12Resource> vertices, indices;
    D3D12_VERTEX_BUFFER_VIEW vbv{};
    D3D12_INDEX_BUFFER_VIEW ibv{};
    UINT vertexCount = 0, indexCount = 0;
};
struct InstanceSet {
    std::vector<float> cpu;   // count * 19 floats
    UINT count = 0;
    UINT64 version = 0;
    ComPtr<ID3D12Resource> gpu[kFrameCount];
    UINT capacity[kFrameCount] = {};
    UINT64 uploaded[kFrameCount] = {};
};
struct Retired {
    ComPtr<ID3D12Resource> resource;
    UINT64 fence;
};

class WebappWindow final : public native_three::WebappRenderSink {
public:
    explicit WebappWindow(std::filesystem::path root) : root_(std::move(root)) {}
    int run(HINSTANCE instance);

    // ---- WebappRenderSink
    void uploadGeometry(std::uint32_t id, const float* p, const float* n, const float* c,
                        std::uint32_t vertexCount, const std::uint32_t* idx, std::uint32_t indexCount) override;
    void releaseGeometry(std::uint32_t id) override;
    void uploadInstances(std::uint32_t id, const float* m, const float* c, std::uint32_t count) override;
    void releaseInstances(std::uint32_t id) override { instances_.erase(id); }
    void submitPass(const float* data, std::size_t floats) override {
        pendingPasses_.emplace_back(data, data + floats);
    }
    void setTitle(const std::string& title) override { pageTitle_ = widen(title); }
    void log(const std::string& level, const std::string& text) override;

    LRESULT handle(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp);

private:
    void check(HRESULT hr, const char* what);
    void initDevice();
    void createSizeDependent();
    void releaseSizeDependent();
    void resize(UINT width, UINT height);
    void waitForGpu();
    ComPtr<ID3D12Resource> uploadBuffer(const void* data, UINT64 bytes);
    void retire(ComPtr<ID3D12Resource>& resource);
    void collectRetired();
    ID3D12PipelineState* pipeline(UINT flags);
    void renderFrame();
    void updateTitle(double fps);
    void keyEvent(bool down, WPARAM vk, LPARAM lp);

    std::filesystem::path root_;
    HWND window_ = nullptr;
    UINT width_ = 1280, height_ = 720;
    bool minimized_ = false;
    WebappHost host_;
    std::FILE* log_ = nullptr;
    std::wstring pageTitle_ = L"Three.js webapp";
    std::wstring adapterName_ = L"GPU";
    int logErrors_ = 0;
    bool bootDialogShown_ = false;

    ComPtr<IDXGIFactory4> factory_;
    ComPtr<ID3D12Device> device_;
    ComPtr<ID3D12CommandQueue> queue_;
    ComPtr<IDXGISwapChain3> swap_;
    ComPtr<ID3D12DescriptorHeap> rtvHeap_, dsvHeap_;
    UINT rtvStep_ = 0;
    ComPtr<ID3D12Resource> targets_[kFrameCount], depth_;
    ComPtr<ID3D12CommandAllocator> allocators_[kFrameCount];
    ComPtr<ID3D12GraphicsCommandList> cmd_;
    ComPtr<ID3D12Fence> fence_;
    HANDLE fenceEvent_ = nullptr;
    UINT64 fenceValue_ = 0;
    UINT64 frameFence_[kFrameCount] = {};
    ComPtr<ID3D12RootSignature> root_sig_;
    ComPtr<ID3DBlob> vs_, ps_;
    std::map<UINT, ComPtr<ID3D12PipelineState>> pipelines_;
    ComPtr<ID3D12Resource> ring_[kFrameCount];
    UINT64 ringBytes_[kFrameCount] = {};
    ComPtr<ID3D12Resource> identityInstance_;
    D3D12_VERTEX_BUFFER_VIEW identityView_{};

    std::unordered_map<std::uint32_t, Geometry> geometries_;
    std::unordered_map<std::uint32_t, InstanceSet> instances_;
    std::vector<Retired> retired_;
    std::vector<std::vector<float>> pendingPasses_, passes_;
    UINT lastDraws_ = 0;
};

WebappWindow* gActive = nullptr;

LRESULT CALLBACK webappWndProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    if (gActive) return gActive->handle(hwnd, msg, wp, lp);
    return DefWindowProcW(hwnd, msg, wp, lp);
}

void WebappWindow::check(HRESULT hr, const char* what) {
    if (SUCCEEDED(hr)) return;
    char text[512];
    std::snprintf(text, sizeof text, "%s failed (HRESULT 0x%08lX)", what, (unsigned long)hr);
    log("error", text);
    if (GetEnvironmentVariableA("CI", nullptr, 0) == 0)
        MessageBoxA(window_, text, "NativeThreeBridge webapp", MB_OK | MB_ICONERROR);
    ExitProcess(44);
}

void WebappWindow::log(const std::string& level, const std::string& text) {
    if (level == "error") logErrors_++;
    if (log_) {
        std::fprintf(log_, "[%s] %s\n", level.c_str(), text.c_str());
        std::fflush(log_);
    }
    OutputDebugStringA(("[webapp " + level + "] " + text + "\n").c_str());
}

void WebappWindow::initDevice() {
    check(CreateDXGIFactory2(0, IID_PPV_ARGS(&factory_)), "Create DXGI factory");
    ComPtr<IDXGIFactory6> factory6;
    if (SUCCEEDED(factory_.As(&factory6))) {
        for (UINT i = 0;; i++) {
            ComPtr<IDXGIAdapter1> adapter;
            if (factory6->EnumAdapterByGpuPreference(i, DXGI_GPU_PREFERENCE_HIGH_PERFORMANCE,
                                                     IID_PPV_ARGS(&adapter)) == DXGI_ERROR_NOT_FOUND)
                break;
            DXGI_ADAPTER_DESC1 info{};
            adapter->GetDesc1(&info);
            if (info.Flags & DXGI_ADAPTER_FLAG_SOFTWARE) continue;
            if (SUCCEEDED(D3D12CreateDevice(adapter.Get(), D3D_FEATURE_LEVEL_11_0, IID_PPV_ARGS(&device_)))) {
                adapterName_ = info.Description;
                break;
            }
        }
    }
    if (!device_ && FAILED(D3D12CreateDevice(nullptr, D3D_FEATURE_LEVEL_11_0, IID_PPV_ARGS(&device_)))) {
        ComPtr<IDXGIAdapter> warp;
        check(factory_->EnumWarpAdapter(IID_PPV_ARGS(&warp)), "Find WARP adapter");
        check(D3D12CreateDevice(warp.Get(), D3D_FEATURE_LEVEL_11_0, IID_PPV_ARGS(&device_)), "Create DX12 device");
        adapterName_ = L"WARP (software)";
    }
    D3D12_COMMAND_QUEUE_DESC q{};
    q.Type = D3D12_COMMAND_LIST_TYPE_DIRECT;
    check(device_->CreateCommandQueue(&q, IID_PPV_ARGS(&queue_)), "Create command queue");

    DXGI_SWAP_CHAIN_DESC1 sd{};
    sd.Width = width_;
    sd.Height = height_;
    sd.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
    sd.SampleDesc.Count = 1;
    sd.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
    sd.BufferCount = kFrameCount;
    sd.SwapEffect = DXGI_SWAP_EFFECT_FLIP_DISCARD;
    ComPtr<IDXGISwapChain1> swap1;
    check(factory_->CreateSwapChainForHwnd(queue_.Get(), window_, &sd, nullptr, nullptr, &swap1), "Create swap chain");
    check(swap1.As(&swap_), "Swap chain v3");
    factory_->MakeWindowAssociation(window_, DXGI_MWA_NO_ALT_ENTER);

    D3D12_DESCRIPTOR_HEAP_DESC heap{};
    heap.NumDescriptors = kFrameCount;
    heap.Type = D3D12_DESCRIPTOR_HEAP_TYPE_RTV;
    check(device_->CreateDescriptorHeap(&heap, IID_PPV_ARGS(&rtvHeap_)), "RTV heap");
    rtvStep_ = device_->GetDescriptorHandleIncrementSize(D3D12_DESCRIPTOR_HEAP_TYPE_RTV);
    heap.NumDescriptors = 1;
    heap.Type = D3D12_DESCRIPTOR_HEAP_TYPE_DSV;
    check(device_->CreateDescriptorHeap(&heap, IID_PPV_ARGS(&dsvHeap_)), "DSV heap");

    for (UINT i = 0; i < kFrameCount; i++)
        check(device_->CreateCommandAllocator(D3D12_COMMAND_LIST_TYPE_DIRECT, IID_PPV_ARGS(&allocators_[i])), "Command allocator");
    check(device_->CreateCommandList(0, D3D12_COMMAND_LIST_TYPE_DIRECT, allocators_[0].Get(), nullptr,
                                     IID_PPV_ARGS(&cmd_)), "Command list");
    cmd_->Close();
    check(device_->CreateFence(0, D3D12_FENCE_FLAG_NONE, IID_PPV_ARGS(&fence_)), "Fence");
    fenceEvent_ = CreateEventW(nullptr, FALSE, FALSE, nullptr);

    // Root signature: b0 = frame constants, b1 = per-draw constants.
    D3D12_ROOT_PARAMETER params[2]{};
    for (UINT i = 0; i < 2; i++) {
        params[i].ParameterType = D3D12_ROOT_PARAMETER_TYPE_CBV;
        params[i].Descriptor.ShaderRegister = i;
        params[i].ShaderVisibility = D3D12_SHADER_VISIBILITY_ALL;
    }
    D3D12_ROOT_SIGNATURE_DESC rs{};
    rs.NumParameters = 2;
    rs.pParameters = params;
    rs.Flags = D3D12_ROOT_SIGNATURE_FLAG_ALLOW_INPUT_ASSEMBLER_INPUT_LAYOUT;
    ComPtr<ID3DBlob> blob, error;
    check(D3D12SerializeRootSignature(&rs, D3D_ROOT_SIGNATURE_VERSION_1, &blob, &error), "Serialize root signature");
    check(device_->CreateRootSignature(0, blob->GetBufferPointer(), blob->GetBufferSize(), IID_PPV_ARGS(&root_sig_)), "Root signature");

    for (int stage = 0; stage < 2; stage++) {
        ComPtr<ID3DBlob> err;
        ID3DBlob** out = stage ? ps_.ReleaseAndGetAddressOf() : vs_.ReleaseAndGetAddressOf();
        HRESULT hr = D3DCompile(kWebappShader, std::strlen(kWebappShader), "webapp_shader", nullptr, nullptr,
                                stage ? "PSMain" : "VSMain", stage ? "ps_5_0" : "vs_5_0",
                                D3DCOMPILE_OPTIMIZATION_LEVEL3, 0, out, err.GetAddressOf());
        if (FAILED(hr) && err) log("error", static_cast<const char*>(err->GetBufferPointer()));
        check(hr, stage ? "Compile webapp pixel shader" : "Compile webapp vertex shader");
    }

    const float identity[19] = {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 1, 1};
    identityInstance_ = uploadBuffer(identity, sizeof identity);
    identityView_.BufferLocation = identityInstance_->GetGPUVirtualAddress();
    identityView_.SizeInBytes = sizeof identity;
    identityView_.StrideInBytes = kInstanceStride;
    createSizeDependent();
}

void WebappWindow::createSizeDependent() {
    for (UINT i = 0; i < kFrameCount; i++) {
        check(swap_->GetBuffer(i, IID_PPV_ARGS(&targets_[i])), "Get back buffer");
        D3D12_CPU_DESCRIPTOR_HANDLE rtv = rtvHeap_->GetCPUDescriptorHandleForHeapStart();
        rtv.ptr += SIZE_T(i) * rtvStep_;
        device_->CreateRenderTargetView(targets_[i].Get(), nullptr, rtv);
    }
    D3D12_RESOURCE_DESC d{};
    d.Dimension = D3D12_RESOURCE_DIMENSION_TEXTURE2D;
    d.Width = width_;
    d.Height = height_;
    d.DepthOrArraySize = 1;
    d.MipLevels = 1;
    d.Format = DXGI_FORMAT_D32_FLOAT;
    d.SampleDesc.Count = 1;
    d.Flags = D3D12_RESOURCE_FLAG_ALLOW_DEPTH_STENCIL;
    D3D12_CLEAR_VALUE clear{};
    clear.Format = DXGI_FORMAT_D32_FLOAT;
    clear.DepthStencil.Depth = 1.0f;
    auto heap = heapProps(D3D12_HEAP_TYPE_DEFAULT);
    check(device_->CreateCommittedResource(&heap, D3D12_HEAP_FLAG_NONE, &d, D3D12_RESOURCE_STATE_DEPTH_WRITE,
                                           &clear, IID_PPV_ARGS(&depth_)), "Depth buffer");
    device_->CreateDepthStencilView(depth_.Get(), nullptr, dsvHeap_->GetCPUDescriptorHandleForHeapStart());
}

void WebappWindow::releaseSizeDependent() {
    for (auto& t : targets_) t.Reset();
    depth_.Reset();
}

void WebappWindow::waitForGpu() {
    if (!queue_ || !fence_) return;
    const UINT64 value = ++fenceValue_;
    queue_->Signal(fence_.Get(), value);
    if (fence_->GetCompletedValue() < value) {
        fence_->SetEventOnCompletion(value, fenceEvent_);
        WaitForSingleObject(fenceEvent_, INFINITE);
    }
    collectRetired();
}

void WebappWindow::resize(UINT width, UINT height) {
    width = std::max<UINT>(1, width);
    height = std::max<UINT>(1, height);
    if (width == width_ && height == height_) return;
    width_ = width;
    height_ = height;
    if (swap_) {
        waitForGpu();
        releaseSizeDependent();
        check(swap_->ResizeBuffers(kFrameCount, width_, height_, DXGI_FORMAT_R8G8B8A8_UNORM, 0), "Resize swap chain");
        createSizeDependent();
    }
    host_.resize((int)width_, (int)height_, 1.0);
}

ComPtr<ID3D12Resource> WebappWindow::uploadBuffer(const void* data, UINT64 bytes) {
    ComPtr<ID3D12Resource> buffer;
    auto heap = heapProps(D3D12_HEAP_TYPE_UPLOAD);
    auto desc = bufferDesc(bytes);
    check(device_->CreateCommittedResource(&heap, D3D12_HEAP_FLAG_NONE, &desc, D3D12_RESOURCE_STATE_GENERIC_READ,
                                           nullptr, IID_PPV_ARGS(&buffer)), "Upload buffer");
    if (data && bytes) {
        void* mapped = nullptr;
        D3D12_RANGE none{0, 0};
        check(buffer->Map(0, &none, &mapped), "Map upload buffer");
        std::memcpy(mapped, data, (size_t)bytes);
        buffer->Unmap(0, nullptr);
    }
    return buffer;
}

void WebappWindow::retire(ComPtr<ID3D12Resource>& resource) {
    if (resource) retired_.push_back({resource, fenceValue_ + kFrameCount});
    resource.Reset();
}
void WebappWindow::collectRetired() {
    const UINT64 done = fence_ ? fence_->GetCompletedValue() : ~0ull;
    retired_.erase(std::remove_if(retired_.begin(), retired_.end(),
                                  [done](const Retired& r) { return r.fence <= done; }),
                   retired_.end());
}

void WebappWindow::uploadGeometry(std::uint32_t id, const float* p, const float* n, const float* c,
                                  std::uint32_t vertexCount, const std::uint32_t* idx, std::uint32_t indexCount) {
    std::vector<float> interleaved(size_t(vertexCount) * 9);
    for (std::uint32_t v = 0; v < vertexCount; v++) {
        float* o = &interleaved[size_t(v) * 9];
        o[0] = p[v * 3]; o[1] = p[v * 3 + 1]; o[2] = p[v * 3 + 2];
        o[3] = n ? n[v * 3] : 0; o[4] = n ? n[v * 3 + 1] : 1; o[5] = n ? n[v * 3 + 2] : 0;
        o[6] = c ? c[v * 3] : 1; o[7] = c ? c[v * 3 + 1] : 1; o[8] = c ? c[v * 3 + 2] : 1;
    }
    Geometry& g = geometries_[id];
    retire(g.vertices);
    retire(g.indices);
    g.vertexCount = vertexCount;
    g.indexCount = idx ? indexCount : 0;
    g.vertices = uploadBuffer(interleaved.data(), interleaved.size() * sizeof(float));
    g.vbv.BufferLocation = g.vertices->GetGPUVirtualAddress();
    g.vbv.SizeInBytes = UINT(interleaved.size() * sizeof(float));
    g.vbv.StrideInBytes = kVertexStride;
    if (idx && indexCount) {
        g.indices = uploadBuffer(idx, UINT64(indexCount) * sizeof(std::uint32_t));
        g.ibv.BufferLocation = g.indices->GetGPUVirtualAddress();
        g.ibv.SizeInBytes = indexCount * sizeof(std::uint32_t);
        g.ibv.Format = DXGI_FORMAT_R32_UINT;
    }
}

void WebappWindow::releaseGeometry(std::uint32_t id) {
    auto it = geometries_.find(id);
    if (it == geometries_.end()) return;
    retire(it->second.vertices);
    retire(it->second.indices);
    geometries_.erase(it);
}

void WebappWindow::uploadInstances(std::uint32_t id, const float* m, const float* c, std::uint32_t count) {
    InstanceSet& set = instances_[id];
    set.count = count;
    set.cpu.resize(size_t(count) * 19);
    for (std::uint32_t i = 0; i < count; i++) {
        float* o = &set.cpu[size_t(i) * 19];
        std::memcpy(o, m + size_t(i) * 16, 16 * sizeof(float));
        o[16] = c ? c[i * 3] : 1;
        o[17] = c ? c[i * 3 + 1] : 1;
        o[18] = c ? c[i * 3 + 2] : 1;
    }
    set.version++;
}

ID3D12PipelineState* WebappWindow::pipeline(UINT flags) {
    const bool lines = (flags & (F_LINES | F_LINE_STRIP)) != 0;
    const UINT cull = (flags & F_DOUBLE) || lines ? 1 : (flags & F_BACK) ? 2 : 0;
    const UINT key = (lines ? 1u : 0u) | (cull << 1) | ((flags & F_TRANSPARENT) ? 8u : 0u) |
                     ((flags & F_NO_DEPTH_WRITE) ? 16u : 0u) | ((flags & F_NO_DEPTH_TEST) ? 32u : 0u);
    auto found = pipelines_.find(key);
    if (found != pipelines_.end()) return found->second.Get();

    const D3D12_INPUT_ELEMENT_DESC layout[] = {
        {"POSITION", 0, DXGI_FORMAT_R32G32B32_FLOAT, 0, 0, D3D12_INPUT_CLASSIFICATION_PER_VERTEX_DATA, 0},
        {"NORMAL", 0, DXGI_FORMAT_R32G32B32_FLOAT, 0, 12, D3D12_INPUT_CLASSIFICATION_PER_VERTEX_DATA, 0},
        {"COLOR", 0, DXGI_FORMAT_R32G32B32_FLOAT, 0, 24, D3D12_INPUT_CLASSIFICATION_PER_VERTEX_DATA, 0},
        {"IROW", 0, DXGI_FORMAT_R32G32B32A32_FLOAT, 1, 0, D3D12_INPUT_CLASSIFICATION_PER_INSTANCE_DATA, 1},
        {"IROW", 1, DXGI_FORMAT_R32G32B32A32_FLOAT, 1, 16, D3D12_INPUT_CLASSIFICATION_PER_INSTANCE_DATA, 1},
        {"IROW", 2, DXGI_FORMAT_R32G32B32A32_FLOAT, 1, 32, D3D12_INPUT_CLASSIFICATION_PER_INSTANCE_DATA, 1},
        {"IROW", 3, DXGI_FORMAT_R32G32B32A32_FLOAT, 1, 48, D3D12_INPUT_CLASSIFICATION_PER_INSTANCE_DATA, 1},
        {"ICOLOR", 0, DXGI_FORMAT_R32G32B32_FLOAT, 1, 64, D3D12_INPUT_CLASSIFICATION_PER_INSTANCE_DATA, 1},
    };
    D3D12_GRAPHICS_PIPELINE_STATE_DESC d{};
    d.pRootSignature = root_sig_.Get();
    d.VS = {vs_->GetBufferPointer(), vs_->GetBufferSize()};
    d.PS = {ps_->GetBufferPointer(), ps_->GetBufferSize()};
    d.InputLayout = {layout, UINT(sizeof layout / sizeof layout[0])};
    d.PrimitiveTopologyType = lines ? D3D12_PRIMITIVE_TOPOLOGY_TYPE_LINE : D3D12_PRIMITIVE_TOPOLOGY_TYPE_TRIANGLE;
    d.RasterizerState.FillMode = D3D12_FILL_MODE_SOLID;
    d.RasterizerState.CullMode = cull == 1 ? D3D12_CULL_MODE_NONE : cull == 2 ? D3D12_CULL_MODE_FRONT : D3D12_CULL_MODE_BACK;
    d.RasterizerState.FrontCounterClockwise = TRUE; // Three.js / OpenGL winding
    d.RasterizerState.DepthClipEnable = TRUE;
    auto& rt = d.BlendState.RenderTarget[0];
    rt.RenderTargetWriteMask = D3D12_COLOR_WRITE_ENABLE_ALL;
    if (flags & F_TRANSPARENT) {
        rt.BlendEnable = TRUE;
        rt.SrcBlend = D3D12_BLEND_SRC_ALPHA;
        rt.DestBlend = D3D12_BLEND_INV_SRC_ALPHA;
        rt.BlendOp = D3D12_BLEND_OP_ADD;
        rt.SrcBlendAlpha = D3D12_BLEND_ONE;
        rt.DestBlendAlpha = D3D12_BLEND_INV_SRC_ALPHA;
        rt.BlendOpAlpha = D3D12_BLEND_OP_ADD;
    } else {
        rt.SrcBlend = D3D12_BLEND_ONE;
        rt.DestBlend = D3D12_BLEND_ZERO;
        rt.BlendOp = D3D12_BLEND_OP_ADD;
        rt.SrcBlendAlpha = D3D12_BLEND_ONE;
        rt.DestBlendAlpha = D3D12_BLEND_ZERO;
        rt.BlendOpAlpha = D3D12_BLEND_OP_ADD;
    }
    rt.LogicOp = D3D12_LOGIC_OP_NOOP;
    d.DepthStencilState.DepthEnable = (flags & F_NO_DEPTH_TEST) ? FALSE : TRUE;
    d.DepthStencilState.DepthWriteMask = (flags & F_NO_DEPTH_WRITE) ? D3D12_DEPTH_WRITE_MASK_ZERO : D3D12_DEPTH_WRITE_MASK_ALL;
    d.DepthStencilState.DepthFunc = D3D12_COMPARISON_FUNC_LESS_EQUAL;
    d.SampleMask = UINT_MAX;
    d.NumRenderTargets = 1;
    d.RTVFormats[0] = DXGI_FORMAT_R8G8B8A8_UNORM;
    d.DSVFormat = DXGI_FORMAT_D32_FLOAT;
    d.SampleDesc.Count = 1;
    ComPtr<ID3D12PipelineState> pso;
    check(device_->CreateGraphicsPipelineState(&d, IID_PPV_ARGS(&pso)), "Create webapp pipeline");
    ID3D12PipelineState* raw = pso.Get();
    pipelines_[key] = pso;
    return raw;
}

void WebappWindow::renderFrame() {
    const UINT frame = swap_->GetCurrentBackBufferIndex();
    if (fence_->GetCompletedValue() < frameFence_[frame]) {
        fence_->SetEventOnCompletion(frameFence_[frame], fenceEvent_);
        WaitForSingleObject(fenceEvent_, INFINITE);
    }
    collectRetired();

    // Size the per-frame constant ring for this frame's passes and draws.
    UINT64 needed = 0;
    for (const auto& pass : passes_)
        needed += kFrameCBBytes + UINT64(pass[43]) * kDrawCBBytes;
    if (ringBytes_[frame] < needed || !ring_[frame]) {
        retire(ring_[frame]);
        ringBytes_[frame] = std::max<UINT64>(needed * 3 / 2, 1u << 20);
        ring_[frame] = uploadBuffer(nullptr, ringBytes_[frame]);
    }
    std::uint8_t* ring = nullptr;
    D3D12_RANGE none{0, 0};
    check(ring_[frame]->Map(0, &none, reinterpret_cast<void**>(&ring)), "Map constant ring");
    const D3D12_GPU_VIRTUAL_ADDRESS ringGpu = ring_[frame]->GetGPUVirtualAddress();
    UINT64 ringOffset = 0;

    check(allocators_[frame]->Reset(), "Reset allocator");
    check(cmd_->Reset(allocators_[frame].Get(), nullptr), "Reset command list");
    D3D12_RESOURCE_BARRIER barrier{};
    barrier.Type = D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;
    barrier.Transition.pResource = targets_[frame].Get();
    barrier.Transition.StateBefore = D3D12_RESOURCE_STATE_PRESENT;
    barrier.Transition.StateAfter = D3D12_RESOURCE_STATE_RENDER_TARGET;
    barrier.Transition.Subresource = D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES;
    cmd_->ResourceBarrier(1, &barrier);
    D3D12_CPU_DESCRIPTOR_HANDLE rtv = rtvHeap_->GetCPUDescriptorHandleForHeapStart();
    rtv.ptr += SIZE_T(frame) * rtvStep_;
    const D3D12_CPU_DESCRIPTOR_HANDLE dsv = dsvHeap_->GetCPUDescriptorHandleForHeapStart();
    cmd_->OMSetRenderTargets(1, &rtv, FALSE, &dsv);
    // A browser canvas starts every frame cleared (preserveDrawingBuffer=false).
    const float black[4] = {0, 0, 0, 1};
    cmd_->ClearRenderTargetView(rtv, black, 0, nullptr);
    cmd_->ClearDepthStencilView(dsv, D3D12_CLEAR_FLAG_DEPTH, 1.0f, 0, 0, nullptr);
    D3D12_VIEWPORT viewport{0, 0, float(width_), float(height_), 0, 1};
    D3D12_RECT scissor{0, 0, LONG(width_), LONG(height_)};
    cmd_->RSSetViewports(1, &viewport);
    cmd_->RSSetScissorRects(1, &scissor);
    cmd_->SetGraphicsRootSignature(root_sig_.Get());

    UINT drawsThisFrame = 0;
    for (const auto& pass : passes_) {
        const float* p = pass.data();
        const UINT lightCount = UINT(p[35]);
        const UINT drawCount = UINT(p[43]);
        const UINT flags = UINT(p[44]);
        if (flags & P_CLEAR_COLOR) {
            const float clear[4] = {p[36], p[37], p[38], p[39]};
            cmd_->ClearRenderTargetView(rtv, clear, 0, nullptr);
        }
        if (flags & P_CLEAR_DEPTH) cmd_->ClearDepthStencilView(dsv, D3D12_CLEAR_FLAG_DEPTH, 1.0f, 0, 0, nullptr);

        // cbuffer Frame: view, projection, camera+lightCount, ambient+exposure, lights.
        float* fcb = reinterpret_cast<float*>(ring + ringOffset);
        std::memset(fcb, 0, kFrameCBBytes);
        std::memcpy(fcb, p, 32 * sizeof(float));
        fcb[32] = p[32]; fcb[33] = p[33]; fcb[34] = p[34]; fcb[35] = float(lightCount);
        fcb[36] = p[40]; fcb[37] = p[41]; fcb[38] = p[42]; fcb[39] = p[47] > 0 ? p[47] : 1.0f;
        std::memcpy(fcb + 40, p + native_three::kWebappPassHeaderFloats,
                    lightCount * native_three::kWebappLightFloats * sizeof(float));
        cmd_->SetGraphicsRootConstantBufferView(0, ringGpu + ringOffset);
        ringOffset += kFrameCBBytes;

        const float* d = p + native_three::kWebappPassHeaderFloats + lightCount * native_three::kWebappLightFloats;
        ID3D12PipelineState* current = nullptr;
        D3D_PRIMITIVE_TOPOLOGY topology = D3D_PRIMITIVE_TOPOLOGY_UNDEFINED;
        for (UINT i = 0; i < drawCount; i++, d += native_three::kWebappDrawFloats) {
            auto g = geometries_.find(std::uint32_t(d[0]));
            if (g == geometries_.end() || !g->second.vertices) continue;
            const UINT drawFlags = UINT(d[3]);
            const UINT start = UINT(d[4]);
            const UINT count = UINT(d[5]);
            UINT instanceCount = std::max<UINT>(1, UINT(d[2]));
            D3D12_VERTEX_BUFFER_VIEW views[2] = {g->second.vbv, identityView_};
            if (d[1] > 0) {
                auto it = instances_.find(std::uint32_t(d[1]));
                if (it == instances_.end() || it->second.count == 0) continue;
                InstanceSet& set = it->second;
                instanceCount = std::min(instanceCount, set.count);
                if (set.uploaded[frame] != set.version || !set.gpu[frame]) {
                    if (set.capacity[frame] < set.count || !set.gpu[frame]) {
                        retire(set.gpu[frame]);
                        set.capacity[frame] = set.count;
                        set.gpu[frame] = uploadBuffer(nullptr, UINT64(set.count) * kInstanceStride);
                    }
                    void* mapped = nullptr;
                    check(set.gpu[frame]->Map(0, &none, &mapped), "Map instances");
                    std::memcpy(mapped, set.cpu.data(), set.cpu.size() * sizeof(float));
                    set.gpu[frame]->Unmap(0, nullptr);
                    set.uploaded[frame] = set.version;
                }
                views[1].BufferLocation = set.gpu[frame]->GetGPUVirtualAddress();
                views[1].SizeInBytes = set.count * kInstanceStride;
                views[1].StrideInBytes = kInstanceStride;
            }
            ID3D12PipelineState* pso = pipeline(drawFlags);
            if (pso != current) { cmd_->SetPipelineState(pso); current = pso; }
            const D3D_PRIMITIVE_TOPOLOGY wanted = (drawFlags & F_LINE_STRIP) ? D3D_PRIMITIVE_TOPOLOGY_LINESTRIP
                                                  : (drawFlags & F_LINES)    ? D3D_PRIMITIVE_TOPOLOGY_LINELIST
                                                                             : D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST;
            if (wanted != topology) { cmd_->IASetPrimitiveTopology(wanted); topology = wanted; }

            // cbuffer Draw: model, colour+opacity, emissive+shininess, params.
            float* dcb = reinterpret_cast<float*>(ring + ringOffset);
            std::memcpy(dcb, d + 16, 16 * sizeof(float));
            dcb[16] = d[8]; dcb[17] = d[9]; dcb[18] = d[10]; dcb[19] = d[11];
            dcb[20] = d[12]; dcb[21] = d[13]; dcb[22] = d[14]; dcb[23] = d[15];
            dcb[24] = d[6]; dcb[25] = d[7]; dcb[26] = float(drawFlags); dcb[27] = 0;
            cmd_->SetGraphicsRootConstantBufferView(1, ringGpu + ringOffset);
            ringOffset += kDrawCBBytes;

            cmd_->IASetVertexBuffers(0, 2, views);
            if (g->second.indexCount) {
                const UINT n = std::min(count, g->second.indexCount > start ? g->second.indexCount - start : 0u);
                if (!n) continue;
                cmd_->IASetIndexBuffer(&g->second.ibv);
                cmd_->DrawIndexedInstanced(n, instanceCount, start, 0, 0);
            } else {
                const UINT n = std::min(count, g->second.vertexCount > start ? g->second.vertexCount - start : 0u);
                if (!n) continue;
                cmd_->DrawInstanced(n, instanceCount, start, 0);
            }
            drawsThisFrame++;
        }
    }
    ring_[frame]->Unmap(0, nullptr);
    lastDraws_ = drawsThisFrame;

    std::swap(barrier.Transition.StateBefore, barrier.Transition.StateAfter);
    cmd_->ResourceBarrier(1, &barrier);
    check(cmd_->Close(), "Close command list");
    ID3D12CommandList* lists[] = {cmd_.Get()};
    queue_->ExecuteCommandLists(1, lists);
    const HRESULT present = swap_->Present(1, 0);
    if (present == DXGI_ERROR_DEVICE_REMOVED || present == DXGI_ERROR_DEVICE_RESET) check(present, "Present (GPU device lost)");
    frameFence_[frame] = ++fenceValue_;
    queue_->Signal(fence_.Get(), frameFence_[frame]);
}

void WebappWindow::updateTitle(double fps) {
    wchar_t text[512];
    swprintf_s(text, L"%s — NativeThreeBridge webapp | %.0f FPS | %u draws | %s%s",
               pageTitle_.c_str(), fps, lastDraws_, adapterName_.c_str(),
               logErrors_ ? L" | JS errors: see NativeThreeBridge-webapp-log.txt" : L"");
    SetWindowTextW(window_, text);
}

// Win32 virtual key -> DOM KeyboardEvent.key / .code
void WebappWindow::keyEvent(bool down, WPARAM vk, LPARAM lp) {
    const bool shift = GetKeyState(VK_SHIFT) < 0, ctrl = GetKeyState(VK_CONTROL) < 0,
               alt = GetKeyState(VK_MENU) < 0;
    const bool repeat = down && (lp & (1 << 30));
    const bool extended = (lp & (1 << 24)) != 0;
    std::string key, code;
    if (vk >= 'A' && vk <= 'Z') {
        code = std::string("Key") + char(vk);
        key = std::string(1, char(shift != (GetKeyState(VK_CAPITAL) & 1) ? vk : vk + 32));
    } else if (vk >= '0' && vk <= '9') {
        code = std::string("Digit") + char(vk);
        static const char* shifted = ")!@#$%^&*(";
        key = shift ? std::string(1, shifted[vk - '0']) : std::string(1, char(vk));
    } else if (vk >= VK_NUMPAD0 && vk <= VK_NUMPAD9) {
        code = "Numpad" + std::to_string(vk - VK_NUMPAD0);
        key = std::to_string(vk - VK_NUMPAD0);
    } else if (vk >= VK_F1 && vk <= VK_F24) {
        key = code = "F" + std::to_string(vk - VK_F1 + 1);
    } else {
        struct Named { WPARAM vk; const char* key; const char* code; };
        static const Named named[] = {
            {VK_SPACE, " ", "Space"}, {VK_RETURN, "Enter", "Enter"}, {VK_ESCAPE, "Escape", "Escape"},
            {VK_TAB, "Tab", "Tab"}, {VK_BACK, "Backspace", "Backspace"}, {VK_DELETE, "Delete", "Delete"},
            {VK_LEFT, "ArrowLeft", "ArrowLeft"}, {VK_RIGHT, "ArrowRight", "ArrowRight"},
            {VK_UP, "ArrowUp", "ArrowUp"}, {VK_DOWN, "ArrowDown", "ArrowDown"},
            {VK_HOME, "Home", "Home"}, {VK_END, "End", "End"}, {VK_PRIOR, "PageUp", "PageUp"},
            {VK_NEXT, "PageDown", "PageDown"}, {VK_INSERT, "Insert", "Insert"},
            {VK_CAPITAL, "CapsLock", "CapsLock"}, {VK_OEM_MINUS, "-", "Minus"}, {VK_OEM_PLUS, "=", "Equal"},
            {VK_OEM_COMMA, ",", "Comma"}, {VK_OEM_PERIOD, ".", "Period"}, {VK_OEM_2, "/", "Slash"},
            {VK_OEM_1, ";", "Semicolon"}, {VK_OEM_7, "'", "Quote"}, {VK_OEM_4, "[", "BracketLeft"},
            {VK_OEM_6, "]", "BracketRight"}, {VK_OEM_5, "\\", "Backslash"}, {VK_OEM_3, "`", "Backquote"},
            {VK_ADD, "+", "NumpadAdd"}, {VK_SUBTRACT, "-", "NumpadSubtract"},
            {VK_MULTIPLY, "*", "NumpadMultiply"}, {VK_DIVIDE, "/", "NumpadDivide"},
        };
        for (const Named& n : named)
            if (n.vk == vk) { key = n.key; code = n.code; break; }
        if (vk == VK_SHIFT) {
            key = "Shift";
            code = MapVirtualKeyW((lp >> 16) & 0xff, MAPVK_VSC_TO_VK_EX) == VK_RSHIFT ? "ShiftRight" : "ShiftLeft";
        } else if (vk == VK_CONTROL) { key = "Control"; code = extended ? "ControlRight" : "ControlLeft"; }
        else if (vk == VK_MENU) { key = "Alt"; code = extended ? "AltRight" : "AltLeft"; }
    }
    if (key.empty()) return;
    host_.key(down, key, code, repeat, alt, ctrl, shift, false);
}

LRESULT WebappWindow::handle(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    switch (msg) {
    case WM_SIZE:
        minimized_ = wp == SIZE_MINIMIZED;
        if (!minimized_) resize(LOWORD(lp), HIWORD(lp));
        return 0;
    case WM_KEYDOWN: case WM_SYSKEYDOWN:
        if (wp == VK_F4 && GetKeyState(VK_MENU) < 0) break; // Alt+F4 closes
        keyEvent(true, wp, lp);
        return 0;
    case WM_KEYUP: case WM_SYSKEYUP:
        keyEvent(false, wp, lp);
        return 0;
    case WM_LBUTTONDOWN: case WM_RBUTTONDOWN: case WM_MBUTTONDOWN:
        SetCapture(hwnd);
        host_.pointer("down", GET_X_LPARAM(lp), GET_Y_LPARAM(lp), msg == WM_LBUTTONDOWN ? 0 : msg == WM_MBUTTONDOWN ? 1 : 2);
        return 0;
    case WM_LBUTTONUP: case WM_RBUTTONUP: case WM_MBUTTONUP:
        host_.pointer("up", GET_X_LPARAM(lp), GET_Y_LPARAM(lp), msg == WM_LBUTTONUP ? 0 : msg == WM_MBUTTONUP ? 1 : 2);
        if (!(wp & (MK_LBUTTON | MK_RBUTTON | MK_MBUTTON))) ReleaseCapture();
        return 0;
    case WM_MOUSEMOVE:
        host_.pointer("move", GET_X_LPARAM(lp), GET_Y_LPARAM(lp), 0);
        return 0;
    case WM_MOUSEWHEEL: case WM_MOUSEHWHEEL: {
        POINT pt{GET_X_LPARAM(lp), GET_Y_LPARAM(lp)};
        ScreenToClient(hwnd, &pt);
        const double delta = -double(GET_WHEEL_DELTA_WPARAM(wp)) / WHEEL_DELTA * 100.0;
        if (msg == WM_MOUSEWHEEL) host_.wheel(pt.x, pt.y, 0, delta);
        else host_.wheel(pt.x, pt.y, -delta, 0);
        return 0;
    }
    case WM_CONTEXTMENU:
        return 0;
    case WM_SETFOCUS: host_.focus(true); return 0;
    case WM_KILLFOCUS: host_.focus(false); return 0;
    case WM_DESTROY:
        PostQuitMessage(0);
        return 0;
    }
    return DefWindowProcW(hwnd, msg, wp, lp);
}

int WebappWindow::run(HINSTANCE instance) {
    wchar_t exePath[MAX_PATH] = {};
    GetModuleFileNameW(nullptr, exePath, MAX_PATH);
    const std::filesystem::path logPath = std::filesystem::path(exePath).parent_path() / L"NativeThreeBridge-webapp-log.txt";
    _wfopen_s(&log_, logPath.c_str(), L"wb");
    log("info", "Opening webapp: " + root_.u8string());

    std::string shim, error;
    std::vector<native_three::WebappBuiltin> builtins;
    if (!NativeWebapp_LoadBuiltins(shim, builtins, error)) {
        log("error", error);
        MessageBoxA(nullptr, error.c_str(), "NativeThreeBridge webapp", MB_OK | MB_ICONERROR);
        return 43;
    }
    if (!std::filesystem::exists(root_ / L"index.html")) {
        const std::string text = "No index.html in " + root_.u8string();
        log("error", text);
        MessageBoxA(nullptr, text.c_str(), "NativeThreeBridge webapp", MB_OK | MB_ICONWARNING);
        return 43;
    }

    WNDCLASSW wc{};
    wc.lpfnWndProc = webappWndProc;
    wc.hInstance = instance;
    wc.lpszClassName = L"NativeThreeWebappWindow";
    wc.hCursor = LoadCursor(nullptr, IDC_ARROW);
    wc.hIcon = LoadIcon(nullptr, IDI_APPLICATION);
    RegisterClassW(&wc);
    RECT rc{0, 0, LONG(width_), LONG(height_)};
    AdjustWindowRect(&rc, WS_OVERLAPPEDWINDOW, FALSE);
    gActive = this;
    window_ = CreateWindowW(wc.lpszClassName, L"NativeThreeBridge webapp", WS_OVERLAPPEDWINDOW,
                            CW_USEDEFAULT, CW_USEDEFAULT, rc.right - rc.left, rc.bottom - rc.top,
                            nullptr, nullptr, instance, nullptr);
    if (!window_) return 1;
    RECT client{};
    GetClientRect(window_, &client);
    width_ = std::max<LONG>(1, client.right);
    height_ = std::max<LONG>(1, client.bottom);
    initDevice();

    if (!host_.start(root_, shim, std::move(builtins), this, int(width_), int(height_), error)) {
        log("error", error);
        MessageBoxA(window_, error.c_str(), "NativeThreeBridge webapp", MB_OK | MB_ICONERROR);
        return 45;
    }
    ShowWindow(window_, SW_SHOW);
    SetForegroundWindow(window_);

    const auto start = std::chrono::steady_clock::now();
    auto statStart = start;
    int statFrames = 0, frameNumber = 0;
    MSG msg{};
    for (;;) {
        while (PeekMessageW(&msg, nullptr, 0, 0, PM_REMOVE)) {
            if (msg.message == WM_QUIT) {
                waitForGpu();
                host_.shutdown();
                gActive = nullptr;
                if (log_) std::fclose(log_);
                return int(msg.wParam);
            }
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        if (minimized_) { Sleep(16); continue; } // like a hidden browser tab: no rAF
        const auto now = std::chrono::steady_clock::now();
        const double ms = std::chrono::duration<double, std::milli>(now - start).count();
        pendingPasses_.clear();
        host_.frame(ms);
        if (!pendingPasses_.empty()) passes_.swap(pendingPasses_); // otherwise keep the last image
        renderFrame();
        frameNumber++;
        statFrames++;
        const double elapsed = std::chrono::duration<double>(now - statStart).count();
        if (elapsed >= 0.5) {
            updateTitle(statFrames / elapsed);
            statFrames = 0;
            statStart = now;
        }
        if (frameNumber == 30 && !bootDialogShown_) {
            const std::string status = host_.statusJson();
            if (status.find("\"bootError\":null") == std::string::npos) {
                bootDialogShown_ = true;
                log("error", "Webapp failed to start: " + status);
                if (GetEnvironmentVariableA("CI", nullptr, 0) == 0)
                    MessageBoxW(window_, L"The webapp's JavaScript failed to start.\n"
                                         L"Details: NativeThreeBridge-webapp-log.txt beside the EXE.",
                                L"NativeThreeBridge webapp", MB_OK | MB_ICONWARNING);
            }
        }
    }
}

} // namespace

bool NativeWebapp_FindRoot(const wchar_t* commandLine, const std::filesystem::path& exeDir,
                           std::filesystem::path& root) {
    int argc = 0;
    LPWSTR* argv = CommandLineToArgvW(commandLine && *commandLine ? commandLine : L"", &argc);
    std::vector<std::wstring> args;
    // CommandLineToArgvW("") returns the EXE path; wWinMain's lpCmdLine excludes it.
    if (argv && commandLine && *commandLine)
        for (int i = 0; i < argc; i++) args.emplace_back(argv[i]);
    if (argv) LocalFree(argv);
    std::error_code ec;
    for (size_t i = 0; i < args.size(); i++) {
        std::filesystem::path candidate;
        if (args[i] == L"--webapp" && i + 1 < args.size()) candidate = args[++i];
        else if (args.size() == 1) candidate = args[i]; // folder or index.html dropped on the EXE
        else continue;
        if (candidate.filename() == L"index.html") candidate = candidate.parent_path();
        if (candidate.is_relative()) candidate = std::filesystem::current_path(ec) / candidate;
        if (std::filesystem::exists(candidate / L"index.html", ec)) {
            root = std::filesystem::weakly_canonical(candidate, ec);
            if (ec) root = candidate;
            return true;
        }
    }
    if (std::filesystem::exists(exeDir / L"game" / L"index.html", ec)) {
        root = exeDir / L"game";
        return true;
    }
    return false;
}

int NativeWebapp_Run(HINSTANCE instance, const std::filesystem::path& webappRoot) {
    auto window = std::make_unique<WebappWindow>(webappRoot);
    return window->run(instance);
}
