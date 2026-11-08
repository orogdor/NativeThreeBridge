#pragma once
// Generic distance-driven per-instance gait state. No GPU/JS dependency;
// static instances remain still and each moving instance has its own phase.
#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>

namespace native_three {
template<std::size_t N> class WalkAnimation {
    struct State {
        float phase=0.f, lastX=0.f, lastZ=0.f, strength=0.f;
        bool initialized=false;
    };
    std::array<State,N> states_{};
public:
    // Matrices are consecutive column-major 4x4 transforms (translation at 12,14).
    // Four floats per instance: sin(phase), cos(phase), blend, body bob.
    void update(const float* matrices,float dt,bool enabled,float* out) {
        dt=std::max(0.f,std::min(dt,0.20f));
        for(std::size_t i=0;i<N;i++){
            auto& a=states_[i];
            const float x=matrices[i*16+12],z=matrices[i*16+14];
            float distance=0.f;
            if(!a.initialized){
                a.initialized=true;
                // Golden-angle offset prevents an entire army walking in lockstep.
                a.phase=std::fmod(static_cast<float>(i)*2.39996323f,6.28318531f);
            }else{
                const float dx=x-a.lastX,dz=z-a.lastZ;
                distance=std::sqrt(dx*dx+dz*dz);
                if(distance>6.f)distance=0.f; // teleport/reposition, not a step
            }
            a.lastX=x;a.lastZ=z;
            const float speed=dt>0.00001f?distance/dt:0.f;
            const float target=enabled?std::max(0.f,std::min(speed/7.0f,1.f)):0.f;
            const float t=std::min(1.f,dt*(target>a.strength?10.f:14.f));
            a.strength+=(target-a.strength)*t;
            if(enabled && distance>0.f)
                a.phase=std::fmod(a.phase+distance*1.05f,6.28318531f);
            out[i*4+0]=std::sin(a.phase);
            out[i*4+1]=std::cos(a.phase);
            out[i*4+2]=a.strength;
            out[i*4+3]=(1.f-std::cos(a.phase*2.f))*0.012f*a.strength;
        }
    }
};
} // namespace native_three
