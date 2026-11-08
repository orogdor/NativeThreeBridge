#include "scene_registry.h"
#include "spatial_index.h"
#include "navigation_service.h"
#include "fixed_stepper.h"
#include "lod_policy.h"
#include "native_css_style.h"
#include "native_audio_core.h"
#include "walk_animation.h"
#include "transform_interpolation.h"
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
    // Portable CSS/markup translator tests: no browser, Win32 or GPU needed.
    const std::string buttonHtml=R"(<button id="restart-button">Reset battle</button>)";
    const std::string buttonCss=R"(
       /* CSS is the source of the native control's styling */
       #restart-button {
         right: 27px; top: 19px; width: 164px; height: 46px;
         background-color: #20415a; color: #eefaff;
         border-color: #3c9ac1; border-radius: 12px;
         font-size: 17px; font-weight: bold;
       }
       #restart-button:hover { color: #000000; }
    )";
    const auto cssButton=native_three::parseNativeButton(buttonHtml,buttonCss);
    if(cssButton.id!="restart-button" || cssButton.text!="Reset battle" ||
       cssButton.right!=27 || cssButton.top!=19 || cssButton.width!=164 ||
       cssButton.height!=46 || cssButton.background!=0x20415a ||
       cssButton.foreground!=0xeefaff || cssButton.radius!=12 ||
       cssButton.fontSize!=17 || !cssButton.bold) {
        std::fprintf(stderr,"Native CSS button translator produced incorrect values\n");
        return 55;
    }
    const auto defaultButton=native_three::parseNativeButton("","bad CSS");
    if(defaultButton.width<120 || defaultButton.text!="Restart")return 56;

    // Native sound is an independent engine service: safe WAV decoding,
    // sound-ID sandboxing and spatial attenuation can be tested without a GPU.
    assert(legalAudioAsset("battle_footstep-01"));
    assert(!legalAudioAsset("../secrets"));
    assert(!legalAudioAsset("bad.wav"));
    std::vector<std::uint8_t> wav(48,0);
    std::memcpy(wav.data(),"RIFF",4);
    std::memcpy(wav.data()+8,"WAVEfmt ",8);
    std::memcpy(wav.data()+36,"data",4);
    auto put16=[&](std::size_t at,unsigned n){
        wav[at]=(std::uint8_t)(n&255);
        wav[at+1]=(std::uint8_t)((n>>8)&255);
    };
    auto put32=[&](std::size_t at,unsigned n){
        put16(at,n&65535);put16(at+2,(n>>16)&65535);
    };
    put32(4,40);put32(16,16);put16(20,1);put16(22,1);
    put32(24,48000);put32(28,96000);put16(32,2);put16(34,16);
    put32(40,4);put16(44,1000);put16(46,2000);
    const auto sound=decodePcmWave(wav.data(),wav.size());
    assert(sound.valid()&&sound.channels==1 && sound.sampleRate==48000);
    assert(sound.pcm.size()==4);
    wav[20]=3; // format 3 is IEEE float, not PCM16; must be rejected
    assert(!decodePcmWave(wav.data(),wav.size()).valid());
    wav[20]=1;
    put32(40,100000); // malicious/truncated chunk
    assert(!decodePcmWave(wav.data(),wav.size()).valid());
    const auto centered=spatialAudioMix(0,0,0,0,0,0.8f,true);
    const auto right=spatialAudioMix(0,0,0,50,0,0.8f,true);
    const auto far=spatialAudioMix(0,0,0,800,0,0.8f,true);
    assert(std::abs(centered.left-centered.right)<0.0001f);
    assert(right.right>right.left && right.attenuation>far.attenuation);
    assert(spatialAudioMix(0,0,0,800,0,0.8f,false).attenuation==1.f);

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

    // Regression: 60 Hz simulation, >100 Hz render. Character and camera
    // must see the same sub-frame interpolation, including yaw wrapping.
    auto yawMatrix=[](float theta,float x,float* m){
        std::fill_n(m,16,0.f);
        const float sn=std::sin(theta),cs=std::cos(theta);
        m[0]=cs;m[2]=-sn;m[5]=1.f;m[8]=sn;m[10]=cs;
        m[12]=x;m[15]=1.f;
    };
    float poseA[16]{},poseB[16]{},smoothed[16]{};
    yawMatrix(0,0,poseA);
    yawMatrix(1.57079632679f,10,poseB);
    interpolateAffine(poseA,poseB,0.5f,smoothed);
    if(std::abs(smoothed[12]-5.f)>0.001f ||
       std::abs(smoothed[0]-0.7071068f)>0.002f ||
       std::abs(smoothed[8]-0.7071068f)>0.002f)
        return 61; // half-step translation and yaw at render time
    interpolateAffine(poseA,poseB,0.f,smoothed);
    if(smoothed[12]!=poseA[12]||smoothed[8]!=poseA[8])return 62;
    interpolateAffine(poseA,poseB,1.f,smoothed);
    if(smoothed[12]!=poseB[12]||smoothed[8]!=poseB[8])return 63;
    yawMatrix(3.12413936f,0,poseA);  // +179 degrees
    yawMatrix(-3.12413936f,0,poseB); // -179 degrees
    interpolateAffine(poseA,poseB,0.5f,smoothed);
    if(smoothed[0]>-0.999f || std::abs(smoothed[8])>0.02f)
        return 64; // shortest arc, not 358-degree back rotation
    yawMatrix(0,0,poseA);
    std::copy_n(poseA,16,poseB);
    poseB[5]=0;poseB[6]=1;poseB[9]=-1;poseB[10]=0; // X-axis tilt
    interpolateAffine(poseA,poseB,0.5f,smoothed);
    if(std::abs(smoothed[5]-0.7071068f)>0.003f ||
       std::abs(smoothed[6]-0.7071068f)>0.003f)
        return 65; // generic rotated game objects, not just yaw soldiers
    std::puts("PASS: sub-frame affine and shortest-arc rotation interpolation");

    FixedStepper stepper(1.0/60.0,4);
    unsigned simTicks=0;
    for(int f=0;f<120;f++)stepper.advance(1.0/120.0,[&](double dt){
        assert(std::abs(dt-1.0/60.0)<1.e-9);simTicks++;
    });
    assert(simTicks==60);
    stepper.advance(4.0,[&](double){++simTicks;});
    assert(simTicks<=64); // bound the catchup work after an extended stall

    // Gait is distance driven: idle is still, each mover has its own
    // phase, and stopping/turning animation off fades it out.
    WalkAnimation<2> walk;
    std::array<float,32> agentMatrices{};
    std::array<float,8> gait{};
    agentMatrices[16+12]=20.f; // two distinct world positions
    walk.update(agentMatrices.data(),1.f/60.f,true,gait.data());
    assert(gait[2]==0.f && gait[6]==0.f);
    const float idleSin=gait[0];
    agentMatrices[12]+=0.17f;
    walk.update(agentMatrices.data(),1.f/60.f,true,gait.data());
    assert(gait[2]>0.f && gait[2]<=1.f);
    assert(gait[6]==0.f);
    assert(gait[0]!=idleSin && gait[0]!=gait[4]);
    for(int f=0;f<45;f++)walk.update(agentMatrices.data(),1.f/60.f,true,gait.data());
    assert(gait[2]<0.001f);
    agentMatrices[16+14]+=0.17f;
    walk.update(agentMatrices.data(),1.f/60.f,true,gait.data());
    assert(gait[6]>0.f);
    for(int f=0;f<45;f++)walk.update(agentMatrices.data(),1.f/60.f,false,gait.data());
    assert(gait[2]<0.001f && gait[6]<0.001f);

    LodPolicy lod;
    assert(lod.choose(123,0.25f)==0);
    assert(lod.choose(123,0.095f)==0); // hysteresis blocks flicker
    assert(lod.choose(123,0.05f)==1);
    assert(lod.choose(123,0.001f)==3);
    lod.forget(123);
    assert(lod.choose(123,0.03f)==2);
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
    std::printf("PASS: reusable LOD choice with threshold hysteresis\\n");
    std::printf("PASS: native scene handles and dirty tracking\n");
    std::printf("PASS: 10000-object spatial index and exact proximity results\n");
    std::printf("PASS: 30 multithreaded non-blocking routes through narrow passage\n");
    std::puts("PASS: WAV PCM16 decoder, path-safe asset IDs and positional audio mixing");
    return 0;
}
