#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include "webapp_resources.h"

namespace {
bool loadResource(int id, std::string& out) {
    HRSRC res = FindResourceW(nullptr, MAKEINTRESOURCEW(id), RT_RCDATA);
    if (!res) return false;
    const DWORD size = SizeofResource(nullptr, res);
    HGLOBAL handle = LoadResource(nullptr, res);
    const char* data = handle ? static_cast<const char*>(LockResource(handle)) : nullptr;
    if (!data || size == 0) return false;
    out.assign(data, size);
    return true;
}
} // namespace

bool NativeWebapp_LoadBuiltins(std::string& shimSource,
                               std::vector<native_three::WebappBuiltin>& builtins,
                               std::string& error) {
    struct Entry { int id; const char* name; };
    const Entry modules[] = {
        {401, "nt:three.core.min.js"},
        {402, "nt:three.module.min.js"},
        {404, "nt:native-renderer.mjs"},
        {405, "nt:addons/controls/OrbitControls.js"},
        {406, "nt:addons/controls/PointerLockControls.js"},
    };
    builtins.clear();
    for (const Entry& e : modules) {
        native_three::WebappBuiltin b;
        b.name = e.name;
        if (!loadResource(e.id, b.source)) {
            error = std::string("Missing embedded webapp resource ") + e.name;
            return false;
        }
        builtins.push_back(std::move(b));
    }
    if (!loadResource(403, shimSource)) {
        error = "Missing embedded webapp shim (resource 403)";
        return false;
    }
    // The HTML/CSS UI layer runs right after the shim, in the same script.
    std::string ui;
    if (!loadResource(407, ui)) {
        error = "Missing embedded HTML/CSS UI layer (resource 407)";
        return false;
    }
    shimSource += "\n;\n";
    shimSource += ui;
    return true;
}
