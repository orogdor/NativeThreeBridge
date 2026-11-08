import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const src=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
const dx=src('native-dx12/NativeThree-DX12.cpp');
const pack=src('tools/pack_kuningriigid.py');
const rig=src('tools/spearman_rig.py');
const workflow=src('.github/workflows/native-threejs.yml');

test('rig is generated from pinned odamees mesh with real glTF joints and inverse binds',()=>{
  assert.match(rig,/JOINTS_0/);
  assert.match(rig,/WEIGHTS_0/);
  assert.match(rig,/inverseBindMatrices/);
  assert.match(rig,/Thigh.L/);
  assert.match(rig,/Shin.R/);
  assert.match(pack,/rig_geometry\(doc,buf,positions\)/);
  assert.match(pack,/write_native_rig\(work\/"skin0.bin"/);
  assert.match(pack,/write_glb\(work\/"soldier-rigged.glb"/);
  assert.match(pack,/104 RCDATA/);
});
test('only red soldiers use skin weights, blue soldiers retain previous walk deformation',()=>{
  assert.match(dx,/if\(gKind==1\) \{/);
  assert.match(dx,/SkinInfluence skin=gRigVertices\[vertexID\]/);
  assert.match(dx,/skinOdameesBone\(skin.joints\[ji\],walk,combat,bp,bn\)/);
  assert.match(dx,/BLUE army: original v0.21/);
  assert.match(dx,/float lowerBody=saturate/);
  assert.match(dx,/gKind==3\?500:0/);
});
test('red bone skinning is bound to both shadow and main GPU passes',()=>{
  assert.match(dx,/StructuredBuffer<SkinInfluence> gRigVertices : register\(t5\)/);
  assert.match(dx,/gRigSkinGPU=staticGpuBuffer\(/);
  assert.match(dx,/rs.NumParameters=12/);
  assert.equal((dx.match(/gCmd->SetGraphicsRootDescriptorTable\(10,gRigSkinSRV\)/g)||[]).length,2);
  assert.match(dx,/D3D12_RESOURCE_STATE_NON_PIXEL_SHADER_RESOURCE/);
  assert.match(dx,/if\(wp==VK_F8\)gWalkEnabled=!gWalkEnabled/);
  assert.match(workflow,/Copy-Item generated\/soldier-rigged.glb/);
});
