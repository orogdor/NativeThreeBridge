import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runWebapp} from './helpers/webapp-node-host.mjs';

test('WebGL2 uniform4fv accepts ordinary JS arrays for K73 mesh tints and typed bone subranges',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'k73-uniform-sequence-'));
  try {
    const js=[
      "const gl=document.getElementById('gl').getContext('webgl2');",
      "function shader(t,src){const s=gl.createShader(t);gl.shaderSource(s,src);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(s));return s;}",
      "const p=gl.createProgram();",
      "gl.attachShader(p,shader(gl.VERTEX_SHADER,'#version 300 es\\nlayout(location=0) in vec3 aPos;void main(){gl_Position=vec4(aPos,1.0);}'));",
      "gl.attachShader(p,shader(gl.FRAGMENT_SHADER,'#version 300 es\\nprecision mediump float;out vec4 oC;void main(){oC=vec4(1.0);}'));",
      "gl.linkProgram(p);if(!gl.getProgramParameter(p,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(p));",
      "gl.useProgram(p);",
      "gl.uniform4fv(gl.getUniformLocation(p,'uTint'),[0.25,0.5,0.75,1]);",
      "window.tint=Array.from(p.uniforms.get('uTint'));",
      "gl.uniform4fv(gl.getUniformLocation(p,'uB'),new Float32Array([100,101,102,103, 2,3,4,5, 6,7,8,9]),4,8);",
      "window.bones=Array.from(p.uniforms.get('uB'));",
      "gl.uniform4fv(gl.getUniformLocation(p,'uArray'),[8,9,10,11,12,13,14,15],4,4);",
      "window.arrayOffset=Array.from(p.uniforms.get('uArray'));",
      "window.invalidRejected=false;try{gl.uniform4fv(gl.getUniformLocation(p,'uWrong'),[1,2,3]);}catch(e){window.invalidRejected=true;}"
    ].join('\n');
    writeFileSync(join(dir,'index.html'),'<!doctype html><title>K73 uniform4fv array support</title><canvas id="gl" data-native-webgl2-prototype width="640" height="480"></canvas><script>'+js+'</script>');
    const {context,status}=await runWebapp(dir,{frames:2});
    assert.equal(status.bootError,null);
    assert.deepEqual(status.errors,[]);
    assert.deepEqual(Array.from(context.tint),[0.25,0.5,0.75,1]);
    assert.deepEqual(Array.from(context.bones),[2,3,4,5,6,7,8,9]);
    assert.deepEqual(Array.from(context.arrayOffset),[12,13,14,15]);
    assert.equal(context.invalidRejected,true);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
