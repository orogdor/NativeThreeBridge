import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const src=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
const dx=src('native-dx12/NativeThree-DX12.cpp');
const host=src('native-dx12/three_js_host.cpp');
const scene=src('game/scene.js');
const pack=src('tools/pack_kuningriigid.py');

test('engine spatial index replaces 16x10k and 256x1000 full scans',()=>{
  assert.match(dx,/gStaticObjects\.queryRadius/);
  assert.match(dx,/gDynamicLights\.queryRadius/);
  assert.match(dx,/gStaticObjects\.forEachChunk/);
  assert.match(dx,/gCachedVisibleTreeIds/);
  assert.match(dx,/gUploadedVisibilityRevisions\[FRAME_COUNT\]/);
  assert.match(dx,/gSceneRegistry\.setPosition/);
});
test('engine uses fixed simulation ticks and interpolation rather than variable dt for JS',()=>{
  assert.match(dx,/FixedStepper simulation\(1\.0\/60\.0,4\)/);
  assert.match(dx,/simulation\.advance\(dt/);
  assert.match(dx,/renderedLights\[k\+c\]=previousLights/);
  assert.match(dx,/NativeThreeJS_FrameFrom\(/);
  assert.match(host,/firstChangedInstance/);
});
test('native async navigation stays opt-in with a Three.js-compatible fallback',()=>{
  for(const fn of ['configure','request','poll','cancel','updateAgents']) {
    assert.match(host,new RegExp('JS_SetPropertyStr\\(ctx,api,"'+fn+'"'));
  }
  assert.match(scene,/globalThis\.NativeThreeNavigation\?\?null/);
  assert.match(scene,/function planForImmediate/);
  assert.match(scene,/nativeNavigation\.request\(/);
  assert.match(scene,/nativeNavigation\.updateAgents\(/);
});
test('GPU timestamps, asynchronous logging and offline mipmaps are included',()=>{
  assert.match(dx,/D3D12_QUERY_HEAP_TYPE_TIMESTAMP/);
  assert.match(dx,/ResolveQueryData/);
  assert.match(dx,/gPerfLog\.enqueue\(csv\)/);
  assert.match(dx,/view\.Texture2D\.MipLevels=levels/);
  assert.match(pack,/b"NTX2"/);
  assert.match(pack,/Image\.Resampling\.BOX/);
});
