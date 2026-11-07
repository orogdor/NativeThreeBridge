#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <windowsx.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>

#define MAX_TREES 1500
#define MAX_HOUSES 80
#define MAX_ITEMS (MAX_TREES + MAX_HOUSES)

typedef struct SceneItem {
    POINT foot;
    float depth;
    int kind; /* 0 tree, 1 house */
    int id;
} SceneItem;

static float cameraAngle = 0.25f;
static BOOL paused = FALSE;
static int mouseX = 0, mouseDown = 0;
static unsigned long frameCount = 0;
static ULONGLONG fpsTime = 0;
static int fps = 0;

/* Reusable offscreen backbuffer: only the completed frame reaches the window. */
static HDC backDC = NULL;
static HBITMAP backBitmap = NULL;
static HGDIOBJ defaultBitmap = NULL;
static int backWidth = 0, backHeight = 0;

static BOOL ensureBackbuffer(HDC windowDC, int w, int h) {
    if (w <= 0 || h <= 0) return FALSE;
    if (backDC && backBitmap && backWidth == w && backHeight == h) return TRUE;
    if (!backDC) {
        backDC = CreateCompatibleDC(windowDC);
        if (!backDC) return FALSE;
    }
    HBITMAP next = CreateCompatibleBitmap(windowDC, w, h);
    if (!next) return FALSE;
    HGDIOBJ previous = SelectObject(backDC, next);
    if (!previous || previous == HGDI_ERROR) {
        DeleteObject(next);
        return FALSE;
    }
    if (backBitmap) DeleteObject(backBitmap);
    else defaultBitmap = previous;
    backBitmap = next;
    backWidth = w;
    backHeight = h;
    return TRUE;
}

static void releaseBackbuffer(void) {
    if (backDC) {
        if (backBitmap) {
            SelectObject(backDC, defaultBitmap);
            DeleteObject(backBitmap);
        }
        DeleteDC(backDC);
    }
    backDC = NULL;
    backBitmap = NULL;
    defaultBitmap = NULL;
    backWidth = backHeight = 0;
}

static void project3d(float x, float y, float z, int cx, int cy, float scale, POINT *out) {
    float c = (float)cos(cameraAngle), s = (float)sin(cameraAngle);
    float a = x * c - z * s, b = x * s + z * c;
    out->x = cx + (int)(a * scale);
    out->y = cy + (int)(b * scale * 0.42f - y * scale);
}

/* Painter's order: far objects first. Stable tie-breaker avoids random order flips. */
static int itemCompare(const void *a, const void *b) {
    const SceneItem *x = (const SceneItem *)a;
    const SceneItem *y = (const SceneItem *)b;
    if (x->depth < y->depth) return -1;
    if (x->depth > y->depth) return 1;
    if (x->kind != y->kind) return x->kind - y->kind;
    return x->id - y->id;
}

static void drawScene(HDC dc, RECT rect) {
    int w = rect.right - rect.left, h = rect.bottom - rect.top;
    if (w <= 0 || h <= 0) return;
    int cx = w / 2, cy = h / 2 + 40;
    float scale = (float)(w < h ? w : h) / 160.0f;
    int saved = SaveDC(dc);
    float c = (float)cos(cameraAngle), s = (float)sin(cameraAngle);
    HBRUSH background = CreateSolidBrush(RGB(22, 33, 55));
    HBRUSH green = CreateSolidBrush(RGB(58, 85, 69));
    HBRUSH treeBrush = CreateSolidBrush(RGB(30, 145, 90));
    HBRUSH trunkBrush = CreateSolidBrush(RGB(132, 85, 51));
    HBRUSH houseBrush = CreateSolidBrush(RGB(194, 149, 108));
    HBRUSH roofBrush = CreateSolidBrush(RGB(124, 69, 45));

    FillRect(dc, &rect, background);
    SelectObject(dc, GetStockObject(NULL_PEN));

    POINT ground[4];
    project3d(-70,0,-70,cx,cy,scale,&ground[0]);
    project3d( 70,0,-70,cx,cy,scale,&ground[1]);
    project3d( 70,0, 70,cx,cy,scale,&ground[2]);
    project3d(-70,0, 70,cx,cy,scale,&ground[3]);
    SelectObject(dc, green);
    Polygon(dc, ground, 4);

    SceneItem items[MAX_ITEMS];
    int count = 0;
    for (int i = 0; i < MAX_TREES; ++i) {
        unsigned int seed = (unsigned int)(i * 1103515245u + 12345u);
        float x = ((int)(seed % 121u) - 60) * 0.96f;
        float z = ((int)((seed >> 8) % 121u) - 60) * 0.96f;
        if (x > -20 && x < 20 && z > -20 && z < 20) continue;
        SceneItem *item = &items[count++];
        project3d(x,0,z,cx,cy,scale,&item->foot);
        item->depth = x * s + z * c;
        item->kind = 0;
        item->id = i;
    }
    for (int i = 0; i < MAX_HOUSES; ++i) {
        float x = -18.0f + (float)(i % 10) * 3.9f;
        float z = -18.0f + (float)(i / 10) * 4.4f;
        SceneItem *item = &items[count++];
        project3d(x,0,z,cx,cy,scale,&item->foot);
        item->depth = x * s + z * c;
        item->kind = 1;
        item->id = i;
    }
    qsort(items, (size_t)count, sizeof(items[0]), itemCompare);

    for (int i = 0; i < count; ++i) {
        POINT p = items[i].foot;
        if (items[i].kind == 0) {
            RECT trunk = { p.x-1, p.y-8, p.x+2, p.y+2 };
            FillRect(dc, &trunk, trunkBrush);
            POINT triangle[3] = {
                {p.x, p.y-20}, {p.x-7, p.y-3}, {p.x+7, p.y-3}
            };
            SelectObject(dc, treeBrush);
            Polygon(dc, triangle, 3);
        } else {
            RECT building = { p.x-5, p.y-10, p.x+5, p.y+3 };
            FillRect(dc, &building, houseBrush);
            POINT roof[3] = {
                {p.x, p.y-18}, {p.x-7, p.y-10}, {p.x+7, p.y-10}
            };
            SelectObject(dc, roofBrush);
            Polygon(dc, roof, 3);
        }
    }

    /* Text is drawn last, once per completed frame. */
    SetBkMode(dc, TRANSPARENT);
    SetTextColor(dc, RGB(237, 241, 246));
    { const char *t = "NativeThreeBridge v0.4.1 | DOUBLE BUFFERED GDI | NOT DX12";
      TextOutA(dc,12,10,t,lstrlenA(t)); }
    { const char *t = "No Chromium / Electron / WebView / Deno / Node runtime";
      TextOutA(dc,12,32,t,lstrlenA(t)); }
    { const char *t = "Drag mouse: rotate | Space: pause | Esc: exit";
      TextOutA(dc,12,h-24,t,lstrlenA(t)); }
    char meter[120];
    sprintf_s(meter,sizeof(meter),"FPS: %d  Trees: %d  Houses: %d",fps,count-MAX_HOUSES,MAX_HOUSES);
    if (w > 360) TextOutA(dc,w-330,58,meter,(int)lstrlenA(meter));

    if (saved) RestoreDC(dc,saved); /* deselect all allocated brushes before deletion */
    DeleteObject(background);
    DeleteObject(green);
    DeleteObject(treeBrush);
    DeleteObject(trunkBrush);
    DeleteObject(houseBrush);
    DeleteObject(roofBrush);
}

