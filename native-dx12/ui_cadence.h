// Separate the UI refresh cadence from the 3D frame clock.
// Pure C++ helper: no D3D dependencies so the timing policy can be unit tested.
#pragma once
#include <cmath>

namespace native_three {
class UiCadence {
public:
    explicit UiCadence(double hz = 30.0) { setHz(hz); }

    // A rate of zero means legacy mode: refresh the UI on every 3D frame.
    void setHz(double hz) {
        intervalMs_ = std::isfinite(hz) && hz > 0.0 ? 1000.0 / hz : 0.0;
        reset();
    }

    bool due(double nowMs) {
        if (!std::isfinite(nowMs)) return true;
        if (urgent_ || lastMs_ < 0.0 || intervalMs_ == 0.0 ||
            nowMs < lastMs_ || nowMs - lastMs_ + 0.001 >= intervalMs_) {
            lastMs_ = nowMs;
            urgent_ = false;
            return true;
        }
        return false;
    }

    void force() { urgent_ = true; }
    void reset() { lastMs_ = -1.0; urgent_ = true; }
    double intervalMs() const { return intervalMs_; }

private:
    double intervalMs_ = 0.0;
    double lastMs_ = -1.0;
    bool urgent_ = true;
};
} // namespace native_three
