#include "../native-dx12/webapp_dx12_guard.h"
#include <array>
#include <cassert>
#include <cstdint>
#include <limits>
#include <vector>

int main() {
    namespace s = native_three::safety;
    std::array<float, 64 + 16 + 56> pass{};
    pass[35] = 1.0f; pass[43] = 1.0f; pass[55] = 7000003.0f;
    assert(s::validPass(pass.data(), pass.size(), 64, 16, 56, 16));
    assert(!s::validPass(pass.data(), pass.size() - 1, 64, 16, 56, 16));
    assert(!s::validPass(nullptr, pass.size(), 64, 16, 56, 16));
    pass[43] = 16'385; assert(!s::validPass(pass.data(), pass.size(), 64, 16, 56, 16));
    pass[43] = std::numeric_limits<float>::quiet_NaN();
    assert(!s::validPass(pass.data(), pass.size(), 64, 16, 56, 16));
    pass[43] = 1; pass[35] = 100;
    assert(!s::validPass(pass.data(), pass.size(), 64, 16, 56, 16));
    pass[35] = 1; pass[55] = std::numeric_limits<float>::infinity();
    assert(!s::validPass(pass.data(), pass.size(), 64, 16, 56, 16));
    pass[55] = 7000003; assert(s::validPass(pass.data(), pass.size(), 64, 16, 56, 16));

    float vertices[3] = {};
    std::uint32_t indices[3] = {0, 1, 2};
    assert(s::validGeometry(vertices, 3, indices, 3));
    assert(!s::validGeometry(nullptr, 3, indices, 3));
    assert(!s::validGeometry(vertices, 3, nullptr, 3));
    assert(!s::validGeometry(vertices, s::kMaxGeometryVertices+1, nullptr, 0));
    assert(s::validInstances(vertices, 1));
    assert(!s::validInstances(nullptr, 1));
    assert(!s::validInstances(vertices, s::kMaxInstances+1));
    assert(s::validDraw(2, 3, 5, 1));
    assert(!s::validDraw(3, 3, 5, 1));
    assert(!s::validDraw(UINT32_MAX, 3, 5, 1));
    assert(!s::validDraw(0, 2, 5, 0));
    assert(s::validTextureDimensions(2048,2048,4));
    assert(!s::validTextureDimensions(16384,16384,4));
    assert(!s::validTextureDimensions(8192,8192,16));
    assert(s::validBufferBytes(1024));
    assert(!s::validBufferBytes(s::kMaxBufferBytes+1));
}
