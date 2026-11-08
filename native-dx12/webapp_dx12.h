#pragma once
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <filesystem>

// Opens an ordinary Three.js webapp folder (index.html + ES modules) in its
// own resizable DX12 window. Returns the process exit code.
int NativeWebapp_Run(HINSTANCE instance, const std::filesystem::path& webappRoot);

// Finds which webapp to open: "--webapp <folder>", a folder (or its
// index.html) passed as the only argument / dropped on the EXE, or
// game/index.html beside the EXE. Returns false for the classic scene.js mode.
bool NativeWebapp_FindRoot(const wchar_t* commandLine, const std::filesystem::path& exeDir,
                           std::filesystem::path& root);
