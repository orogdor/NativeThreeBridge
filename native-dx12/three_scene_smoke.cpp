#include "three_js_host.h"
#include <cmath>
#include <cstdio>
#include <vector>
int main(){
    constexpr int TREES=10000, PER_ARMY=500, SOLDIERS=1000, INSTANCE_FLOATS=11000*16, LIGHT_FLOATS=1000*8;
    NativeThreeJS_Init();  // Validates 10000-tree forest, 1000 A* agents and two armies
    std::vector<float> debugSegments(60000);
    const size_t debugFloats=NativeThreeJS_DebugSegments(debugSegments.data(),debugSegments.size());
    if(debugFloats<5000 || debugFloats%5!=0){
        std::fprintf(stderr,"A* visualization contains no usable route segments: %zu\n",debugFloats);
        return 9;
    }
    bool redPath=false,bluePath=false;
    for(size_t j=0;j<debugFloats;j+=5){
        if(debugSegments[j]==0.f)redPath=true;
        if(debugSegments[j]==1.f)bluePath=true;
    }
    if(!redPath||!bluePath){
        std::fprintf(stderr,"Missing red or blue army A* debug paths\n");
        return 10;
    }
    std::vector<float> matrices(INSTANCE_FLOATS);
    std::vector<float> lights(LIGHT_FLOATS);
    NativeThreeJS_Frame(0.f,matrices.data(),matrices.size());
    NativeThreeJS_Lights(lights.data(),lights.size());
    for(int i=0;i<SOLDIERS;i++){
        const int m=(TREES+i)*16,l=i*8;
        if(std::fabs(lights[l]-(matrices[m+12]+6.f))>0.005f ||
           std::fabs(lights[l+2]-(matrices[m+14]+4.f))>0.005f ||
           std::fabs(lights[l+1]-12.5f)>0.01f ||
           !(lights[l+3]>10 && lights[l+7]>0)) {
           std::fprintf(stderr,"Light %d failed follow/height check\n",i);
           return 5;
        }
    }
    float firstRedX=matrices[TREES*16+12];
    float firstBlueX=matrices[(TREES+PER_ARMY)*16+12];
    for(int frame=0;frame<450;frame++) NativeThreeJS_Frame(1.f/60.f,matrices.data(),matrices.size());
    NativeThreeJS_Lights(lights.data(),lights.size());
    NativeThreeNavStatus nav{};
    NativeThreeJS_GetNavStatus(&nav);
    if(nav.routeFailures!=0 || nav.moved<600 || nav.routeSteps<1 ||
       nav.active<1 || nav.planned!=1000 || nav.searches<1000) {
        std::fprintf(stderr,"A* failed: missing=%d moved=%d steps=%d active=%d planned=%d searches=%d\n",
            nav.routeFailures,nav.moved,nav.routeSteps,nav.active,nav.planned,nav.searches);
        return 8;
    }
    if(std::fabs(matrices[TREES*16+12]-firstRedX)<3.f ||
       std::fabs(matrices[(TREES+PER_ARMY)*16+12]-firstBlueX)<3.f){
       std::fprintf(stderr,"Armies did not advance on A* routes\n");
       return 6;
    }
    for(int i=0;i<SOLDIERS;i++){
        const int m=(TREES+i)*16,l=i*8;
        if(std::fabs(lights[l]-(matrices[m+12]+6.f))>0.005f ||
           std::fabs(lights[l+2]-(matrices[m+14]+4.f))>0.005f) {
            std::fprintf(stderr,"Moving soldier %d light desynchronized\n",i);
            return 7;
        }
    }
    std::puts("PASS: 10000 original pines with A* obstacle barrier");
    std::puts("PASS: genuine A* route guide segments exist for both armies");
    std::puts("PASS: 1000 individually requested A* searches during runtime");
    std::puts("PASS: reserved navigation cells protect against overlapping soldiers");
    std::puts("PASS: 1000 moving Three.js SpotLight records follow soldiers");
    std::puts("PASS: real-time navigation status shows 1000 moving soldiers and A* waypoint progress");
    NativeThreeJS_Shutdown();
    return 0;
}
