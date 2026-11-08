#pragma once
// Tiny, platform-neutral CSS + button-markup translator for NativeThreeBridge.
// Deliberately not a browser or full CSS engine. Unknown properties are ignored.
// Converts one <button id="..."> element + #id { ... } into a Win32-ready style.
#include <algorithm>
#include <cctype>
#include <cstdlib>
#include <string>

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
    if(s.size()!=7 || s[0]!='#')return false;
    unsigned rgb=0;
    for(std::size_t i=1;i<7;i++){
        const char c=s[i];
        const int d=c>='0' && c<='9'?c-'0':
            c>='a' && c<='f'?c-'a'+10:
            c>='A' && c<='F'?c-'A'+10:-1;
        if(d<0)return false;
        rgb=(rgb<<4)|(unsigned)d;
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
    // Narrow intentionally supported HTML subset: <button id="x">Text</button>.
    const std::string token=std::string("id=\"")+target+"\"";
    const auto start=markup.find("<button");
    if(start!=std::string::npos) {
        const auto openEnd=markup.find('>',start);
        if(openEnd!=std::string::npos &&
            markup.substr(start,openEnd-start).find(token)!=std::string::npos){
            const auto close=markup.find("</button>",openEnd);
            if(close!=std::string::npos){
                const auto label=trimCss(markup.substr(openEnd+1,close-openEnd-1));
                if(!label.empty() && label.find('<')==std::string::npos)
                    style.text=label;
            }
        }
    }
    const std::string input=cssWithoutComments(css);
    // Only the exact ID selector is supported (not :hover, media queries,
    // descendants, CSS variables or cascade).
    const std::string selector="#"+target;
    std::size_t pos=0;
    while((pos=input.find(selector,pos))!=std::string::npos){
        const auto tail=pos+selector.size();
        if(tail<input.size() &&
           (std::isalnum((unsigned char)input[tail]) || input[tail]=='-' ||
            input[tail]=='_' || input[tail]==':')){
            pos=tail;continue;
        }
        std::size_t open=tail;
        while(open<input.size()&&std::isspace((unsigned char)input[open]))++open;
        if(open>=input.size()||input[open]!='{'){pos=tail;continue;}
        const auto close=input.find('}',open+1);
        if(close==std::string::npos)break;
        const std::string block=input.substr(open+1,close-open-1);
        std::size_t begin=0;
        while(begin<block.size()){
            const auto end=block.find(';',begin);
            const std::string decl=trimCss(block.substr(begin,
                end==std::string::npos?std::string::npos:end-begin));
            const auto colon=decl.find(':');
            if(colon!=std::string::npos){
                const auto key=lowerCss(trimCss(decl.substr(0,colon)));
                const auto value=trimCss(decl.substr(colon+1));
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
            if(end==std::string::npos)break;
            begin=end+1;
        }
        pos=close+1;
    }
    style.width=std::max(32,style.width);
    style.height=std::max(22,style.height);
    style.radius=std::min(style.radius,std::min(style.width,style.height)/2);
    style.fontSize=std::max(9,style.fontSize);
    return style;
}
} // namespace native_three
