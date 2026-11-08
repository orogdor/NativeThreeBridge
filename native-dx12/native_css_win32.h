#pragma once
#include "game_folder.h"
// Win32 backend of the tiny HTML/CSS-to-native test. No browser/WebView.
#include "native_css_style.h"
#include <windows.h>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <string>

namespace native_three {
class NativeCssRestartButton {
public:
    static constexpr int kControlId=2301;
    ~NativeCssRestartButton() {
        if(font_)DeleteObject(font_);
    }
    bool create(HWND parent) {
        wchar_t module[MAX_PATH]={};
        const DWORD length=GetModuleFileNameW(nullptr,module,MAX_PATH);
        if(length==0||length>=MAX_PATH)return false;
        const std::filesystem::path base=
            std::filesystem::path(module).parent_path() / NativeThree_SceneFolder();
        const std::string html=read(base/L"ui.html");
        const std::string css=read(base/L"ui.css");
        style_=parseNativeButton(html,css,"restart-button");
        label_=std::wstring(style_.text.begin(),style_.text.end());
        parent_=parent;
        button_=CreateWindowExW(0,L"BUTTON",label_.c_str(),
            WS_CHILD|WS_VISIBLE|WS_TABSTOP|BS_OWNERDRAW,
            0,0,1,1,parent,(HMENU)(INT_PTR)kControlId,
            GetModuleHandleW(nullptr),nullptr);
        if(!button_)return false;
        const UINT dpi=GetDpiForWindow(parent);
        font_=CreateFontW(-MulDiv(style_.fontSize,dpi,96),0,0,0,
            style_.bold?FW_BOLD:FW_NORMAL,FALSE,FALSE,FALSE,
            DEFAULT_CHARSET,OUT_DEFAULT_PRECIS,CLIP_DEFAULT_PRECIS,
            CLEARTYPE_QUALITY,DEFAULT_PITCH,L"Segoe UI");
        if(font_)SendMessageW(button_,WM_SETFONT,(WPARAM)font_,TRUE);
        layout();
        return true;
    }
    void layout(){
        if(!parent_||!button_)return;
        RECT client{};
        GetClientRect(parent_,&client);
        const UINT dpi=GetDpiForWindow(parent_);
        const int w=MulDiv(style_.width,dpi,96),h=MulDiv(style_.height,dpi,96);
        const int x=std::max(0,(int)client.right-MulDiv(style_.right,dpi,96)-w);
        const int y=MulDiv(style_.top,dpi,96);
        MoveWindow(button_,x,y,w,h,TRUE);
    }
    bool draw(const DRAWITEMSTRUCT* info){
        if(!info||info->CtlID!=kControlId)return false;
        HDC dc=info->hDC;
        RECT r=info->rcItem;
        HBRUSH backdrop=CreateSolidBrush(RGB(8,13,22));
        FillRect(dc,&r,backdrop);
        DeleteObject(backdrop);
        const bool down=(info->itemState&ODS_SELECTED)!=0;
        const unsigned bg=down?0x264a60:style_.background;
        HBRUSH fill=CreateSolidBrush(color(bg));
        HPEN pen=CreatePen(PS_SOLID,std::max(1,style_.borderWidth),
                          color(style_.border));
        auto oldBrush=SelectObject(dc,fill);
        auto oldPen=SelectObject(dc,pen);
        const int rad=MulDiv(style_.radius,GetDpiForWindow(parent_),96)*2;
        RoundRect(dc,r.left+1,r.top+1,r.right-1,r.bottom-1,rad,rad);
        SelectObject(dc,oldBrush);
        SelectObject(dc,oldPen);
        DeleteObject(pen);DeleteObject(fill);
        const auto oldFont=font_?SelectObject(dc,font_):nullptr;
        SetBkMode(dc,TRANSPARENT);
        SetTextColor(dc,color(style_.foreground));
        DrawTextW(dc,label_.c_str(),(int)label_.size(),&r,
                  DT_CENTER|DT_VCENTER|DT_SINGLELINE);
        if(oldFont)SelectObject(dc,oldFont);
        if(info->itemState&ODS_FOCUS)DrawFocusRect(dc,&r);
        return true;
    }
    bool isClick(WPARAM wp) const {
        return button_ && LOWORD(wp)==kControlId && HIWORD(wp)==BN_CLICKED;
    }
    const NativeButtonStyle& style()const{return style_;}
private:
    static COLORREF color(unsigned c) {
        return RGB((c>>16)&255,(c>>8)&255,c&255);
    }
    static std::string read(const std::filesystem::path& path){
        std::ifstream f(path,std::ios::binary);
        return f?std::string(std::istreambuf_iterator<char>(f),
                            std::istreambuf_iterator<char>()):"";
    }
    HWND parent_{},button_{};
    HFONT font_{};
    std::wstring label_;
    NativeButtonStyle style_;
};
} // namespace native_three
