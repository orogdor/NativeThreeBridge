#pragma once
// Reusable LOD policy; independent of mesh type and rendering backend.
// Screenspace height is a fraction of viewport height. Selection hysteresis
// prevents flicker when cameras hover around a distance threshold.
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <unordered_map>
namespace native_three {
class LodPolicy {
public:
    // Tier 0 = most detailed; Tier 3 = impostor/lowest detail.
    explicit LodPolicy(std::array<float,3> thresholds={0.10f,0.035f,0.008f},
                       float hysteresis=0.12f):
        thresholds_(thresholds),hysteresis_(std::clamp(hysteresis,0.f,0.5f)){}
    std::uint8_t choose(std::uint64_t instanceId,float screenHeight) {
        if(!std::isfinite(screenHeight))screenHeight=0;
        screenHeight=std::max(0.f,screenHeight);
        const std::uint8_t target=screenHeight>=thresholds_[0]?0:
                                  screenHeight>=thresholds_[1]?1:
                                  screenHeight>=thresholds_[2]?2:3;
        auto found=previous_.find(instanceId);
        if(found==previous_.end()){
            previous_[instanceId]=target;return target;
        }
        std::uint8_t current=found->second;
        if(target>current) {
            const float border=thresholds_[current];
            if(screenHeight < border*(1.f-hysteresis_))current=target;
        } else if(target<current) {
            const float border=thresholds_[target];
            if(screenHeight > border*(1.f+hysteresis_))current=target;
        }
        found->second=current;
        return current;
    }
    void forget(std::uint64_t instanceId){previous_.erase(instanceId);}
    void reset(){previous_.clear();}
private:
    std::array<float,3> thresholds_;
    float hysteresis_;
    std::unordered_map<std::uint64_t,std::uint8_t> previous_;
};
} // namespace native_three
