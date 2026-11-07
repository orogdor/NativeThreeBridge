cmake_minimum_required(VERSION 3.21)
project(NativeThreeBridge LANGUAGES C CXX RC)

if(NOT WIN32)
  message(FATAL_ERROR "NativeThreeBridge v0.6 needs Windows + Direct3D 12")
endif()
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Builds the official modern JS runtime with MSVC; no Chromium / WebView.
if(NOT EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/third_party/quickjs/CMakeLists.txt")
  message(FATAL_ERROR "Clone pinned quickjs-ng into third_party/quickjs first")
endif()
set(QJS_ENABLE_INSTALL OFF CACHE BOOL "" FORCE)
set(QJS_BUILD_LIBC OFF CACHE BOOL "" FORCE)
set(QJS_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
add_subdirectory(third_party/quickjs "${CMAKE_BINARY_DIR}/quickjs" EXCLUDE_FROM_ALL)

set(ASSETS "${CMAKE_CURRENT_SOURCE_DIR}/generated/model_assets.rc")
if(NOT EXISTS "${ASSETS}")
  message(FATAL_ERROR "Run tools/pack_kuningriigid.py after esbuild scene bundle")
endif()

add_executable(NativeThreeJS WIN32
  native-dx12/NativeThree-DX12.cpp
  native-dx12/three_js_host.cpp
  ${ASSETS}
)
set_target_properties(NativeThreeJS PROPERTIES OUTPUT_NAME "NativeThree-Diagnostics")
target_include_directories(NativeThreeJS PRIVATE native-dx12)
target_link_libraries(NativeThreeJS PRIVATE qjs d3d12 dxgi d3dcompiler user32)
target_compile_definitions(NativeThreeJS PRIVATE UNICODE _UNICODE)

add_executable(ThreeSceneSmoke
  native-dx12/three_scene_smoke.cpp
  native-dx12/three_js_host.cpp
  ${ASSETS}
)
target_include_directories(ThreeSceneSmoke PRIVATE native-dx12)
target_link_libraries(ThreeSceneSmoke PRIVATE qjs user32)
target_compile_definitions(ThreeSceneSmoke PRIVATE UNICODE _UNICODE)
