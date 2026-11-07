#pragma once
#include <cstddef>

// Owns a real QuickJS-NG runtime executing the bundled official Three.js classes.
// Data copied from THREE.InstancedMesh world matrices into DX12's upload buffer.
void NativeThreeJS_Init();
void NativeThreeJS_Frame(float deltaSeconds, float *outMatrices, std::size_t floatCapacity);
// 20 moving Three.js SpotLight records: xyz, distance, rgb, intensity.
void NativeThreeJS_Lights(float *outLights, std::size_t floatCapacity);
void NativeThreeJS_Shutdown();
