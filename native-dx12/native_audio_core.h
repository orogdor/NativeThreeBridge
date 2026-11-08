#pragma once
// Reusable platform-independent portion of the JavaScript -> native audio bridge.
// PCM WAV decoding is deliberately strict: RIFF/WAVE PCM16 mono/stereo only.
// Other formats must be transcoded by the asset pipeline, not guessed.
#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

namespace native_three {
struct AudioCommand {
    char asset[64]{};
    float x=0,y=0,z=0,volume=1;
    bool spatial=false,loop=false;
};
struct PcmSound {
    unsigned sampleRate=0, channels=0;
    std::vector<std::uint8_t> pcm;
    bool valid() const {
        return sampleRate>=8000 && sampleRate<=96000 &&
               (channels==1 || channels==2) && !pcm.empty() &&
               pcm.size()%(channels*2)==0;
    }
};
inline std::uint16_t wavU16(const std::uint8_t* p) {
    return (std::uint16_t)(p[0] | ((unsigned)p[1]<<8));
}
inline std::uint32_t wavU32(const std::uint8_t* p) {
    return (std::uint32_t)p[0] | ((std::uint32_t)p[1]<<8) |
           ((std::uint32_t)p[2]<<16) | ((std::uint32_t)p[3]<<24);
}
inline bool legalAudioAsset(const std::string& id) {
    if(id.empty()||id.size()>63)return false;
    for(const unsigned char c:id)
        if(!((c>='a'&&c<='z')||(c>='A'&&c<='Z')||
             (c>='0'&&c<='9')||c=='-'||c=='_'))return false;
    return true;
}
inline PcmSound decodePcmWave(const std::uint8_t* data,std::size_t n) {
    PcmSound sound;
    if(!data||n<44||n>16*1024*1024||std::memcmp(data,"RIFF",4)||
       std::memcmp(data+8,"WAVE",4)||wavU32(data+4)>n-8)return sound;
    bool haveFormat=false,havePcm=false;
    unsigned channels=0,rate=0;
    std::size_t samples=0,bytes=0;
    for(std::size_t offset=12;offset+8<=n;){
        const std::uint32_t chunkSize=wavU32(data+offset+4);
        const std::size_t begin=offset+8;
        if(chunkSize>n-begin)return PcmSound{};
        if(!std::memcmp(data+offset,"fmt ",4) && chunkSize>=16){
            const auto* f=data+begin;
            channels=wavU16(f+2); rate=wavU32(f+4);
            const unsigned bits=wavU16(f+14);
            haveFormat=wavU16(f)==1 && bits==16 &&
                       (channels==1||channels==2) &&
                       rate>=8000 && rate<=96000 &&
                       wavU16(f+12)==channels*2;
        }else if(!std::memcmp(data+offset,"data",4)){
            samples=begin;bytes=chunkSize;havePcm=true;
        }
        if(chunkSize>n-begin)return PcmSound{};
        const std::size_t next=begin+chunkSize+(chunkSize&1);
        if(next>n)break;
        offset=next;
    }
    if(!haveFormat||!havePcm||!bytes||bytes%(channels*2))return PcmSound{};
    sound.channels=channels;sound.sampleRate=rate;
    sound.pcm.assign(data+samples,data+samples+bytes);
    return sound;
}
struct AudioMix {float left=0,right=0,attenuation=0;};
// Horizontal listener/camera position; up and down in this DX12 scene is
// intentionally ignored, because zoomed-out views would silence the demo.
inline AudioMix spatialAudioMix(float listenerX,float listenerZ,float yaw,
                               float x,float z,float volume,bool spatial) {
    if(!std::isfinite(volume)||!std::isfinite(x)||!std::isfinite(z)||
       !std::isfinite(listenerX)||!std::isfinite(listenerZ)||!std::isfinite(yaw))
        return {};
    const float gain=std::clamp(volume,0.f,1.f);
    if(!spatial)return {gain,gain,1.f};
    const float dx=x-listenerX,dz=z-listenerZ;
    const float d=std::sqrt(dx*dx+dz*dz);
    const float distance=std::min(d,100000.f);
    const float a=1.f/(1.f+std::pow(distance/80.f,2));
    const float right=std::sin(yaw)*dz+std::cos(yaw)*dx;
    const float pan=d>0.01f?std::clamp(right/d,-1.f,1.f):0.f;
    return {a*gain*std::sqrt(0.5f*(1.f-pan))*1.41421356f,
            a*gain*std::sqrt(0.5f*(1.f+pan))*1.41421356f,a};
}
} // namespace native_three
