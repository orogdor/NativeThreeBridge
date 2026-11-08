#pragma once
// Common deterministic fixed-timestep accumulator. The renderer can interpolate
// between the previous and current simulation transforms without tying game
// physics or AI to refresh rate.
#include <algorithm>
#include <cmath>
namespace native_three {
class FixedStepper {
public:
    explicit FixedStepper(double fixedSeconds=1.0/60.0,unsigned maxSteps=4):
        fixed_(fixedSeconds>0.0?fixedSeconds:1.0/60.0),
        maxSteps_(std::max(1u,maxSteps)) {}
    template<class Callback>
    float advance(double elapsedSeconds,Callback&& step) {
        if(!std::isfinite(elapsedSeconds))elapsedSeconds=0.0;
        accumulator_+=std::max(0.0,std::min(elapsedSeconds,0.20));
        unsigned ticks=0;
        while(accumulator_+1.e-10>=fixed_ && ticks<maxSteps_) {
            step(fixed_);accumulator_-=fixed_;++ticks;
        }
        if(ticks==maxSteps_ && accumulator_>=fixed_) {
            // Drop excess debt instead of allowing an infinite catch-up spiral.
            accumulator_=std::fmod(accumulator_,fixed_);
        }
        return (float)std::max(0.0,std::min(1.0,accumulator_/fixed_));
    }
    double stepSeconds() const{return fixed_;}
private:
    double fixed_;
    unsigned maxSteps_;
    double accumulator_=0.0;
};
} // namespace native_three
