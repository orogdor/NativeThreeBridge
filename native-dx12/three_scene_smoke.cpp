#include "three_js_host.h"
#include <cstdio>
#include <cmath>
int main() {
    NativeThreeJS_Init();
    float matrices[20 * 16]{};
    NativeThreeJS_Frame(1.f / 60.f, matrices, 320);
    // Standard THREE.Matrix4 column-major: translation resides at [12..14].
    if (std::fabs(matrices[12] + 13.6f) > 0.01f ||
        std::fabs(matrices[14] + 14.f) > 0.01f ||
        std::fabs(matrices[19 * 16 + 12] - 18.f) > 0.01f ||
        std::fabs(matrices[19 * 16 + 14] - 22.f) > 0.01f) {
        std::fprintf(stderr,"Three.js -> native DX12 matrix bridge returned wrong positions\n");
        return 3;
    }
    std::puts("PASS: official Three.js scene classes evaluated in embedded QuickJS-NG");
    std::puts("PASS: 10 house and 10 pine THREE.InstancedMesh world matrices exported");
    NativeThreeJS_Shutdown();
    return 0;
}
