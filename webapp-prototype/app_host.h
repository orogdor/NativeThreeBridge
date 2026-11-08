#pragma once
#include <string>
struct WebAppFrame {
  float model[16]{};
  float rgb[3]{};
};
bool WebApp_Init(const std::wstring& htmlPath, std::string& error);
bool WebApp_Tick(double timeMs, WebAppFrame& out, std::string& error);
void WebApp_Shutdown();
