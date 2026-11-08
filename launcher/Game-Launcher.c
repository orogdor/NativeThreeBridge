/* Game1.exe / Game2.exe: tiny launchers that start the shared engine
 * (NativeThree-Engine.exe) on one game folder. Built twice from this file:
 *   cl /DNTB_GAME=1 ... /Fe:Game1.exe   -> forest battle in game1\ (scene.js)
 *   cl /DNTB_GAME=2 ... /Fe:Game2.exe   -> webapp in game2\ (index.html, Kuningriigid)
 * Updating the engine never touches the game folders, and updating a game
 * never touches the engine.
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <wchar.h>
#pragma comment(lib, "user32.lib")

#ifndef NTB_GAME
#error "Build with /DNTB_GAME=1 or /DNTB_GAME=2"
#endif

static void message(const wchar_t *text) {
    if (GetEnvironmentVariableW(L"CI", NULL, 0) == 0)
        MessageBoxW(NULL, text, NTB_GAME == 1 ? L"Game1 - metsalahing" : L"Game2", MB_OK | MB_ICONWARNING);
}

static int exists(const wchar_t *path) {
    return GetFileAttributesW(path) != INVALID_FILE_ATTRIBUTES;
}

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE previous, LPWSTR args, int show) {
    wchar_t folder[MAX_PATH], engine[MAX_PATH], check[MAX_PATH], command[3 * MAX_PATH];
    (void)instance; (void)previous; (void)args; (void)show;
    DWORD length = GetModuleFileNameW(NULL, folder, MAX_PATH);
    if (!length || length >= MAX_PATH) return 40;
    wchar_t *slash = wcsrchr(folder, L'\\');
    if (!slash) return 40;
    *slash = 0;

    swprintf_s(engine, MAX_PATH, L"%s\\NativeThree-Engine.exe", folder);
    if (!exists(engine)) {
        message(L"NativeThree-Engine.exe puudub.\nPaki kogu ZIP lahti või käivita UpdateEngine.exe.");
        return 41;
    }
#if NTB_GAME == 1
    swprintf_s(check, MAX_PATH, L"%s\\game1\\scene.js", folder);
    if (!exists(check)) {
        message(L"Kaustast game1 puudub scene.js (metsalahingu test).\nPaki kogu ZIP uuesti lahti.");
        return 42;
    }
    swprintf_s(command, 3 * MAX_PATH, L"\"%s\" --scene game1", engine);
#else
    swprintf_s(check, MAX_PATH, L"%s\\game2\\index.html", folder);
    if (!exists(check)) {
        message(L"Kaust game2 on tühi.\nKäivita UpdateKuningriigid.exe, et Kuningriigid GitHubist alla laadida, ja ava siis uuesti Game2.exe.");
        return 42;
    }
    swprintf_s(command, 3 * MAX_PATH, L"\"%s\" --webapp \"%s\\game2\"", engine, folder);
#endif
    STARTUPINFOW startup = {0};
    PROCESS_INFORMATION process = {0};
    startup.cb = sizeof startup;
    if (!CreateProcessW(engine, command, NULL, NULL, FALSE, 0, NULL, folder, &startup, &process)) {
        message(L"NativeThree-Engine.exe käivitamine ebaõnnestus.");
        return 43;
    }
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    return 0;
}
