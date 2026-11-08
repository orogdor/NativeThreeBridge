#pragma once
#include <cstddef>
#include "native_audio_core.h"

// Owns a real QuickJS-NG runtime executing the bundled official Three.js classes.
// Data copied from THREE.InstancedMesh world matrices into DX12's upload buffer.
void NativeThreeJS_Init();
void NativeThreeJS_Frame(float deltaSeconds, float *outMatrices, std::size_t floatCapacity);
// Generic incremental ABI: copy matrices starting at an instance offset.
// The caller must keep the earlier matrices initialized/persistent.
// Pass 0 for a full state refresh; this is not tied to any game object type.
void NativeThreeJS_FrameFrom(float deltaSeconds, float *outMatrices,
                             std::size_t floatCapacity, std::size_t firstChangedInstance);
// 20 moving Three.js SpotLight records: xyz, distance, rgb, intensity.
void NativeThreeJS_Lights(float *outLights, std::size_t floatCapacity);
struct NativeThreeNavStatus {
    int routeFailures=0;
    int moved=0;
    int active=0;
    int arrived=0;
    int routeSteps=0;
    int searches=0;
    int replans=0;
    int blockedMoves=0;
    int planned=0;
};
void NativeThreeJS_GetNavStatus(NativeThreeNavStatus *out);
// Colored A* route segments: [army,x1,z1,x2,z2] per segment.
std::size_t NativeThreeJS_DebugSegments(float *outSegments, std::size_t floatCapacity);
void NativeThreeJS_Shutdown();
// Native window command: completely re-create the original Three.js scene.
void NativeThreeJS_Restart();

// Lossless JS-to-native audio events. C++ drives XAudio2; the JS scene never
// needs AudioContext, media decoding or an embedded web browser.
std::size_t NativeThreeJS_PopAudioCommands(native_three::AudioCommand* out,
                                          std::size_t capacity);
// Explicit UI/F10 test: asks scene.js to send a named audio event via the bridge.
bool NativeThreeJS_TriggerAudioTest();

// 1000 four-float combat animation states: swing, recoil, death pose, stance.
// Kept separate from walk data so both can be animated by the vertex shader.
void NativeThreeJS_CombatStates(float *out, std::size_t floatCapacity);
struct NativeThreeBattleStatus {
    int aliveRed=500,aliveBlue=500,deaths=0,hits=0,attacks=0;
    int engaged=0,frontHits=0,sideHits=0,rearHits=0;
    int winner=-1,returning=0,returned=0;
};
void NativeThreeJS_GetBattleStatus(NativeThreeBattleStatus* out);
bool NativeThreeJS_QuickBattle(); // F12: relocate a test detachment into melee
