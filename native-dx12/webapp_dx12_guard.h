#pragma once
// NativeThreeBridge: untrusted JS->DX12 packet and allocation guards.
// Portable on purpose: exercised without loading a GPU driver.
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <limits>

namespace native_three::safety {
constexpr std::size_t kMaxPassFloats = 1'048'576;      // 4 MiB per call
constexpr std::size_t kMaxPassesPerFrame = 128;
constexpr std::uint32_t kMaxDrawsPerPass = 16'384;
constexpr std::uint32_t kMaxGeometryVertices = 2'000'000;
constexpr std::uint32_t kMaxGeometryIndices = 6'000'000;
constexpr std::uint32_t kMaxInstances = 65'536;
constexpr std::uint64_t kMaxBufferBytes = 256ull * 1024 * 1024;
constexpr std::uint64_t kMaxLiveTextureBytes = 1024ull * 1024 * 1024;
constexpr std::uint64_t kMaxLiveGeometryBytes = 2048ull * 1024 * 1024;
constexpr std::uint64_t kMaxLiveInstanceBytes = 256ull * 1024 * 1024;
constexpr std::uint64_t kMaxVertexInvocationsPerFrame = 50'000'000ull;
constexpr std::uint32_t kMaxTextureDimension = 8192;
constexpr std::uint32_t kFenceTimeoutMs = 5000;

inline bool wholeNumber(float v, std::uint32_t maximum) {
    return std::isfinite(v) && v >= 0.0f && v <= float(maximum) && std::floor(v) == v;
}

inline bool validPass(const float* p, std::size_t floats,
                      std::size_t headerFloats, std::size_t lightFloats, std::size_t drawFloats,
                      std::uint32_t maxLights) {
    if (!p || floats < headerFloats || floats > kMaxPassFloats ||
        headerFloats <= 55 || lightFloats == 0 || drawFloats == 0 ||
        !wholeNumber(p[35], maxLights) || !wholeNumber(p[43], kMaxDrawsPerPass) ||
        !wholeNumber(p[55], 16'777'216)) return false;
    const auto lights = std::size_t(p[35]);
    const auto draws = std::size_t(p[43]);
    return headerFloats + lights * lightFloats + draws * drawFloats == floats;
}

inline bool validGeometry(const float* positions, std::uint32_t vertices,
                          const std::uint32_t* indices, std::uint32_t indexCount) {
    return positions && vertices > 0 && vertices <= kMaxGeometryVertices &&
           indexCount <= kMaxGeometryIndices && (indexCount == 0 || indices) &&
           std::uint64_t(vertices) * 12 * sizeof(float) <= kMaxBufferBytes &&
           std::uint64_t(indexCount) * sizeof(std::uint32_t) <= kMaxBufferBytes;
}

inline bool validInstances(const float* matrices, std::uint32_t count) {
    return count <= kMaxInstances && (count == 0 || matrices) &&
           std::uint64_t(count) * 19 * sizeof(float) <= kMaxBufferBytes;
}

inline bool validDraw(std::uint32_t start, std::uint32_t count,
                      std::uint32_t available, std::uint32_t instances) {
    return count > 0 && instances > 0 && start <= available && count <= available - start;
}

inline bool reserveResidentBudget(std::uint64_t live, std::uint64_t replacing,
                                  std::uint64_t incoming, std::uint64_t cap) {
    return replacing <= live && incoming <= cap && live - replacing <= cap - incoming;
}

inline bool reserveTextureBudget(std::uint64_t live, std::uint64_t replacing, std::uint64_t incoming) {
    return reserveResidentBudget(live, replacing, incoming, kMaxLiveTextureBytes);
}

inline bool reserveGeometryBudget(std::uint64_t live, std::uint64_t replacing, std::uint64_t incoming) {
    return reserveResidentBudget(live, replacing, incoming, kMaxLiveGeometryBytes);
}

inline bool reserveInstanceBudget(std::uint64_t live, std::uint64_t replacing, std::uint64_t incoming) {
    return reserveResidentBudget(live, replacing, incoming, kMaxLiveInstanceBytes);
}

inline bool chargeDrawWork(std::uint64_t& used, std::uint32_t vertices, std::uint32_t instances) {
    if (used > kMaxVertexInvocationsPerFrame || vertices == 0 || instances == 0) return false;
    const std::uint64_t work = std::uint64_t(vertices) * instances;
    if (work > kMaxVertexInvocationsPerFrame - used) return false;
    used += work;
    return true;
}

inline bool validBufferBytes(std::uint64_t bytes) {
    return bytes > 0 && bytes <= kMaxBufferBytes;
}

inline bool validTextureDimensions(std::uint32_t width, std::uint32_t height, unsigned bytesPerPixel) {
    return width > 0 && height > 0 &&
           width <= kMaxTextureDimension && height <= kMaxTextureDimension &&
           (bytesPerPixel == 4 || bytesPerPixel == 16) &&
           std::uint64_t(width) * height * bytesPerPixel <= kMaxBufferBytes;
}
} // namespace native_three::safety
