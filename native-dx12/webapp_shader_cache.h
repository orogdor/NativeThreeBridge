#pragma once
// D3DCompile with an on-disk cache of the compiled bytecode, so a game's
// shaders are compiled once per machine and engine version instead of on
// every start (compiling one material variant takes 0.2 - 1 s).
// Cache folder: %LOCALAPPDATA%\NativeThreeBridge\shader-cache (env
// NTB_SHADER_CACHE=0 turns it off).
#include <d3dcommon.h>
#include <string>

namespace native_three {

struct ShaderCacheStats { unsigned hits = 0, compiles = 0, writes = 0; };

HRESULT compileShaderCached(const std::string& source, const char* name, const char* entry, const char* target,
                            unsigned flags, ID3DBlob** code, ID3DBlob** errors, bool* fromCache = nullptr);
// Only the cache: true and the bytecode when it was compiled before.
bool loadShaderCached(const std::string& source, const char* entry, const char* target, unsigned flags, ID3DBlob** code);
ShaderCacheStats shaderCacheStats();

} // namespace native_three
