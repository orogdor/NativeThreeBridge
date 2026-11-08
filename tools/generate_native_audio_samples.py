"""Generate tiny, original, PCM16 WAV test assets for the native sound bridge.

No third-party packages or licensed recordings; generated samples are original
synthesized tones. User-supplied game/audio/*.wav remains editable in release ZIP.
"""
import math
import pathlib
import struct
import wave

RATE=48000

def make(name,seconds,frequency,chirp=False):
    samples=[]
    for i in range(round(RATE*seconds)):
        t=i/RATE
        u=t/seconds
        envelope=(min(1.0,t/0.012))*max(0.0,1.0-u)**2
        f=frequency+(340.0*u if chirp else -45.0*u)
        phase=2.0*math.pi*(frequency*t+
            (170.0*t*t/seconds if chirp else -22.5*t*t/seconds))
        wave_value=math.sin(phase)
        if name=="step":
            wave_value=0.70*math.sin(phase)+0.30*math.sin(phase*0.5)
        amplitude=0.55 if name=="signal" else 0.32
        samples.append(max(-32768,min(32767,int(32767*amplitude*envelope*wave_value))))
    path=pathlib.Path("game/audio")/(name+".wav")
    path.parent.mkdir(parents=True,exist_ok=True)
    with wave.open(str(path),"wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(RATE)
        out.writeframes(struct.pack("<"+"h"*len(samples),*samples))
    with wave.open(str(path),"rb") as sound:
        assert sound.getframerate()==RATE and sound.getnchannels()==1
        assert sound.getnframes()==len(samples)
    print(f"Native audio sample: {path} ({len(samples)} frames)")

if __name__=="__main__":
    make("signal",0.28,650,True)
    make("step",0.065,148)
    make("restart",0.18,500,True)
    # Three deliberately different short synthesized melee cues.
    make("swing",0.17,340,True)
    make("hit",0.12,180)
    make("death",0.35,110)
