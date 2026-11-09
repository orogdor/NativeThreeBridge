#pragma once
// Tiny, platform-neutral CSS + button-markup translator for NativeThreeBridge.
// Deliberately not a browser or full CSS engine. Unknown properties are ignored.
// Converts one <button id="..."> element + #id { ... } into a Win32-ready style.
#include <algorithm>
#include <cctype>
#include <cstdlib>
#include <string>
#include "native_css_layer.h"

namespace native_three {
struct NativeButtonStyle {
    std::string id="restart-button", text="Restart";
    int right=18, top=18, width=156, height=44;
    int radius=11, fontSize=16, borderWidth=1;
    bool bold=true;
    unsigned background=0x18374b,foreground=0xf4fbff,border=0x79d5e8;
};

inline std::string trimCss(const std::string& v) {
    const auto a=v.find_first_not_of(" \t\n\r");
    if(a==std::string::npos)return "";
    const auto b=v.find_last_not_of(" \t\n\r");
    return v.substr(a,b-a+1);
}
inline std::string lowerCss(std::string v) {
    for(char& c:v)c=(char)std::tolower((unsigned char)c);
    return v;
}
inline bool cssPixels(const std::string& value,int& out) {
    const auto s=trimCss(value);
    if(s.empty() || s[0]=='-' || s[0]=='+')return false;
    char* end=nullptr;
    const long n=std::strtol(s.c_str(),&end,10);
    if(end==s.c_str() || n<0 || n>4096)return false;
    const std::string unit=trimCss(end);
    if(!unit.empty() && unit!="px")return false;
    out=(int)n;return true;
}
inline bool cssHexColor(const std::string& value,unsigned& out) {
    const auto s=trimCss(value);
    if((s.size()!=7 && s.size()!=4) || s[0]!='#')return false;
    unsigned rgb=0;
    for(std::size_t i=1;i<s.size();i++){
        const char c=s[i];
        const int d=c>='0' && c<='9'?c-'0':
            c>='a' && c<='f'?c-'a'+10:
            c>='A' && c<='F'?c-'A'+10:-1;
        if(d<0)return false;
        if(s.size()==4) rgb=(rgb<<8)|(unsigned)(d*17);
        else rgb=(rgb<<4)|(unsigned)d;
    }
    out=rgb;return true;
}
inline std::string cssWithoutComments(const std::string& input){
    std::string result;
    for(std::size_t i=0;i<input.size();){
        if(i+1<input.size()&&input[i]=='/'&&input[i+1]=='*'){
            const auto end=input.find("*/",i+2);
            if(end==std::string::npos)break;
            i=end+2;
        }else result+=input[i++];
    }
    return result;
}
inline NativeButtonStyle parseNativeButton(const std::string& markup,
                                           const std::string& css,
                                           const std::string& target="restart-button") {
    NativeButtonStyle style;
    style.id=target;
    auto elements=parseUiElements(markup);
    applyUiCss(elements,css);
    for(const auto& element:elements) {
        if(element.id!=target || element.tag!="button")continue;
        if(!element.text.empty())style.text=element.text;
        for(const auto& entry:element.style) {
            const auto& key=entry.first;
            const auto& value=entry.second;
            if(key=="top")cssPixels(value,style.top);
            else if(key=="right")cssPixels(value,style.right);
            else if(key=="width")cssPixels(value,style.width);
            else if(key=="height")cssPixels(value,style.height);
            else if(key=="border-radius")cssPixels(value,style.radius);
            else if(key=="font-size")cssPixels(value,style.fontSize);
            else if(key=="border-width")cssPixels(value,style.borderWidth);
            else if(key=="background-color")cssHexColor(value,style.background);
            else if(key=="color")cssHexColor(value,style.foreground);
            else if(key=="border-color")cssHexColor(value,style.border);
            else if(key=="font-weight")style.bold=(lowerCss(value)=="bold"||value=="700");
        }
        break;
    }
    style.width=std::max(32,style.width);
    style.height=std::max(22,style.height);
    style.radius=std::min(style.radius,std::min(style.width,style.height)/2);
    style.fontSize=std::max(9,style.fontSize);
    return style;
}
} // namespace native_three
