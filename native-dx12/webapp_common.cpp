// Shared by both webapp JavaScript backends (QuickJS: webapp_host.cpp,
// V8: webapp_host_v8.cpp): module resolution rules, game-folder file access.
// C++17, no JavaScript engine headers.
#include "webapp_host.h"

#include <algorithm>
#include <cctype>
#include <cstring>
#include <fstream>

namespace native_three {
namespace {

constexpr std::size_t kMaxGameFileBytes = 256u * 1024u * 1024u;

bool startsWith(const std::string& s, const char* prefix) {
    const std::size_t n = std::strlen(prefix);
    return s.size() >= n && s.compare(0, n, prefix) == 0;
}
bool endsWith(const std::string& s, const char* suffix) {
    const std::size_t n = std::strlen(suffix);
    return s.size() >= n && s.compare(s.size() - n, n, suffix) == 0;
}
std::string stripQueryAndHash(const std::string& s) {
    const std::size_t cut = s.find_first_of("?#");
    return cut == std::string::npos ? s : s.substr(0, cut);
}
std::string dirOf(const std::string& path) {
    const std::size_t slash = path.find_last_of('/');
    return slash == std::string::npos ? std::string() : path.substr(0, slash + 1);
}
std::string baseName(const std::string& path) {
    const std::size_t slash = path.find_last_of('/');
    return slash == std::string::npos ? path : path.substr(slash + 1);
}
// Joins and normalizes; returns false when the path climbs above the root.
bool normalizeSegments(const std::string& path, std::string& out) {
    std::vector<std::string> parts;
    std::size_t start = 0;
    while (start <= path.size()) {
        std::size_t end = path.find('/', start);
        if (end == std::string::npos) end = path.size();
        const std::string part = path.substr(start, end - start);
        if (part == "..") {
            if (parts.empty()) return false;
            parts.pop_back();
        } else if (!part.empty() && part != ".") {
            parts.push_back(part);
        }
        start = end + 1;
    }
    out.clear();
    for (std::size_t i = 0; i < parts.size(); i++) {
        if (i) out += '/';
        out += parts[i];
    }
    return true;
}
bool isThreeBuildFile(const std::string& path) {
    const std::string name = baseName(path);
    return name == "three.module.js" || name == "three.module.min.js" ||
           name == "three.core.js" || name == "three.core.min.js";
}
std::string toLower(std::string s) {
    for (char& c : s) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    return s;
}

} // namespace

std::string webappNormalizeGamePath(const std::string& path) {
    if (path.empty() || path.size() > 1024) return {};
    if (path.find('\\') != std::string::npos || path.find(':') != std::string::npos ||
        path.find('\0') != std::string::npos)
        return {};
    std::string out;
    if (!normalizeSegments(path, out) || out.empty()) return {};
    return out;
}

std::string webappResolveModule(const std::string& base, const std::string& specifierIn,
                                const std::vector<std::string>& importMap,
                                const std::vector<std::string>& builtinNames,
                                std::string& error) {
    auto isBuiltin = [&](const std::string& name) {
        return std::find(builtinNames.begin(), builtinNames.end(), name) != builtinNames.end();
    };
    std::string specifier = specifierIn;
    std::string effectiveBase = base;

    // 1. 'three' is always the engine's own Three.js + NativeRenderer.
    if (specifier == "three") return "nt:three";
    // 2. Addons the engine embeds (OrbitControls …) win over an importmap URL.
    for (const char* prefix : {"three/addons/", "three/examples/jsm/"}) {
        if (startsWith(specifier, prefix)) {
            const std::string name = "nt:addons/" + specifier.substr(std::strlen(prefix));
            if (isBuiltin(name)) return name;
        }
    }
    // 3. Engine-internal modules import each other relatively.
    if (startsWith(base, "nt:")) {
        if (startsWith(specifier, "nt:")) return specifier;
        if (startsWith(specifier, "./") || startsWith(specifier, "../")) {
            std::string joined;
            if (!normalizeSegments(dirOf(base.substr(3)) + specifier, joined)) {
                error = "Engine module path escapes: " + specifier;
                return {};
            }
            return "nt:" + joined;
        }
    }
    // 4. Import map: exact key first, then the longest "prefix/" key.
    const bool relative = startsWith(specifier, "/") || startsWith(specifier, "./") ||
                          startsWith(specifier, "../");
    if (!relative) {
        std::string best, bestValue;
        bool exact = false;
        for (std::size_t i = 0; i + 1 < importMap.size(); i += 2) {
            const std::string& key = importMap[i];
            if (key == specifier) { bestValue = importMap[i + 1]; exact = true; break; }
            if (!key.empty() && key.back() == '/' && startsWith(specifier, key.c_str()) &&
                key.size() > best.size()) {
                best = key;
                bestValue = importMap[i + 1] + specifier.substr(key.size());
            }
        }
        if (exact || !best.empty()) {
            specifier = bestValue;
            effectiveBase = "index.html"; // import map URLs are relative to the page
        }
    }
    const std::string lower = toLower(specifier);
    if (startsWith(lower, "http://") || startsWith(lower, "https://") || startsWith(lower, "//")) {
        if (isThreeBuildFile(stripQueryAndHash(specifier))) return "nt:three";
        error = "Module '" + specifierIn + "' points to the internet (" + specifier +
                "). NativeThreeBridge runs offline: copy the file into the game folder "
                "and point the importmap to it.";
        return {};
    }
    if (startsWith(specifier, "nt:")) {
        if (isBuiltin(specifier) || specifier == "nt:three") return specifier;
        error = "Unknown engine module " + specifier;
        return {};
    }
    if (!(startsWith(specifier, "/") || startsWith(specifier, "./") || startsWith(specifier, "../"))) {
        error = "Bare module '" + specifierIn + "' is not in the importmap of index.html";
        return {};
    }
    // 5. Paths inside the game folder.
    const std::string pathPart = stripQueryAndHash(specifier);
    std::string baseFile = effectiveBase;
    const std::size_t hash = baseFile.find('#');
    if (hash != std::string::npos) baseFile.resize(hash);
    const std::string joined = pathPart[0] == '/' ? pathPart.substr(1) : dirOf(baseFile) + pathPart;
    std::string normalized;
    if (!normalizeSegments(joined, normalized) || normalized.empty()) {
        error = "Module path leaves the game folder: " + specifierIn;
        return {};
    }
    // A vendored copy of three.module.js would bring the WebGL renderer back.
    if (isThreeBuildFile(normalized)) return "nt:three";
    return normalized;
}

const char* webappThreeModuleSource() {
    return
        "export * from 'nt:three.module.min.js';\n"
        "import * as THREE_CORE from 'nt:three.core.min.js';\n"
        "import { createNativeRendererClasses } from 'nt:native-renderer.mjs';\n"
        "const { NativeRenderer } = createNativeRendererClasses(THREE_CORE, globalThis.__nt, globalThis.__ntHost);\n"
        "export { NativeRenderer, NativeRenderer as WebGLRenderer };\n";
}


bool webappReadGameFile(const std::filesystem::path& root, const std::string& rel,
                        std::string& out, std::string& error) {
    const std::string clean = webappNormalizeGamePath(rel);
    if (clean.empty()) { error = "Invalid game path: " + rel; return false; }
    const std::filesystem::path full = root / std::filesystem::u8path(clean);
    std::ifstream file(full, std::ios::binary);
    if (!file) { error = "File not found in game folder: " + clean; return false; }
    file.seekg(0, std::ios::end);
    const std::streamoff size = file.tellg();
    if (size < 0 || static_cast<std::uint64_t>(size) > kMaxGameFileBytes) {
        error = "File too large or unreadable: " + clean; return false;
    }
    file.seekg(0, std::ios::beg);
    out.resize(static_cast<std::size_t>(size));
    if (size > 0 && !file.read(out.data(), size)) { error = "Read failed: " + clean; return false; }
    return true;
}

std::string webappPathUtf8(const std::filesystem::path& path) { return path.u8string(); }

} // namespace native_three
