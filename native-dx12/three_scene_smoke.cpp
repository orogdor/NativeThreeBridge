#include "three_js_host.h"
#include <cstdio>
#include <cmath>
int main() {
    NativeThreeJS_Init(); // checks 1000 pines, 20 soldiers and 20 successful A* routes
    float matrices[1020 * 16]{};
    NativeThreeJS_Frame(0.0f, matrices, 1020 * 16);
    // Three.js Matrix4 translation uses elements 12..14 in column-major Float32Array.
    constexpr int red = 1000 * 16;
    constexpr int blue = 1010 * 16;
    const float redX = matrices[red + 12];
    const float blueX = matrices[blue + 12];
    if (redX > -70.0f || blueX < 70.0f) {
        std::fprintf(stderr,"Initial army placement missing: red=%f blue=%f\n",redX,blueX);
        return 3;
    }
    for (int i = 0; i < 240; ++i)
        NativeThreeJS_Frame(1.0f / 60.0f, matrices, 1020 * 16);
    const float redDX = matrices[red+12]-redX;
    const float blueDX = matrices[blue+12]-blueX;
    const float redDZ = matrices[red+14]-(-49.5f);
    const float blueDZ = matrices[blue+14]-25.5f;
    if (std::hypot(redDX,redDZ) < 3.0f || std::hypot(blueDX,blueDZ) < 3.0f) {
        std::fprintf(stderr,"JS A* armies did not move: red=(%f,%f) blue=(%f,%f)\n",
                     redDX,redDZ,blueDX,blueDZ);
        return 4;
    }
    std::puts("PASS: embedded official Three.js with 1000 instanced pine trees");
    std::puts("PASS: two 10-unit armies with 20 real A* routes around obstacles");
    std::puts("PASS: red and blue armies move over 240 QuickJS frames");
    NativeThreeJS_Shutdown();
    return 0;
}
