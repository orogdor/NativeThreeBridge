// Compile all embedded HLSL entry points without requiring a real GPU.
// Uses the same string embedded in NativeThree-DX12.cpp at runtime.
#include <windows.h>
#include <d3dcompiler.h>
#include <cstdio>
#include <fstream>
#include <iterator>
#include <string>
#include <wrl/client.h>
using Microsoft::WRL::ComPtr;

int main(int argc,char **argv) {
    if(argc!=2) { std::fprintf(stderr,"Usage: shader_smoke <NativeThree-DX12.cpp>\n");return 2; }
    std::ifstream input(argv[1],std::ios::binary);
    if(!input) return 3;
    const std::string source((std::istreambuf_iterator<char>(input)),std::istreambuf_iterator<char>());
    const std::string marker="static const char *SHADER=R\"(";
    const size_t start=source.find(marker);
    if(start==std::string::npos) return 4;
    const size_t bodyStart=start+marker.size();
    const size_t end=source.find(")\";",bodyStart);
    if(end==std::string::npos) return 5;
    const std::string shader=source.substr(bodyStart,end-bodyStart);
    const struct {const char *entry,*model;} shaders[]={
        {"VSMain","vs_5_0"},
        {"PSMain","ps_5_0"},
        {"PSShadow","ps_5_0"}
    };
    for(const auto &s:shaders){
        ComPtr<ID3DBlob> bytecode,error;
        const HRESULT hr=D3DCompile(shader.data(),shader.size(),"NativeThree-DX12",
            nullptr,nullptr,s.entry,s.model,D3DCOMPILE_ENABLE_STRICTNESS|
            D3DCOMPILE_OPTIMIZATION_LEVEL3,0,&bytecode,&error);
        if(FAILED(hr)){
            std::fprintf(stderr,"FAILED %s:\n%s\n",s.entry,
                error?static_cast<const char*>(error->GetBufferPointer()):"unknown compiler error");
            return 6;
        }
        std::printf("PASS: %s %s (%zu compiled bytes)\n",s.entry,s.model,
            static_cast<size_t>(bytecode->GetBufferSize()));
    }
    return 0;
}
