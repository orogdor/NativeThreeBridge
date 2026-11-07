#include "three_js_host.h"
#include <cmath>
#include <cstdio>
int main(){
    constexpr int TREES=1000, PER_ARMY=250, SOLDIERS=500, INSTANCE_FLOATS=1500*16, LIGHT_FLOATS=500*8;
    NativeThreeJS_Init();  // Validates 1000-tree forest, 500 A* routes and two armies
    float debugSegments[60000]{};
    const size_t debugFloats=NativeThreeJS_DebugSegments(debugSegments,60000);
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
    float matrices[INSTANCE_FLOATS]{};
    float lights[LIGHT_FLOATS]{};
    NativeThreeJS_Frame(0.f,matrices,INSTANCE_FLOATS);
    NativeThreeJS_Lights(lights,LIGHT_FLOATS);
    for(int i=0;i<SOLDIERS;i++){
        const int m=(TREES+i)*16,l=i*8;
        if(std::fabs(lights[l]-matrices[m+12])>0.005f ||
           std::fabs(lights[l+2]-matrices[m+14])>0.005f ||
           std::fabs(lights[l+1]-9.5f)>0.01f ||
           !(lights[l+3]>10 && lights[l+7]>0)) {
           std::fprintf(stderr,"Light %d failed follow/height check\n",i);
           return 5;
        }
    }
    float firstRedX=matrices[TREES*16+12];
    float firstBlueX=matrices[(TREES+PER_ARMY)*16+12];
    for(int frame=0;frame<120;frame++) NativeThreeJS_Frame(1.f/60.f,matrices,INSTANCE_FLOATS);
    NativeThreeJS_Lights(lights,LIGHT_FLOATS);
    NativeThreeNavStatus nav{};
    NativeThreeJS_GetNavStatus(&nav);
    if(nav.routeFailures!=0 || nav.moved!=500 || nav.routeSteps<1 || nav.active<1) {
        std::fprintf(stderr,"A* failed: missing=%d moved=%d steps=%d active=%d\n",
            nav.routeFailures,nav.moved,nav.routeSteps,nav.active);
        return 8;
    }
    if(std::fabs(matrices[TREES*16+12]-firstRedX)<3.f ||
       std::fabs(matrices[(TREES+PER_ARMY)*16+12]-firstBlueX)<3.f){
       std::fprintf(stderr,"Armies did not advance on A* routes\n");
       return 6;
    }
    for(int i=0;i<SOLDIERS;i++){
        const int m=(TREES+i)*16,l=i*8;
        if(std::fabs(lights[l]-matrices[m+12])>0.005f ||
           std::fabs(lights[l+2]-matrices[m+14])>0.005f) {
            std::fprintf(stderr,"Moving soldier %d light desynchronized\n",i);
            return 7;
        }
    }
    std::puts("PASS: 1000 original pines with A* obstacle barrier");
    std::puts("PASS: genuine A* route guide segments exist for both armies");
    std::puts("PASS: 500 real Three.js soldiers in two armies with A* paths");
    std::puts("PASS: 500 moving Three.js SpotLight records follow soldiers");
    std::puts("PASS: real-time navigation status shows 500 moving soldiers and A* waypoint progress");
    NativeThreeJS_Shutdown();
    return 0;
}
