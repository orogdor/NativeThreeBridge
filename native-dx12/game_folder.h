#pragma once
#include <string>

// Folder beside the EXE that holds the classic scene.js game (forest battle).
// Default "game"; Game1.exe starts the engine with "--scene game1".
inline std::wstring& NativeThree_SceneFolder() {
    static std::wstring folder = L"game";
    return folder;
}
