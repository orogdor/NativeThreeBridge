import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';

const root = new URL('../', import.meta.url);
function file(path){return readFileSync(new URL(path, root));}
function gitBlobSha(content){
  return createHash('sha1')
    .update(Buffer.from('blob '+content.byteLength+'\\0'.replace('\\0','\0')))
    .update(content)
    .digest('hex');
}
test('v0.26 HTML battle wrapper keeps the ORIGINAL battle JS byte-for-byte',()=>{
  const original = file('game/scene.js');
  assert.equal(gitBlobSha(original),'b051828e2aefb64898f435d27d905e1d3026b88b',
    'DO NOT modify the 10k-tree 1k-soldier battle code');
  const index=file('game/index.html').toString('utf8');
  const entry=index.match(/<meta name="native-three-entry" content="([^"]+)">/);
  assert.equal(entry?.[1], 'scene.js');
  assert.match(index,/<script type="module" src="\.\/browser\.js"><\/script>/);
  const preview=file('game/browser.js').toString('utf8');
  assert.match(preview,/await import\('\.\/scene\.js'\)/);
  assert.match(preview,/Browser-only visualization wrapper/);
});
test('critical engine rendering, navigation and memory sources are exact v0.26.0 blobs',()=>{
  const hashes={
    'native-dx12/NativeThree-DX12.cpp':'3a803053f6aabc61b8470d459f1ea816df8e9edb',
    'native-dx12/navigation_service.h':'7fb18e755554610ea9c9b024011101e9d8280373',
    'native-dx12/fixed_stepper.h':'7cafc20a195f352358d57d84bb21261a8e1bddc1',
    'native-dx12/frame_profiler.h':'3e356f3f4f8abde3b038a3c1e756002937527023',
    'native-dx12/scene_registry.h':'8a74413d9408fa87adecc9bd9aafaef1a7751a73',
    'native-dx12/transform_interpolation.h':'ac24c30c476f58b61a4ed9f8eaead6a6f00d0b5b',
    'native-dx12/three_js_host.h':'8cee91f8c304c675c8a7679e3faa5e65504e854b',
  };
  for(const [path,sha] of Object.entries(hashes))
    assert.equal(gitBlobSha(file(path)),sha,path+' MUST match original');
});
test('native loader changes ONLY entry file discovery; old typed-array bridge remains',()=>{
  const cpp=file('native-dx12/three_js_host.cpp').toString('utf8');
  assert.match(cpp,/L"index\.html"/);
  assert.match(cpp,/native-three-entry/);
  assert.match(cpp,/JS_Eval\(context, gameScript\.data\(\), gameScript\.size\(\), "game\/scene\.js", JS_EVAL_TYPE_GLOBAL\)/);
  assert.match(cpp,/JS_SetMemoryLimit\(runtime, 256ULL \* 1024ULL \* 1024ULL\)/);
  assert.match(cpp,/MATRIX_FLOATS = 11000 \* 16/);
  assert.match(cpp,/NativeThreeNavigation/);
});
