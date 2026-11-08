#pragma once
#include "game_folder.h"
// Windows XAudio2 2.9 backend for NativeThreeAudio events. No WebAudio engine,
// browser process, sound-on-render-thread blocking, or 1000 voices at once.
// Samples are shared across concurrent source voices and destroyed on restart.
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <xaudio2.h>
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <map>
#include <memory>
#include <string>
#include <vector>
#include "native_audio_core.h"

namespace native_three {
class NativeAudioEngine {
public:
    ~NativeAudioEngine(){shutdown();}
    bool init() {
        if(engine_)return true;
        // XAudio2 requires COM initialization on the calling thread.
        // The DX12 window thread previously skipped this, so CreateMasteringVoice
        // could silently fail even when Windows audio services were available.
        const HRESULT com=CoInitializeEx(nullptr,COINIT_MULTITHREADED);
        if(SUCCEEDED(com))comInitialized_=true;
        else if(com!=RPC_E_CHANGED_MODE){lastError_=com;return false;}
        const HRESULT created=XAudio2Create(&engine_,0,XAUDIO2_DEFAULT_PROCESSOR);
        if(FAILED(created)){lastError_=created;releaseCom();return false;}
        const HRESULT mastered=engine_->CreateMasteringVoice(&master_);
        if(FAILED(mastered)){
            lastError_=mastered;
            engine_->Release();engine_=nullptr;
            releaseCom();return false;
        }
        lastError_=S_OK;
        XAUDIO2_VOICE_DETAILS details{};
        master_->GetVoiceDetails(&details);
        outputChannels_=details.InputChannels;
        wchar_t filename[MAX_PATH]{};
        const DWORD length=GetModuleFileNameW(nullptr,filename,MAX_PATH);
        if(length && length<MAX_PATH)
            audioDirectory_=std::filesystem::path(filename).parent_path()/
                            NativeThree_SceneFolder()/L"audio";
        return true;
    }
    void shutdown() {
        stopAll();
        clips_.clear();
        if(master_){master_->DestroyVoice();master_=nullptr;}
        if(engine_){engine_->Release();engine_=nullptr;}
        outputChannels_=0;
        releaseCom();
    }
    void stopAll() {
        for(auto &v:voices_){
            if(v.voice){v.voice->Stop(0);v.voice->DestroyVoice();}
        }
        voices_.clear();
    }
    void setListener(float x,float z,float yaw) {
        listenerX_=x;listenerZ_=z;listenerYaw_=yaw;
    }
    void tick() {
        for(auto it=voices_.begin();it!=voices_.end();){
            XAUDIO2_VOICE_STATE state{};
            it->voice->GetState(&state,0);
            if(state.BuffersQueued==0) {
                it->voice->DestroyVoice();
                it=voices_.erase(it);
            } else {
                updateMix(*it);
                ++it;
            }
        }
    }
    bool play(const AudioCommand& c) {
        if(!engine_ || !master_)return false;
        std::string id(c.asset);
        if(!legalAudioAsset(id)||!std::isfinite(c.volume))return false;
        tick();
        auto clip=getClip(id);
        if(!clip || !clip->valid())return false;
        // One shared clip can be played by many pooled voices, each with its own
        // source position. The pool cap prevents a 1000-agent audio explosion.
        while(voices_.size()>=24) {
            voices_.front().voice->Stop(0);
            voices_.front().voice->DestroyVoice();
            voices_.erase(voices_.begin());
        }
        WAVEFORMATEX format{};
        format.wFormatTag=WAVE_FORMAT_PCM;
        format.nChannels=(WORD)clip->channels;
        format.nSamplesPerSec=clip->sampleRate;
        format.wBitsPerSample=16;
        format.nBlockAlign=(WORD)(clip->channels*2);
        format.nAvgBytesPerSec=format.nSamplesPerSec*format.nBlockAlign;
        IXAudio2SourceVoice *voice=nullptr;
        if(FAILED(engine_->CreateSourceVoice(&voice,&format,0,XAUDIO2_DEFAULT_FREQ_RATIO)))
            return false;
        XAUDIO2_BUFFER buffer{};
        buffer.Flags=XAUDIO2_END_OF_STREAM;
        buffer.pAudioData=clip->pcm.data();
        buffer.AudioBytes=(UINT32)clip->pcm.size();
        if(c.loop)buffer.LoopCount=XAUDIO2_LOOP_INFINITE;
        if(FAILED(voice->SubmitSourceBuffer(&buffer))){
            voice->DestroyVoice();return false;
        }
        Voice item;
        item.voice=voice;item.clip=std::move(clip);item.command=c;
        voices_.push_back(item);
        updateMix(voices_.back());
        if(FAILED(voice->Start(0))){
            voice->DestroyVoice();voices_.pop_back();return false;
        }
        ++submitted_;
        return true;
    }
    unsigned activeVoices()const{return (unsigned)voices_.size();}
    unsigned submitted()const{return submitted_;}
    bool available()const{return engine_!=nullptr;}
    unsigned lastError()const{return (unsigned)lastError_;}
private:
    void releaseCom(){
        if(comInitialized_){CoUninitialize();comInitialized_=false;}
    }
    struct Voice {
        IXAudio2SourceVoice* voice=nullptr;
        std::shared_ptr<PcmSound> clip;
        AudioCommand command{};
    };
    std::shared_ptr<PcmSound> getClip(const std::string& id) {
        const auto it=clips_.find(id);
        if(it!=clips_.end())return it->second;
        auto clip=std::make_shared<PcmSound>();
        // Allow user-supplied PCM16 WAV assets without recompiling the engine.
        if(!audioDirectory_.empty()){
            const auto path=audioDirectory_/(std::wstring(id.begin(),id.end())+L".wav");
            std::ifstream f(path,std::ios::binary);
            if(f){
                const std::vector<std::uint8_t> bytes(
                    (std::istreambuf_iterator<char>(f)),std::istreambuf_iterator<char>());
                *clip=decodePcmWave(bytes.data(),bytes.size());
            }
        }
        // Robust self-contained diagnostic when a developer has no WAV file.
        // Unknown assets do not generate unexpected sounds.
        if(!clip->valid() && (id=="signal"||id=="step"||id=="restart")){
            const unsigned rate=48000;
            const float dur=id=="step"?0.075f:(id=="restart"?0.16f:0.28f);
            const unsigned count=(unsigned)(rate*dur);
            clip->sampleRate=rate;clip->channels=1;
            clip->pcm.resize(count*2);
            const float base=id=="step"?130.f:(id=="restart"?530.f:660.f);
            for(unsigned n=0;n<count;n++){
                const float t=(float)n/rate;
                const float fade=std::max(0.f,1.f-t/dur);
                const float wave=std::sin(6.28318530718f*(base*t+
                    (id=="signal"?260.f*t*t:0.f)));
                const std::int16_t sample=(std::int16_t)
                    (11000.f*wave*fade*fade);
                clip->pcm[n*2]=(std::uint8_t)(sample&255);
                clip->pcm[n*2+1]=(std::uint8_t)((sample>>8)&255);
            }
        }
        if(!clip->valid())return nullptr;
        clips_[id]=clip;return clip;
    }
    void updateMix(Voice& v) {
        const auto mix=spatialAudioMix(listenerX_,listenerZ_,listenerYaw_,
                                       v.command.x,v.command.z,
                                       v.command.volume,v.command.spatial);
        if(v.clip->channels==1 && outputChannels_==2){
            const float channels[2]={mix.left,mix.right};
            v.voice->SetOutputMatrix(master_,1,2,channels);
        }else{
            v.voice->SetVolume(v.command.volume*(v.command.spatial?mix.attenuation:1.f));
        }
    }
    IXAudio2* engine_=nullptr;
    IXAudio2MasteringVoice* master_=nullptr;
    bool comInitialized_=false;
    HRESULT lastError_=S_OK;
    unsigned outputChannels_=0,submitted_=0;
    float listenerX_=0,listenerZ_=0,listenerYaw_=0;
    std::filesystem::path audioDirectory_;
    std::map<std::string,std::shared_ptr<PcmSound>> clips_;
    std::vector<Voice> voices_;
};
} // namespace native_three
