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
# MSVC's resource compiler resolves resource filenames against its build directory.
# Copy generated resources there so RCDATA relative paths resolve correctly.
file(COPY "${CMAKE_CURRENT_SOURCE_DIR}/generated/" DESTINATION "${CMAKE_BINARY_DIR}/generated")
# The game script is a separate runtime file. Changing it does NOT rebuild the engine.
file(MAKE_DIRECTORY "${CMAKE_BINARY_DIR}/Release/game")
configure_file("${CMAKE_CURRENT_SOURCE_DIR}/game/scene.js"
               "${CMAKE_BINARY_DIR}/Release/game/scene.js" COPYONLY)

# v0.28 webapp runtime: official Three.js builds + shim + NativeRenderer are
# embedded so any Three.js webapp folder can be opened without a browser.
set(WEBAPP_THREE_DIR "${CMAKE_CURRENT_SOURCE_DIR}/node_modules/three/build" CACHE PATH "three/build folder")
set(WEBAPP_ADDONS_DIR "${WEBAPP_THREE_DIR}/../examples/jsm")
set(WEBAPP_SOURCE_DIR "${CMAKE_CURRENT_SOURCE_DIR}")
if(NOT EXISTS "${WEBAPP_THREE_DIR}/three.module.min.js" OR NOT EXISTS "${WEBAPP_ADDONS_DIR}/controls/OrbitControls.js")
  message(FATAL_ERROR "Run npm install first: webapp mode embeds node_modules/three")
endif()
configure_file(native-dx12/webapp_assets.rc.in "${CMAKE_BINARY_DIR}/webapp_assets.rc" @ONLY)
set(WEBAPP_ASSETS "${CMAKE_BINARY_DIR}/webapp_assets.rc")
set(WEBAPP_RUNTIME native-dx12/webapp_resources.cpp ${WEBAPP_ASSETS})

# Webapp JavaScript backends share webapp_common.cpp (module rules, file access).
add_library(webapp_common STATIC native-dx12/webapp_common.cpp)
target_include_directories(webapp_common PUBLIC native-dx12)
add_library(webapp_quickjs STATIC native-dx12/webapp_host.cpp)
target_link_libraries(webapp_quickjs PUBLIC webapp_common qjs)

# Optional V8 (JIT) backend from the prebuilt pmed/v8-nuget packages:
#   nuget install v8-v143-x64 -Version 13.0.245.25
# Only the webapp JavaScript engine changes; rendering stays DX12.
option(NTB_WEBAPP_V8 "Run webapp JavaScript on V8 instead of QuickJS" OFF)
set(WEBAPP_BACKEND webapp_quickjs)
if(NTB_WEBAPP_V8)
  set(V8_PACKAGE_DIR "" CACHE PATH "v8-v143-x64.<version> NuGet folder")
  set(V8_REDIST_DIR "" CACHE PATH "v8.redist-v143-x64.<version> NuGet folder")
  if(NOT EXISTS "${V8_PACKAGE_DIR}/include/v8.h" OR NOT EXISTS "${V8_REDIST_DIR}/lib/Release")
    message(FATAL_ERROR "NTB_WEBAPP_V8 needs V8_PACKAGE_DIR and V8_REDIST_DIR (pmed/v8-nuget)")
  endif()
  # The package's property sheet carries the V8 build-configuration defines
  # (pointer compression, sandbox …); embedder and V8 must agree on them.
  file(GLOB V8_PROPS "${V8_PACKAGE_DIR}/build/native/*.props")
  file(READ "${V8_PROPS}" V8_PROPS_TEXT)
  string(REGEX MATCH "'Release'\">([^<]*)</PreprocessorDefinitions>" _ "${V8_PROPS_TEXT}")
  string(REPLACE "%(PreprocessorDefinitions)" "" V8_DEFINES "${CMAKE_MATCH_1}")
  message(STATUS "V8 defines: ${V8_DEFINES}")
  file(GLOB V8_LIBS "${V8_PACKAGE_DIR}/lib/Release/*.lib")
  add_library(webapp_v8 STATIC native-dx12/webapp_host_v8.cpp)
  set_target_properties(webapp_v8 PROPERTIES CXX_STANDARD 20 CXX_STANDARD_REQUIRED ON)
  target_compile_options(webapp_v8 PRIVATE /Zc:__cplusplus /permissive-)
  target_include_directories(webapp_v8 PRIVATE "${V8_PACKAGE_DIR}/include")
  target_compile_definitions(webapp_v8 PRIVATE ${V8_DEFINES})
  target_link_libraries(webapp_v8 PUBLIC webapp_common ${V8_LIBS} dbghelp shlwapi winmm)
  set(WEBAPP_BACKEND webapp_v8)
