import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {runWebapp} from './helpers/webapp-node-host.mjs';

// Reuse a fixture with the real K73 v86 LIT shaders; this tests the native
// WebGL2 uniform contract, not an arbitrary unsupported GLSL program.
const k73=fileURLToPath(new URL('./fixtures/k73-real-lit-dx12',import.meta.url));
test('WebGL2 uniform4fv accepts JS array tints and typed bone offsets',async()=>{
  const {context,status}=await runWebapp(k73,{frames:2});
  assert.equal(status.bootError,null);assert.deepEqual(status.errors,[]);
  const result=context.__nt.evalScript([
    "gl.uniform4fv(gl.getUniformLocation(program,'uTint'),[0.25,0.5,0.75,1]);",
    "const a=Array.from(program.uniforms.get('uTint'));",
    "gl.uniform4fv(gl.getUniformLocation(program,'uB'),new Float32Array([100,101,102,103,2,3,4,5,6,7,8,9]),4,8);",
    "const b=Array.from(program.uniforms.get('uB'));",
    "gl.uniform4fv(gl.getUniformLocation(program,'uOther'),[8,9,10,11,12,13,14,15],4,4);",
    "const c=Array.from(program.uniforms.get('uOther'));",
    "let rejected=false;try{gl.uniform4fv(gl.getUniformLocation(program,'uBad'),[1,2,3]);}catch(e){rejected=true;}",
    "({a,b,c,rejected});"
  ].join('\n'),'k73-uniform4fv-inline.js');
  assert.deepEqual(Array.from(result.a),[0.25,0.5,0.75,1]);
  assert.deepEqual(Array.from(result.b),[2,3,4,5,6,7,8,9]);
  assert.deepEqual(Array.from(result.c),[12,13,14,15]);
  assert.equal(result.rejected,true);
});
