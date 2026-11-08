// NativeThreeBridge experimental V8/Node IPC bridge.
// Native DX12 render code and shaders are NOT changed. V8 executes the
// unchanged game/index.html and JS in a separate locally bundled node.exe.
// The binary protocol carries the same NativeRenderer upload/pass arrays.
#include "v8_webapp_host.h"
#include <algorithm>
#include <cstring>
#include <sstream>
#include <vector>
#include <cstdio>

namespace native_three {
namespace {
enum : unsigned char { OP_LOG=1,OP_TITLE=2,OP_GEO=3,OP_FREE_GEO=4,
                       OP_INST=5,OP_FREE_INST=6,OP_PASS=7,OP_DONE=8,OP_ERROR=9 };
std::string quoteJson(const std::string& src) {
    std::string out="\"";
    for(unsigned char c:src){
        if(c=='\"'||c=='\\'){out+='\\';out+=char(c);}
        else if(c=='\n')out+="\\n";
        else if(c=='\r')out+="\\r";
        else if(c=='\t')out+="\\t";
        else if(c<0x20){char x[8];std::snprintf(x,sizeof x,"\\u%04x",(unsigned)c);out+=x;}
        else out+=char(c);
    }
    out+='\"'; return out;
}
std::string flag(bool v) {return v?"true":"false";}
std::uint32_t le32(const std::vector<std::uint8_t>& b,size_t offset) {
    if(offset+4>b.size())return 0;
    std::uint32_t x;std::memcpy(&x,b.data()+offset,4);return x;
}
bool copyFloats(const std::vector<std::uint8_t>& b,size_t& off,
                std::vector<float>& out,size_t count) {
    if(count > 15000000 || count > (b.size()-std::min(off,b.size()))/4)return false;
    out.resize(count);
    if(count)std::memcpy(out.data(),b.data()+off,count*4);
    off+=count*4;return true;
}
} // namespace

void V8WebappHost::fail(const std::string& reason) {
    lastError_=reason;started_=false;failed_=true;
    status_=R"({"booted":false,"bootError":)"+quoteJson(reason)+"}";
    if(sink_)sink_->log("error","V8: "+reason);
}
bool V8WebappHost::writeAll(const void* src,size_t bytes) {
    if(toChild_==nullptr)return false;
    const auto* p=static_cast<const std::uint8_t*>(src);
    while(bytes){
        DWORD written=0;
        if(!WriteFile(toChild_,p,DWORD(std::min<size_t>(bytes,0x7fffffffu)),&written,nullptr)||!written)
            return false;
        p+=written;bytes-=written;
    }
    return true;
}
bool V8WebappHost::readExact(void* dst,size_t bytes) {
    if(fromChild_==nullptr)return false;
    auto* p=static_cast<std::uint8_t*>(dst);
    const ULONGLONG started=GetTickCount64();
    // A large game can take time to initialize, but must not hang forever.
    constexpr ULONGLONG maxWaitMs=180000;
    while(bytes && !failed_){
        DWORD available=0;
        if(!PeekNamedPipe(fromChild_,nullptr,0,nullptr,&available,nullptr)){
            fail("V8 process output pipe closed");return false;
        }
        if(!available){
            if(process_ && WaitForSingleObject(process_,0)==WAIT_OBJECT_0){
                DWORD exitCode=0;GetExitCodeProcess(process_,&exitCode);
                fail("V8 process exited unexpectedly ("+std::to_string(exitCode)+")");return false;
            }
            if(GetTickCount64()-started>maxWaitMs){
                fail("V8 process has not responded for 180 s (check JavaScript startup loop)");
                return false;
            }
            Sleep(2);continue;
        }
        DWORD read=0;
        if(!ReadFile(fromChild_,p,DWORD(std::min<size_t>(bytes,available)),&read,nullptr)||!read){
            fail("Failed reading V8 worker message");return false;
        }
        p+=read;bytes-=read;
    }
    return bytes==0;
}
bool V8WebappHost::receiveEvent(unsigned char op,const std::vector<std::uint8_t>& b) {
    if(!sink_)return false;
    switch(op) {
      case OP_LOG:{
          const std::string raw(b.begin(),b.end());
          const auto sep=raw.find('\n');
          sink_->log(sep==std::string::npos?"info":raw.substr(0,sep),
                     sep==std::string::npos?raw:raw.substr(sep+1));
          return true;
      }
      case OP_TITLE:sink_->setTitle(std::string(b.begin(),b.end()));return true;
      case OP_GEO:{
          if(b.size()<16){fail("Truncated V8 geometry header");return false;}
          const std::uint32_t id=le32(b,0),count=le32(b,4),indices=le32(b,8),flags=le32(b,12);
          size_t offset=16;
          std::vector<float> p,n,c;
          std::vector<std::uint32_t> ix;
          if(!copyFloats(b,offset,p,size_t(count)*3) ||
             ((flags&1)&&!copyFloats(b,offset,n,size_t(count)*3)) ||
             ((flags&2)&&!copyFloats(b,offset,c,size_t(count)*3)) ||
             indices>30000000 || (size_t(indices)*4>b.size()-std::min(offset,b.size()))){
             fail("Malformed V8 geometry packet");return false;
          }
          ix.resize(indices);
          if(indices)std::memcpy(ix.data(),b.data()+offset,size_t(indices)*4);
          sink_->uploadGeometry(id,p.data(),(flags&1)?n.data():nullptr,
                                (flags&2)?c.data():nullptr,count,ix.data(),indices);
          return true;
      }
      case OP_FREE_GEO:
          if(b.size()!=4){fail("Invalid V8 releaseGeometry packet");return false;}
          sink_->releaseGeometry(le32(b,0));return true;
      case OP_INST:{
          if(b.size()<12){fail("Truncated V8 instance header");return false;}
          const auto id=le32(b,0),count=le32(b,4),flags=le32(b,8);
          size_t off=12;
          std::vector<float> matrices,colours;
          if(!copyFloats(b,off,matrices,size_t(count)*16)||
             ((flags&1)&&!copyFloats(b,off,colours,size_t(count)*3))){
              fail("Malformed V8 instance buffer");return false;
          }
          sink_->uploadInstances(id,matrices.data(),(flags&1)?colours.data():nullptr,count);
          return true;
      }
      case OP_FREE_INST:
          if(b.size()!=4){fail("Invalid V8 releaseInstances packet");return false;}
          sink_->releaseInstances(le32(b,0));return true;
      case OP_PASS:{
          if(b.size()<4){fail("Truncated V8 render pass");return false;}
          const auto floats=le32(b,0);
          if(floats<kWebappPassHeaderFloats||floats>10000000||size_t(floats)*4!=b.size()-4){
              fail("Invalid V8 render pass size");return false;
          }
          std::vector<float> pass(floats);
          std::memcpy(pass.data(),b.data()+4,size_t(floats)*4);
          sink_->submitPass(pass.data(),floats);
          return true;
      }
      case OP_ERROR:fail(std::string(b.begin(),b.end()));return false;
      default:fail("Unexpected V8 IPC opcode "+std::to_string(op));return false;
    }
}
bool V8WebappHost::exchange(const std::string& json) {
    if(failed_)return false;
    if(!json.empty() && (!writeAll(json.data(),json.size())||!writeAll("\n",1))){
        fail("Cannot send commands to V8 process");return false;
    }
    while(!failed_){
        std::uint32_t length=0;
        if(!readExact(&length,4))return false;
        if(length<1 || length>256u*1024u*1024u){
            fail("Invalid V8 IPC message length "+std::to_string(length));return false;
        }
        unsigned char opcode=0;
        if(!readExact(&opcode,1))return false;
        std::vector<std::uint8_t> payload(length-1);
        if(!payload.empty() && !readExact(payload.data(),payload.size()))return false;
        if(opcode==OP_DONE){
            status_=std::string(payload.begin(),payload.end());
            return true;
        }
        if(!receiveEvent(opcode,payload))return false;
    }
    return false;
}
bool V8WebappHost::spawn(const std::filesystem::path& root,std::string& error){
    wchar_t exePath[MAX_PATH]{};
    const DWORD n=GetModuleFileNameW(nullptr,exePath,MAX_PATH);
    if(!n||n>=MAX_PATH){error="Cannot find native EXE path";return false;}
    const auto exeDir=std::filesystem::path(exePath).parent_path();
    const auto node=exeDir/L"v8-runtime"/L"node.exe";
    const auto worker=exeDir/L"v8-runtime"/L"worker.mjs";
    if(!std::filesystem::exists(node)||!std::filesystem::exists(worker)){
        error="Missing v8-runtime/node.exe or worker.mjs beside the native EXE. "
              "Extract all files from the V8 ZIP.";return false;
    }
    SECURITY_ATTRIBUTES security{};security.nLength=sizeof(security);
    security.bInheritHandle=TRUE;
    HANDLE outRead=nullptr,outWrite=nullptr,inRead=nullptr,inWrite=nullptr;
    if(!CreatePipe(&outRead,&outWrite,&security,0)||
       !CreatePipe(&inRead,&inWrite,&security,0)){
        if(outRead)CloseHandle(outRead);if(outWrite)CloseHandle(outWrite);
        if(inRead)CloseHandle(inRead);if(inWrite)CloseHandle(inWrite);
        error="Cannot create V8 stdin/stdout pipes";return false;
    }
    SetHandleInformation(outRead,HANDLE_FLAG_INHERIT,0);
    SetHandleInformation(inWrite,HANDLE_FLAG_INHERIT,0);
    HANDLE nul=CreateFileW(L"NUL",GENERIC_WRITE,FILE_SHARE_READ|FILE_SHARE_WRITE,
                           &security,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,nullptr);
    STARTUPINFOW si{};si.cb=sizeof(si);si.dwFlags=STARTF_USESTDHANDLES;
    si.hStdOutput=outWrite;si.hStdInput=inRead;si.hStdError=nul!=INVALID_HANDLE_VALUE?nul:outWrite;
    PROCESS_INFORMATION pi{};
    std::wstring cmd=L"\""+node.wstring()+L"\" --no-warnings --experimental-vm-modules \""+
                     worker.wstring()+L"\" \""+root.wstring()+L"\"";
    const BOOL ok=CreateProcessW(node.c_str(),cmd.data(),nullptr,nullptr,TRUE,
                                  CREATE_NO_WINDOW,nullptr,exeDir.c_str(),&si,&pi);
    CloseHandle(inRead);CloseHandle(outWrite);
    if(nul!=INVALID_HANDLE_VALUE)CloseHandle(nul);
    if(!ok){
        CloseHandle(outRead);CloseHandle(inWrite);
        error="Could not launch bundled Node V8 process (Win32 "+std::to_string(GetLastError())+")";
        return false;
    }
    process_=pi.hProcess;thread_=pi.hThread;
    fromChild_=outRead;toChild_=inWrite;
    return true;
}
bool V8WebappHost::start(const std::filesystem::path& root,const std::string&,
                        std::vector<WebappBuiltin>,WebappRenderSink* sink,
                        int width,int height,std::string& error){
    shutdown();
    sink_=sink;failed_=false;lastError_.clear();
    if(!spawn(root,error)){fail(error);return false;}
    if(!exchange("")||status_!="ready"){
        error=lastError_.empty()?"V8 worker did not report ready":lastError_;
        shutdown();return false;
    }
    started_=true;
    if(sink_)sink_->log("info","V8 backend ready: native DX12 uses the original WebappRenderSink");
    const std::string command="{\"type\":\"boot\",\"width\":"+std::to_string(width)+
                               ",\"height\":"+std::to_string(height)+"}";
    if(!exchange(command)){
        error=lastError_.empty()?"V8 worker did not complete HTML boot":lastError_;
        shutdown();return false;
    }
    return true;
}
void V8WebappHost::shutdown(){
    if(toChild_){
        writeAll("{\"type\":\"exit\"}\n",16);
        CloseHandle(toChild_);toChild_=nullptr;
    }
    if(process_){
        if(WaitForSingleObject(process_,500)!=WAIT_OBJECT_0)TerminateProcess(process_,10);
        CloseHandle(process_);process_=nullptr;
    }
    if(thread_){CloseHandle(thread_);thread_=nullptr;}
    if(fromChild_){CloseHandle(fromChild_);fromChild_=nullptr;}
    started_=false;
}
void V8WebappHost::resize(int w,int h,double pr){
    if(running())exchange("{\"type\":\"resize\",\"width\":"+std::to_string(w)+
                          ",\"height\":"+std::to_string(h)+",\"pixelRatio\":"+std::to_string(pr)+"}");
}
void V8WebappHost::frame(double time){
    if(running())exchange("{\"type\":\"frame\",\"time\":"+std::to_string(time)+"}");
}
void V8WebappHost::key(bool down,const std::string& key,const std::string& code,bool repeat,
                       bool alt,bool ctrl,bool shift,bool meta){
    if(!running())return;
    exchange("{\"type\":\"key\",\"down\":"+flag(down)+",\"key\":"+quoteJson(key)+
             ",\"code\":"+quoteJson(code)+",\"repeat\":"+flag(repeat)+
             ",\"alt\":"+flag(alt)+",\"ctrl\":"+flag(ctrl)+
             ",\"shift\":"+flag(shift)+",\"meta\":"+flag(meta)+"}");
}
void V8WebappHost::pointer(const char* kind,double x,double y,int button){
    if(running())exchange("{\"type\":\"pointer\",\"kind\":"+quoteJson(kind)+
                          ",\"x\":"+std::to_string(x)+",\"y\":"+std::to_string(y)+
                          ",\"button\":"+std::to_string(button)+"}");
}
void V8WebappHost::wheel(double x,double y,double dx,double dy){
    if(running())exchange("{\"type\":\"wheel\",\"x\":"+std::to_string(x)+",\"y\":"+std::to_string(y)+
                          ",\"deltaX\":"+std::to_string(dx)+",\"deltaY\":"+std::to_string(dy)+"}");
}
void V8WebappHost::focus(bool focused){
    if(running())exchange("{\"type\":\"focus\",\"focused\":"+flag(focused)+"}");
}
} // namespace native_three
