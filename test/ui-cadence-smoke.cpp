#include "../native-dx12/ui_cadence.h"
#include <cassert>
#include <cmath>

int main() {
    native_three::UiCadence ui(30.0);
    assert(ui.due(0.0));
    assert(!ui.due(16.0));
    assert(!ui.due(33.0));
    assert(ui.due(34.0));
    assert(!ui.due(50.0));
    ui.force();  // click / key / resize
    assert(ui.due(51.0));
    assert(!ui.due(52.0));
    ui.reset();  // new game: always paint first frame
    assert(ui.due(0.0));
    ui.setHz(0.0); // legacy mode: paint each frame
    assert(ui.due(0.0));
    assert(ui.due(1.0));
    assert(ui.due(2.0));
    ui.setHz(60.0);
    assert(ui.due(0.0));
    assert(ui.due(17.0));
    assert(ui.due(1.0)); // clock jump backwards resets timing
    assert(ui.due(std::nan("")));
    return 0;
}