endif()

add_executable(NativeThreeJS WIN32
  native-dx12/NativeThree-DX12.cpp
  native-dx12/three_js_host.cpp
  native-dx12/webapp_dx12.cpp
  native-dx12/webapp_ui_d2d.cpp
  ${WEBAPP_RUNTIME}
  ${ASSETS}
)
target_link_libraries(NativeThreeJS PRIVATE ${WEBAPP_BACKEND})
set_target_properties(NativeThreeJS PROPERTIES OUTPUT_NAME "NativeThree-Diagnostics")
target_include_directories(NativeThreeJS PRIVATE native-dx12)
target_link_libraries(NativeThreeJS PRIVATE qjs d3d12 dxgi d3dcompiler user32 xaudio2 ole32 shell32 d2d1 dwrite windowscodecs shlwapi)
target_compile_definitions(NativeThreeJS PRIVATE UNICODE _UNICODE)
# Webapp JavaScript can recurse deeply; Windows' default 1 MB stack crashed silently.
target_link_options(NativeThreeJS PRIVATE /STACK:67108864)
# Sources are UTF-8 (em dashes in window titles etc.).
target_compile_options(NativeThreeJS PRIVATE /utf-8)

# Headless CI check of the webapp runtime with the same embedded resources.
add_executable(WebappSmoke native-dx12/webapp_smoke.cpp ${WEBAPP_RUNTIME})
target_include_directories(WebappSmoke PRIVATE native-dx12)
target_link_libraries(WebappSmoke PRIVATE webapp_quickjs d3dcompiler user32)
target_compile_definitions(WebappSmoke PRIVATE UNICODE _UNICODE)
target_link_options(WebappSmoke PRIVATE /STACK:67108864)
if(NTB_WEBAPP_V8)
  add_executable(WebappSmokeV8 native-dx12/webapp_smoke.cpp ${WEBAPP_RUNTIME})
  target_include_directories(WebappSmokeV8 PRIVATE native-dx12)
  target_link_libraries(WebappSmokeV8 PRIVATE webapp_v8 d3dcompiler user32)
  target_compile_definitions(WebappSmokeV8 PRIVATE UNICODE _UNICODE)
  target_link_options(WebappSmokeV8 PRIVATE /STACK:67108864)
  # V8 DLLs and ICU data must sit beside the executables.
  foreach(target NativeThreeJS WebappSmokeV8)
    add_custom_command(TARGET ${target} POST_BUILD
      COMMAND ${CMAKE_COMMAND} -E copy_directory "${V8_REDIST_DIR}/lib/Release" "$<TARGET_FILE_DIR:${target}>")
  endforeach()
endif()

add_executable(ThreeSceneSmoke
  native-dx12/three_scene_smoke.cpp
  native-dx12/three_js_host.cpp
  ${ASSETS}
)
target_include_directories(ThreeSceneSmoke PRIVATE native-dx12)
target_link_libraries(ThreeSceneSmoke PRIVATE qjs user32)
target_compile_definitions(ThreeSceneSmoke PRIVATE UNICODE _UNICODE)

# Pure C++ reusable engine subsystems; no Three.js, assets, or DX12 dependency.
add_executable(NativeCoreSmoke native-dx12/core_smoke.cpp)
target_include_directories(NativeCoreSmoke PRIVATE native-dx12)
