#include "scene_registry.h"
#include "spatial_index.h"
#include "navigation_service.h"
#include "fixed_stepper.h"
#include <algorithm>
#include <cassert>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <thread>
#include <vector>
#include <unordered_set>

using namespace native_three;
int main(){
    SceneRegistry scene;
    const auto mesh=scene.create(ObjectKind::Mesh,-10.f,0.f,3.f);
    const auto light=scene.create(ObjectKind::Light,4.f,6.f,8.f);
    assert(scene.size()==2 && scene.get(mesh)&&scene.get(light));
    assert(scene.setPosition(light,5.f,6.f,8.f));
    unsigned changed=0;
    scene.consumeChanges([&](ObjectHandle, const SceneRecord& rec){
        assert(rec.alive);changed++;
    });
    assert(changed==2);
    scene.setPosition(light,5.f,6.f,8.f); // unchanged must not emit twice
    scene.consumeChanges([&](ObjectHandle,const SceneRecord&){assert(false);});
    assert(scene.destroy(mesh)&&!scene.get(mesh));
    const auto newer=scene.create(ObjectKind::Agent,3.f,0.f,3.f);
    assert(newer.slot==mesh.slot && newer.generation!=mesh.generation);
    assert(!scene.setPosition(mesh,1,2,3)); // stale handle

    SpatialIndex2D trees(36.f);
    for(unsigned i=0;i<10000;i++){
        const float x=-480.f+(i%100)*9.6f;
        const float z=-480.f+(i/100)*9.6f;
        trees.insert(i,x,z);
    }
    assert(trees.size()==10000);
    unsigned matched=0;
    trees.queryRadius(-460.f,-460.f,50.f,[&](const SpatialItem& v){
        ++matched;
        const float x=v.x+460,z=v.z+460;
        assert(x*x+z*z<=2500.01f);
    });
    assert(matched>0 && matched<100);
    unsigned negative=0;
    trees.queryAabb(-482.f,-482.f,-470.f,-470.f,[&](const SpatialItem&){negative++;});
    assert(negative>0);

    FixedStepper stepper(1.0/60.0,4);
    unsigned simTicks=0;
    for(int f=0;f<120;f++)stepper.advance(1.0/120.0,[&](double dt){
        assert(std::abs(dt-1.0/60.0)<1.e-9);simTicks++;
    });
    assert(simTicks==60);
    stepper.advance(4.0,[&](double){++simTicks;});
    assert(simTicks<=64); // bound the catchup work after an extended stall

    // Generic asynchronous A* never needs DirectX or a Three.js game runtime.
    constexpr unsigned W=48,H=48;
    std::vector<std::uint8_t> obstacles(W*H,0);
    for(unsigned z=0;z<H;z++)if(z!=24)obstacles[z*W+24]=1;
    NavigationService nav(2);
    nav.setMap(W,H,std::move(obstacles));
    std::unordered_set<std::uint64_t> expected;
    for(unsigned i=0;i<30;i++)
        expected.insert(nav.request((i+2)*W+2,(i+2)*W+44,i<5));
    const auto deadline=std::chrono::steady_clock::now()+std::chrono::seconds(8);
    while(!expected.empty()&&std::chrono::steady_clock::now()<deadline){
        RouteResult result;
        if(!nav.poll(result)){
            std::this_thread::sleep_for(std::chrono::milliseconds(2));continue;
        }
        assert(expected.erase(result.token)==1);
        assert(result.status==RouteStatus::Found);
        assert(!result.cells.empty());
        for(auto c:result.cells){
            assert(c<W*H);
            assert(c%W!=24 || c/W==24);
        }
    }
    assert(expected.empty());
    assert(nav.pending()==0);
    std::printf("PASS: deterministic fixed simulation scheduling and bounded catchup\\n");
    std::printf("PASS: native scene handles and dirty tracking\n");
    std::printf("PASS: 10000-object spatial index and exact proximity results\n");
    std::printf("PASS: 30 multithreaded non-blocking routes through narrow passage\n");
    return 0;
}
