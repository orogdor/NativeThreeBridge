#pragma once
// Stable ID + generation scene registry. The renderer, physics, streaming and
// navigation systems can share handles without any game-specific object types.
#include <cstdint>
#include <vector>
#include <limits>
#include <cmath>

namespace native_three {
enum class ObjectKind : std::uint8_t { Mesh, Light, Agent, Camera, Collider, Other };
struct ObjectHandle {
    std::uint32_t slot=std::numeric_limits<std::uint32_t>::max();
    std::uint32_t generation=0;
    bool operator==(const ObjectHandle& other) const {
        return slot==other.slot && generation==other.generation;
    }
};
struct SceneRecord {
    ObjectKind kind=ObjectKind::Other;
    float x=0,y=0,z=0;
    std::uint32_t generation=1;
    bool alive=false,dirty=false;
};
class SceneRegistry {
public:
    ObjectHandle create(ObjectKind kind,float x,float y,float z) {
        std::uint32_t slot;
        if(!free_.empty()){slot=free_.back();free_.pop_back();}
        else {slot=(std::uint32_t)records_.size();records_.push_back({});}
        auto& rec=records_[slot];
        rec.kind=kind;rec.x=x;rec.y=y;rec.z=z;rec.alive=true;
        rec.dirty=false;markDirty(slot);++live_;
        return {slot,rec.generation};
    }
    bool destroy(ObjectHandle h) {
        auto* rec=getMutable(h);
        if(!rec)return false;
        rec->alive=false;rec->dirty=false;
        if(++rec->generation==0)rec->generation=1;
        free_.push_back(h.slot);--live_;
        return true;
    }
    bool setPosition(ObjectHandle h,float x,float y,float z) {
        auto* rec=getMutable(h);
        if(!rec||!std::isfinite(x)||!std::isfinite(y)||!std::isfinite(z))
            return false;
        if(rec->x!=x || rec->y!=y || rec->z!=z){
            rec->x=x;rec->y=y;rec->z=z;
            markDirty(h.slot);
        }
        return true;
    }
    const SceneRecord* get(ObjectHandle h) const {
        if(h.slot>=records_.size())return nullptr;
        const auto& r=records_[h.slot];
        return r.alive && r.generation==h.generation?&r:nullptr;
    }
    std::size_t size() const {return live_;}
    // Called by renderer after processing a batch of created/changed objects.
    template<class Visitor>
    void consumeChanges(Visitor&& visitor) {
        for(auto id:dirtySlots_){
            auto& rec=records_[id];
            if(rec.dirty && rec.alive)visitor(ObjectHandle{id,rec.generation},rec);
            rec.dirty=false;
        }
        dirtySlots_.clear();
    }
private:
    std::vector<SceneRecord> records_;
    std::vector<std::uint32_t> free_,dirtySlots_;
    std::size_t live_=0;
    SceneRecord* getMutable(ObjectHandle h) {
        return const_cast<SceneRecord*>(static_cast<const SceneRegistry*>(this)->get(h));
    }
    void markDirty(std::uint32_t slot) {
        auto& rec=records_[slot];
        if(!rec.dirty){rec.dirty=true;dirtySlots_.push_back(slot);}
    }
};
} // namespace native_three
