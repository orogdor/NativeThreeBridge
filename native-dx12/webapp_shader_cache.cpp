#include "webapp_shader_cache.h"

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <d3dcompiler.h>

#include <atomic>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <vector>

#pragma comment(lib, "d3dcompiler.lib")

namespace native_three {
namespace {

// Bump when the compile setup changes in a way the key does not capture.
constexpr char kCacheFormat[] = "NTSC2";
std::atomic<unsigned> gHits{0}, gCompiles{0}, gWrites{0};

std::uint64_t fnv1a(const void* data, std::size_t size, std::uint64_t h) {
    const auto* p = static_cast<const unsigned char*>(data);
    for (std::size_t i = 0; i < size; i++) h = (h ^ p[i]) * 0x100000001b3ull;
    return h;
}

struct Key { std::uint64_t a = 0, b = 0; };

Key keyOf(const std::string& source, const char* entry, const char* target, unsigned flags) {
    Key k{0xcbf29ce484222325ull, 0x84222325cbf29ce4ull};
    auto mix = [&](const void* data, std::size_t size) {
        k.a = fnv1a(data, size, k.a);
        k.b = fnv1a(data, size, k.b ^ 0x9e3779b97f4a7c15ull);
    };
    mix(kCacheFormat, sizeof kCacheFormat);
    mix(source.data(), source.size());
    mix(entry, std::strlen(entry) + 1);
    mix(target, std::strlen(target) + 1);
    mix(&flags, sizeof flags);
    return k;
}

const std::wstring& cacheFolder() {
    static const std::wstring folder = [] {
        wchar_t off[8] = {};
        if (GetEnvironmentVariableW(L"NTB_SHADER_CACHE", off, 8) && off[0] == L'0') return std::wstring();
        wchar_t base[MAX_PATH] = {};
        const DWORD n = GetEnvironmentVariableW(L"LOCALAPPDATA", base, MAX_PATH);
        if (!n || n >= MAX_PATH) return std::wstring();
        std::wstring dir = std::wstring(base) + L"\\NativeThreeBridge";
        CreateDirectoryW(dir.c_str(), nullptr);
        dir += L"\\shader-cache";
        CreateDirectoryW(dir.c_str(), nullptr);
        const DWORD attributes = GetFileAttributesW(dir.c_str());
        return attributes != INVALID_FILE_ATTRIBUTES && (attributes & FILE_ATTRIBUTE_DIRECTORY) ? dir : std::wstring();
    }();
    return folder;
}

std::wstring fileOf(const Key& k) {
    wchar_t name[48];
    swprintf_s(name, L"\\%016llx%016llx.cso", static_cast<unsigned long long>(k.a), static_cast<unsigned long long>(k.b));
    return cacheFolder() + name;
}

// File: format tag, key, size, checksum, bytecode.
bool readCached(const Key& k, ID3DBlob** code) {
    if (cacheFolder().empty()) return false;
    FILE* f = nullptr;
    if (_wfopen_s(&f, fileOf(k).c_str(), L"rb") != 0 || !f) return false;
    char tag[sizeof kCacheFormat] = {};
    Key stored;
    std::uint32_t size = 0;
    bool ok = std::fread(tag, 1, sizeof tag, f) == sizeof tag && std::memcmp(tag, kCacheFormat, sizeof tag) == 0 &&
              std::fread(&stored, sizeof stored, 1, f) == 1 && stored.a == k.a && stored.b == k.b &&
              std::fread(&size, sizeof size, 1, f) == 1 && size > 0 && size < (16u << 20);
    std::uint64_t sum = 0;
    ok = ok && std::fread(&sum, sizeof sum, 1, f) == 1;
    if (ok) {
        ok = SUCCEEDED(D3DCreateBlob(size, code)) && std::fread((*code)->GetBufferPointer(), 1, size, f) == size &&
             fnv1a((*code)->GetBufferPointer(), size, 0xcbf29ce484222325ull) == sum; // damaged file -> compile again
        if (!ok && *code) { (*code)->Release(); *code = nullptr; }
    }
    std::fclose(f);
    return ok;
}

void writeCached(const Key& k, ID3DBlob* code) {
    if (cacheFolder().empty() || !code) return;
    const std::wstring file = fileOf(k);
    wchar_t suffix[40];
    swprintf_s(suffix, L".%lu.%lu.tmp", GetCurrentProcessId(), GetCurrentThreadId());
    const std::wstring temp = file + suffix;
    FILE* f = nullptr;
    if (_wfopen_s(&f, temp.c_str(), L"wb") != 0 || !f) return;
    const std::uint32_t size = static_cast<std::uint32_t>(code->GetBufferSize());
    const std::uint64_t sum = fnv1a(code->GetBufferPointer(), size, 0xcbf29ce484222325ull);
    const bool ok = std::fwrite(kCacheFormat, 1, sizeof kCacheFormat, f) == sizeof kCacheFormat &&
                    std::fwrite(&k, sizeof k, 1, f) == 1 && std::fwrite(&size, sizeof size, 1, f) == 1 &&
                    std::fwrite(&sum, sizeof sum, 1, f) == 1 &&
                    std::fwrite(code->GetBufferPointer(), 1, size, f) == size;
    const bool closed = std::fclose(f) == 0;
    // Atomic replace: a reader never sees half a file.
    if (ok && closed && MoveFileExW(temp.c_str(), file.c_str(), MOVEFILE_REPLACE_EXISTING)) gWrites++;
    else DeleteFileW(temp.c_str());
}

} // namespace

HRESULT compileShaderCached(const std::string& source, const char* name, const char* entry, const char* target,
                            unsigned flags, ID3DBlob** code, ID3DBlob** errors, bool* fromCache) {
    *code = nullptr;
    if (errors) *errors = nullptr;
    const Key key = keyOf(source, entry, target, flags);
    if (readCached(key, code)) {
        gHits++;
        if (fromCache) *fromCache = true;
        return S_OK;
    }
    if (fromCache) *fromCache = false;
    gCompiles++;
    const HRESULT hr = D3DCompile(source.data(), source.size(), name, nullptr, nullptr, entry, target, flags, 0, code, errors);
    if (SUCCEEDED(hr)) writeCached(key, *code);
    return hr;
}

bool loadShaderCached(const std::string& source, const char* entry, const char* target, unsigned flags, ID3DBlob** code) {
    *code = nullptr;
    if (!readCached(keyOf(source, entry, target, flags), code)) return false;
    gHits++;
    return true;
}

ShaderCacheStats shaderCacheStats() { return {gHits.load(), gCompiles.load(), gWrites.load()}; }

} // namespace native_three
