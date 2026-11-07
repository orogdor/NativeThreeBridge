#pragma once
#include <cstddef>

// Owns a real QuickJS-NG runtime executing the bundled official Three.js classes.
// Data copied from THREE.InstancedMesh world matrices into DX12's upload buffer.
void NativeThreeJS_Init();
void NativeThreeJS_Frame(float deltaSeconds, float *outMatrices, std::size_t floatCapacity);
// 20 moving Three.js SpotLight records: xyz, distance, rgb, intensity.
void NativeThreeJS_Lights(float *outLights, std::size_t floatCapacity);
struct NativeThreeNavStatus {
    int routeFailures=0;
    int moved=0;
    int active=0;
    int arrived=0;
    int routeSteps=0;
};
void NativeThreeJS_GetNavStatus(NativeThreeNavStatus *out);
// Colored A* route segments: [army,x1,z1,x2,z2] per segment.
std::size_t NativeThreeJS_DebugSegments(float *outSegments, std::size_t floatCapacity);
void NativeThreeJS_Shutdown();
