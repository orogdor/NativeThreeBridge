// Run the real bundled Three.js scene in QuickJS, without requiring a GPU.
#include <windows.h>
#include <cmath>
#include <cstdio>
#include <string>
#include "app_host.h"
int main() {
  wchar_t module[MAX_PATH]{};
  DWORD n=GetModuleFileNameW(nullptr,module,MAX_PATH);
  if(!n||n>=MAX_PATH)return 1;
  std::wstring dir(module,n);
  dir.resize(dir.find_last_of(L"\\/"));
  std::string error;
  if(!WebApp_Init(dir+L"\\webapp\\index.html",error)) {
    std::fprintf(stderr,"WebApp init FAIL: %s\n",error.c_str());return 2;
  }
  WebAppFrame a{},b{};
  if(!WebApp_Tick(0,a,error) || !WebApp_Tick(1000,b,error)) {
    std::fprintf(stderr,"WebApp animation FAIL: %s\n",error.c_str());
    WebApp_Shutdown();return 3;
  }
  if(std::fabs(a.model[0]-b.model[0])<0.1f ||
     !(b.rgb[0]>0 && b.rgb[1]>0 && b.rgb[2]>0) ||
     std::fabs(b.model[15]-1.f)>0.001f) {
    std::fprintf(stderr,"Cube did not rotate or exported incorrect transform/color\n");
    WebApp_Shutdown();return 4;
  }
  std::puts("PASS: index.html resolves app.js");
  std::puts("PASS: official Three.js executes inside QuickJS");
  std::puts("PASS: standard THREE.BoxGeometry spins between frame 0 and 1000ms");
  std::puts("PASS: scene matrix and material exported for native DX12");
  WebApp_Shutdown();
  return 0;
}