static LRESULT CALLBACK WindowProc(HWND win, UINT message, WPARAM w, LPARAM l) {
    switch (message) {
        case WM_ERASEBKGND:
            return 1; /* backbuffer includes background; never clear front buffer */
        case WM_TIMER:
            if (!paused) cameraAngle += 0.004f;
            InvalidateRect(win, NULL, FALSE);
            return 0;
        case WM_LBUTTONDOWN:
            mouseDown=1;mouseX=GET_X_LPARAM(l);SetCapture(win);return 0;
        case WM_MOUSEMOVE:
            if(mouseDown) {
                int x=GET_X_LPARAM(l);
                cameraAngle+=(x-mouseX)*0.009f;
                mouseX=x;
                InvalidateRect(win,NULL,FALSE);
            }
            return 0;
        case WM_LBUTTONUP:
            mouseDown=0;ReleaseCapture();return 0;
        case WM_KEYDOWN:
            if(w==VK_ESCAPE) DestroyWindow(win);
            if(w==VK_SPACE) paused=!paused;
            return 0;
        case WM_PAINT: {
            PAINTSTRUCT p;
            HDC dc = BeginPaint(win,&p);
            RECT r;GetClientRect(win,&r);
            int width = r.right-r.left, height = r.bottom-r.top;
            if (width > 0 && height > 0) {
                if (ensureBackbuffer(dc,width,height)) {
                    drawScene(backDC,r);
                    BitBlt(dc,0,0,width,height,backDC,0,0,SRCCOPY);
                } else {
                    drawScene(dc,r); /* safe fallback if allocation fails */
                }
                frameCount++;
                ULONGLONG now = GetTickCount64();
                if (now - fpsTime >= 1000) {
                    fps = (int)(frameCount*1000/(now-fpsTime));
                    fpsTime = now;
                    frameCount = 0;
                }
            }
            EndPaint(win,&p);
            return 0;
        }
        case WM_DESTROY:
            KillTimer(win,1);
            releaseBackbuffer();
            PostQuitMessage(0);
            return 0;
    }
    return DefWindowProcA(win,message,w,l);
}

int WINAPI WinMain(HINSTANCE inst,HINSTANCE prev,LPSTR cmd,int show) {
    (void)prev;(void)cmd;
    WNDCLASSA wc={0};
    wc.lpfnWndProc=WindowProc;
    wc.hInstance=inst;
    wc.lpszClassName="NativeThreeBridgeWindow";
    wc.hCursor=LoadCursor(NULL,IDC_ARROW);
    wc.hbrBackground=NULL; /* avoids needless background erase */
    if(!RegisterClassA(&wc))return 1;
    HWND win=CreateWindowExA(0,wc.lpszClassName,
        "NativeThreeBridge v0.4.1 - Windows Diagnostic (GDI, not DX12)",
        WS_OVERLAPPEDWINDOW,CW_USEDEFAULT,CW_USEDEFAULT,1200,800,NULL,NULL,inst,NULL);
    if(!win)return 2;
    fpsTime=GetTickCount64();
    ShowWindow(win,show);
    UpdateWindow(win);
    SetTimer(win,1,16,NULL);
    MSG msg;
    while(GetMessageA(&msg,NULL,0,0)>0) {
        TranslateMessage(&msg);
        DispatchMessageA(&msg);
    }
    return (int)msg.wParam;
}
