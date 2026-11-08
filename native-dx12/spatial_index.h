#pragma once
// General-purpose 2D spatial index for static or dynamic scene instances.
// Stores stable object IDs; never assumes an object is a tree, soldier or light.
#include <cmath>
#include <cstdint>
#include <unordered_map>
#include <vector>
#include <utility>

namespace native_three {
struct SpatialItem {
    std::uint32_t id;
    float x;
    float z;
};
class SpatialIndex2D {
public:
    explicit SpatialIndex2D(float chunkSize=36.f):chunkSize_(chunkSize>0?chunkSize:36.f) {}
    void clear() { chunks_.clear(); itemCount_=0; }
    // Reuse previously allocated chunk vectors for moving objects instead
    // of allocating/freeing hundreds of per-frame STL vectors.
    void beginFrame(){
        for(auto& kv:chunks_)kv.second.clear();
        itemCount_=0;
    }
    void reserve(std::size_t chunks) { chunks_.reserve(chunks); }
    void insert(std::uint32_t id,float x,float z) {
        if(!std::isfinite(x)||!std::isfinite(z))return;
        chunks_[key(cell(x),cell(z))].push_back({id,x,z});
        ++itemCount_;
    }
    std::size_t size() const {return itemCount_;}
    std::size_t chunkCount() const {return chunks_.size();}
    float chunkSize() const {return chunkSize_;}
    template<class Visitor>
    void forEachChunk(Visitor&& visitor) const {
        for(const auto& kv:chunks_) {
            const auto coords=unpack(kv.first);
            visitor(coords.first,coords.second,kv.second);
        }
    }
    // Iterates candidates in all cells touching the AABB. Callers can do exact
    // distance or frustum tests; objects never get duplicated.
    template<class Visitor>
    void queryAabb(float minX,float minZ,float maxX,float maxZ,Visitor&& visitor) const {
        if(!std::isfinite(minX)||!std::isfinite(minZ)||
           !std::isfinite(maxX)||!std::isfinite(maxZ)||
           minX>maxX||minZ>maxZ)return;
        const int x0=cell(minX),x1=cell(maxX),z0=cell(minZ),z1=cell(maxZ);
        for(int z=z0;z<=z1;z++)for(int x=x0;x<=x1;x++){
            auto it=chunks_.find(key(x,z));
            if(it==chunks_.end())continue;
            for(const auto& item:it->second)visitor(item);
        }
    }
    template<class Visitor>
    void queryRadius(float x,float z,float radius,Visitor&& visitor) const {
        if(radius<0 || !std::isfinite(radius))return;
        const float dist2=radius*radius;
        queryAabb(x-radius,z-radius,x+radius,z+radius,[&](const SpatialItem& item){
            const float dx=item.x-x,dz=item.z-z;
            if(dx*dx+dz*dz<=dist2)visitor(item);
        });
    }
private:
    float chunkSize_;
    std::size_t itemCount_=0;
    std::unordered_map<std::uint64_t,std::vector<SpatialItem>> chunks_;
    int cell(float value) const {return (int)std::floor((double)value/(double)chunkSize_);}
    static std::uint64_t key(int x,int z) {
        return (std::uint64_t)(std::uint32_t)x<<32 | (std::uint32_t)z;
    }
    static std::pair<int,int> unpack(std::uint64_t k) {
        return {static_cast<std::int32_t>(k>>32),static_cast<std::int32_t>(k&0xffffffffu)};
    }
};
} // namespace native_three
