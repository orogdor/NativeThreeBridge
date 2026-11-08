#pragma once
// Experimental V8 backend, hosted by a bundled Node.js/V8 subprocess.
// Uses exactly the same WebappRenderSink as QuickJS -> unchanged DX12 renderer.
// No Chromium, no modifications to game JavaScript.
#include "webapp_host.h"
#include <windows.h>
#include <filesystem>
#include <string>
#include <vector>
#include <cstdint>

namespace native_three {
class V8WebappHost {
public:
    V8WebappHost() = default;
    ~V8WebappHost() { shutdown(); }
    V8WebappHost(const V8WebappHost&)=delete;
    V8WebappHost& operator=(const V8WebappHost&)=delete;
    bool start(const std::filesystem::path& gameRoot, const std::string&,
               std::vector<WebappBuiltin>, WebappRenderSink* sink,
               int width,int height,std::string& error);
    void shutdown();
    bool running() const { return started_ && process_ != nullptr; }
    void resize(int width,int height,double pixelRatio=1.0);
    void frame(double timeMs);
    void key(bool down,const std::string& key,const std::string& code,bool repeat,
             bool alt,bool ctrl,bool shift,bool meta);
    void pointer(const char* kind,double x,double y,int button);
    void wheel(double x,double y,double deltaX,double deltaY);
    void focus(bool focused);
    std::string statusJson() const { return status_; }
private:
    bool spawn(const std::filesystem::path& gameRoot,std::string& error);
    bool exchange(const std::string& json);
    bool writeAll(const void* src,size_t bytes);
    bool readExact(void* dst,size_t bytes);
    bool receiveEvent(unsigned char op,const std::vector<std::uint8_t>& payload);
    void fail(const std::string& reason);
    WebappRenderSink* sink_=nullptr;
    HANDLE process_=nullptr,thread_=nullptr,toChild_=nullptr,fromChild_=nullptr;
    bool started_=false,failed_=false;
    std::string status_=R"({"booted":false,"bootError":"starting V8"})";
    std::string lastError_;
};
} // namespace native_three
