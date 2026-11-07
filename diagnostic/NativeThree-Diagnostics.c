#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <windowsx.h>
#include <math.h>
#include <stdio.h>

static float cameraAngle = 0.25f;
static BOOL paused = FALSE;
static int mouseX = 0, mouseDown = 0;
static unsigned long frameCount = 0;
static ULONGLONG fpsTime = 0;
static int fps = 0;

static void project3d(float x, float y, float z, int cx, int cy, float scale, POINT *out) {
    float c = (float)cos(cameraAngle), s = (float)sin(cameraAngle);
    float a = x * c - z * s, b = x * s + z * c;
    out->x = cx + (int)(a * scale);
    out->y = cy + (int)(b * scale * 0.42f - y * scale);
}

static void drawScene(HDC dc, RECT rect) {
    int w = rect.right - rect.left, h = rect.bottom - rect.top;
    int cx = w / 2, cy = h / 2 + 40;
    float scale = (float)(w < h ? w : h) / 160.0f;
    HBRUSH background = CreateSolidBrush(RGB(22, 33, 55));
    FillRect(dc, &rect, background);
    DeleteObject(background);
    POINT ground[4];
    project3d(-70,0,-70,cx,cy,scale,&ground[0]);
    project3d( 70,0,-70,cx,cy,scale,&ground[1]);
    project3d( 70,0, 70,cx,cy,scale,&ground[2]);
    project3d(-70,0, 70,cx,cy,scale,&ground[3]);
    HBRUSH green = CreateSolidBrush(RGB(58,85,69));
    HGDIOBJ oldBrush = SelectObject(dc,green);
    Polygon(dc,ground,4);
    SelectObject(dc,oldBrush);
    DeleteObject(green);

    HBRUSH treeBrush = CreateSolidBrush(RGB(30,145,90));
    HBRUSH trunkBrush = CreateSolidBrush(RGB(132,85,51));
    HBRUSH houseBrush = CreateSolidBrush(RGB(194,149,108));
    HBRUSH roofBrush = CreateSolidBrush(RGB(124,69,45));
    for(int i=0; i<1500; ++i) {
        unsigned int seed = (unsigned int)(i * 1103515245u + 12345u);
        float x = ((int)(seed % 121u) - 60) * 0.96f;
        float z = ((int)((seed >> 8) % 121u) - 60) * 0.96f;
        if(x > -20 && x < 20 && z > -20 && z < 20) continue;
        POINT p,triangle[3];
        project3d(x,0,z,cx,cy,scale,&p);
        RECT trunk = { p.x-1,p.y-8,p.x+2,p.y+2 };
        SelectObject(dc,trunkBrush);
        FillRect(dc,&trunk,trunkBrush);
        triangle[0].x = p.x; triangle[0].y = p.y - 20;
        triangle[1].x = p.x - 7; triangle[1].y = p.y - 3;
        triangle[2].x = p.x + 7; triangle[2].y = p.y - 3;
        SelectObject(dc,treeBrush);
        Polygon(dc,triangle,3);
    }
    for(int i=0;i<80;i++) {
        float x = -18.0f+(float)(i%10)*3.9f,z=-18.0f+(float)(i/10)*4.4f;
        POINT p,r[3];
        project3d(x,0,z,cx,cy,scale,&p);
        RECT building={p.x-5,p.y-10,p.x+5,p.y+3};
        FillRect(dc,&building,houseBrush);
        r[0].x=p.x;r[0].y=p.y-18;
        r[1].x=p.x-7;r[1].y=p.y-10;
        r[2].x=p.x+7;r[2].y=p.y-10;
        SelectObject(dc,roofBrush);
        Polygon(dc,r,3);
    }
    SelectObject(dc,oldBrush);
    DeleteObject(treeBrush);
    DeleteObject(trunkBrush);
    DeleteObject(houseBrush);
    DeleteObject(roofBrush);
    SelectObject(dc,GetStockObject(NULL_PEN));
    SetBkMode(dc,TRANSPARENT);
    SetTextColor(dc,RGB(237,241,246));
    {const char *s="NativeThreeBridge v0.4 | NATIVE WINDOWS GDI DIAGNOSTIC | NOT DX12";TextOutA(dc,12,10,s,lstrlenA(s));}
    {const char *s="No Chromium / Electron / WebView / Deno / Node runtime";TextOutA(dc,12,32,s,lstrlenA(s));}
    {const char *s="Drag mouse to rotate | Space pause | Esc exit";TextOutA(dc,12,h-24,s,lstrlenA(s));}
    char meter[120];
    sprintf_s(meter,sizeof(meter),"FPS: %d  Trees: 1500  Houses: 80",fps);
    TextOutA(dc,w-330,11,meter,(int)lstrlenA(meter));
}
static LRESULT CALLBACK WindowProc(HWND win,UINT message,WPARAM w,LPARAM l) {
    switch(message) {
        case WM_TIMER: {
            if(!paused) cameraAngle += 0.004f;
            InvalidateRect(win,NULL,FALSE);
            return 0;
        }
        case WM_LBUTTONDOWN: mouseDown=1;mouseX=GET_X_LPARAM(l);SetCapture(win);return 0;
        case WM_MOUSEMOVE: if(mouseDown) {int x=GET_X_LPARAM(l);cameraAngle+=(x-mouseX)*0.009f;mouseX=x;}return 0;
        case WM_LBUTTONUP: mouseDown=0;ReleaseCapture();return 0;
        case WM_KEYDOWN:
            if(w==VK_ESCAPE) DestroyWindow(win);
            if(w==VK_SPACE) paused=!paused;
            return 0;
        case WM_PAINT: {
            PAINTSTRUCT p;HDC dc=BeginPaint(win,&p);RECT r;GetClientRect(win,&r);
            drawScene(dc,r);EndPaint(win,&p);
            frameCount++;
            ULONGLONG now=GetTickCount64();
            if(now-fpsTime>=1000) {fps=(int)(frameCount*1000/(now-fpsTime));fpsTime=now;frameCount=0;}
            return 0;
        }
        case WM_DESTROY: KillTimer(win,1);PostQuitMessage(0);return 0;
    }
    return DefWindowProcA(win,message,w,l);
}
int WINAPI WinMain(HINSTANCE inst,HINSTANCE prev,LPSTR cmd,int show) {
    (void)prev;(void)cmd;
    WNDCLASSA wc={0};wc.lpfnWndProc=WindowProc;wc.hInstance=inst;
    wc.lpszClassName="NativeThreeBridgeWindow";wc.hCursor=LoadCursor(NULL,IDC_ARROW);
    wc.hbrBackground=(HBRUSH)(COLOR_WINDOW+1);
    if(!RegisterClassA(&wc))return 1;
    HWND win=CreateWindowExA(0,wc.lpszClassName,"NativeThreeBridge v0.4 - Windows Diagnostic (GDI, not DX12)",
        WS_OVERLAPPEDWINDOW,CW_USEDEFAULT,CW_USEDEFAULT,1200,800,NULL,NULL,inst,NULL);
    if(!win)return 2;
    ShowWindow(win,show);UpdateWindow(win);fpsTime=GetTickCount64();
    SetTimer(win,1,16,NULL);
    MSG msg;while(GetMessageA(&msg,NULL,0,0)>0){TranslateMessage(&msg);DispatchMessageA(&msg);}
    return (int)msg.wParam;
}
