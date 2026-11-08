import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const src=readFileSync(new URL('../native-dx12/NativeThree-DX12.cpp',import.meta.url),'utf8');
const DIM=16, SIZE=1080/DIM, MIN=-540;
const cell=(x,z)=>Math.max(0,Math.min(DIM-1,Math.floor((z-MIN)/SIZE)))*DIM+
  Math.max(0,Math.min(DIM-1,Math.floor((x-MIN)/SIZE)));
const intersects=(light,cx,cz)=>{
  const mx=MIN+(cx+0.5)*SIZE,mz=MIN+(cz+0.5)*SIZE;
  const dx=Math.max(Math.abs(light.x-mx)-SIZE/2,0);
  const dz=Math.max(Math.abs(light.z-mz)-SIZE/2,0);
  return dx*dx+dz*dz < light.r*light.r;
};
const build=(lights)=>{
  const bins=Array.from({length:DIM*DIM},()=>[]);
  for(let c=0;c<bins.length;c++)
    for(let k=0;k<lights.length;k++)
      if(intersects(lights[k],c%DIM,Math.floor(c/DIM)))bins[c].push(k);
  return bins;
};
const affects=(l,x,z)=>(l.x-x)**2+(l.z-z)**2<l.r*l.r;

test('lighting grid is a conservative candidate accelerator, not a nearest-16 limiter',()=>{
  assert.match(src,/Buffer<uint> gLightGridData : register\(t4\)/);
  assert.match(src,/GRID_CELL_COUNT\*LIGHT_COUNT/);
  assert.match(src,/std::fabs\(l\[0\]-worldX\)-halfCell/);
  assert.match(src,/std::fabs\(l\[2\]-worldZ\)-halfCell/);
  assert.doesNotMatch(src,/MAX_CELL_LIGHTS/);
  assert.match(src,/SetGraphicsRootDescriptorTable\(6,gGridSRV\[back\]\)/);
});

test('dense formations never lose lights where two spatial bins meet',()=>{
  const lights=[];
  for(let i=0;i<1000;i++){
    const t=i*2.399963229728653;
    const d=(i%101)*0.76;
    lights.push({x:Math.cos(t)*d,z:Math.sin(t)*d,r:32});
  }
  const bins=build(lights);
  const nearCenter=cell(-0.001,-0.001);
  assert.ok(bins[nearCenter].length>16,'sample requires more than old nearest-16 limit');
  const boundaries=[MIN+7*SIZE,MIN+8*SIZE,MIN+9*SIZE];
  const positions=[];
  for(const boundary of boundaries){
    for(const epsilon of [-0.001,0,0.001]){
      for(const across of [-45,0,45]){
        positions.push([boundary+epsilon,across],[across,boundary+epsilon]);
      }
    }
  }
  for(const [x,z] of positions){
    const active=new Set(bins[cell(x,z)]);
    for(let i=0;i<lights.length;i++){
      if(affects(lights[i],x,z)){
        assert.ok(active.has(i),`Missing soldier light ${i} at x=${x} z=${z}`);
      }
    }
  }
  const total=bins.reduce((n,b)=>n+b.length,0);
  assert.ok(total<20000,`Conservative bins grew unexpectedly: ${total}`);
});
