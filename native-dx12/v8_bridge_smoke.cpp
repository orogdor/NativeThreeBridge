// NativeThreeBridge V8 IPC headless regression; no GPU needed.
#include "v8_webapp_host.h"
#include <cstdio>
#include <algorithm>
#include <filesystem>
#include <string>
#include <vector>
#include <cstdint>
#include <windows.h>

using native_three::WebappRenderSink;
class Sink final : public WebappRenderSink {
public:
    int uploads=0,instances=0,passes=0,errors=0,draws=0;
    void uploadGeometry(std::uint32_t,const float* p,const float*,const float*,
                        std::uint32_t count,const std::uint32_t*,std::uint32_t) override {
        if(!p||!count)errors++;
        uploads++;
    }
    void releaseGeometry(std::uint32_t) override {}
    void uploadInstances(std::uint32_t,const float* m,const float*,std::uint32_t count) override {
        if(!m||!count)errors++;instances++;
    }
    void releaseInstances(std::uint32_t) override {}
    void submitPass(const float* p,std::size_t floats) override {
        if(!p||floats<64){errors++;return;}
        passes++;draws=std::max(draws,(int)p[43]);
    }
    void setTitle(const std::string& t) override {std::printf("[title] %s\n",t.c_str());}
    void log(const std::string& level,const std::string& msg) override {
        if(level=="error")errors++;
        if(level=="error"||level=="warn"||msg.find("ready")!=std::string::npos)
            std::printf("[%s] %s\n",level.c_str(),msg.c_str());
    }
};

int wmain(int argc,wchar_t** argv) {
    setvbuf(stdout,nullptr,_IONBF,0);
    if(argc<2){std::puts("Usage: WebappV8Smoke.exe <webapp-folder> [min-draws]");return 2;}
    const int minDraws=argc>2?_wtoi(argv[2]):3;
    native_three::V8WebappHost host;
    Sink sink;
    std::string error;
    std::puts("Starting bundled Node V8 runtime (no Chromium)...");
    if(!host.start(std::filesystem::path(argv[1]),"",{},&sink,1280,720,error)) {
        std::printf("FAILED V8 bootstrap: %s\n",error.c_str());return 3;
    }
    for(int i=0;i<90 && host.running();i++) {
        host.frame(i*1000.0/60);
        if(i==20)host.resize(960,540,1.0);
        if(i==30)host.pointer("move",400,300,0);
        Sleep(1);
    }
    const std::string status=host.statusJson();
    std::printf("V8 status: %s\n",status.c_str());
    std::printf("V8 draws: %d; geometry uploads: %d; instance sets: %d; passes: %d; errors: %d\n",
                sink.draws,sink.uploads,sink.instances,sink.passes,sink.errors);
    const bool ok=host.running()&&sink.errors==0&&sink.passes>=60&&
                  sink.draws>=minDraws&&sink.uploads>0&&
                  status.find("\"booted\":true")!=std::string::npos&&
                  status.find("\"bootError\":null")!=std::string::npos;
    host.shutdown();
    std::puts(ok?"V8 DX12-BRIDGE SMOKE PASSED":"V8 DX12-BRIDGE SMOKE FAILED");
    return ok?0:4;
}
