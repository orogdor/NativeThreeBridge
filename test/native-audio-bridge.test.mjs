import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
const core=read('native-dx12/native_audio_core.h');
const engine=read('native-dx12/native_audio_xaudio2.h');
const host=read('native-dx12/three_js_host.cpp');
const dx=read('native-dx12/NativeThree-DX12.cpp');
const scene=read('game/scene.js');
const smoke=read('native-dx12/three_scene_smoke.cpp');
const workflow=read('.github/workflows/native-threejs.yml');
const cmake=read('CMakeLists.txt');

test('QuickJS provides transferable sound playback without a browser',()=>{
  assert.match(host,/JS_NewCFunction\(ctx,jsAudioPlay,"play",7\)/);
  assert.match(host,/installNativeAudio\(context\)/);
  assert.match(host,/NativeThreeJS_PopAudioCommands/);
  assert.match(host,/audioQueue\.clear\(\)/);
  assert.match(host,/kAudioMaxQueue=64/);
  assert.match(host,/native_three::legalAudioAsset/);
  assert.match(scene,/nativeAudio\.play\('step',u\.x,0,u\.z,0\.65,true,false\)/);
  assert.match(scene,/nativeAudio\.play\('signal',0,0,0,0\.75,false,false\)/);
  assert.match(smoke,/NativeThreeJS_TriggerAudioTest\(\)/);
  assert.match(smoke,/std::strcmp\(initialAudio\[0\]\.asset,"signal"\)/);
  assert.match(smoke,/NativeThreeJS_Restart\(\)/);
});

test('native Windows XAudio2 backend implements bounded, reusable PCM one-shots',()=>{
  assert.match(engine,/#include <xaudio2\.h>/);
  assert.match(cmake,/NativeThreeJS PRIVATE qjs d3d12 dxgi d3dcompiler user32 xaudio2/);
  assert.match(engine,/XAudio2Create\(/);
  assert.match(engine,/CreateMasteringVoice\(/);
  assert.match(engine,/CreateSourceVoice\(/);
  assert.match(engine,/SubmitSourceBuffer\(/);
  assert.match(engine,/SetOutputMatrix\(/);
  assert.match(engine,/voices_\.size\(\)>=24/);
  assert.match(engine,/decodePcmWave\(/);
  assert.match(engine,/void stopAll\(\)/);
  assert.match(core,/wavU16/);
  assert.match(core,/sound\.pcm\.assign/);
  assert.match(core,/spatialAudioMix/);
  assert.match(core,/legalAudioAsset/);
});

test('DX12 handles native sound events and keeps restart/mute controls safe',()=>{
  assert.match(dx,/gAudio\.init\(\)/);
  assert.match(dx,/NativeThreeJS_PopAudioCommands\(pending,64\)/);
  assert.match(dx,/gAudio\.setListener\(/);
  assert.match(dx,/gAudio\.play\(pending\[i\]\)/);
  assert.match(dx,/gAudio\.stopAll\(\)/);
  assert.match(dx,/VK_F10/);
  assert.match(dx,/VK_F11/);
  assert.match(dx,/AUDIO %u voices %u cues %s/);
  assert.match(dx,/NativeThreeJS_Restart\(\)/);
  assert.match(dx,/gAudio\.shutdown\(\)/);
});

test('battle fixture synthesizes native WAVs while test ZIP defaults to Kuningriigid source',()=>{
  const generator=read('tools/generate_native_audio_samples.py');
  assert.match(generator,/with wave\.open/);
  assert.match(generator,/make\("signal"/);
  assert.match(generator,/make\("step"/);
  assert.match(generator,/make\("restart"/);
  assert.match(workflow,/python tools\/generate_native_audio_samples\.py/);
  assert.match(workflow,/Copy-Item game\/SOURCE\.txt dist\/game\/SOURCE\.txt/);
  assert.doesNotMatch(workflow,/Copy-Item game\/audio\/\*\.wav dist\/game\/audio\//);
  assert.equal(read('version.txt').trim(),'0.27.0-test.1');
});
