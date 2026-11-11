import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWebapp, decodePass } from './helpers/webapp-node-host.mjs';

const template = fileURLToPath(new URL('./fixtures/k73-real-lit-dx12/index.html', import.meta.url));
function replaceOnce(source, from, to) {
  assert.ok(source.includes(from), 'fixture anchor: ' + from.slice(0, 45));
  return source.replace(from, to);
}
test('original K73 GLSL INST variant submits three GPU instances with one geometry upload', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'k73-inst-'));
  try {
    let html = readFileSync(template, 'utf8');
    html = replaceOnce(html, 'const v=compile(gl.VERTEX_SHADER,"#version 300 es\\n\\n',
      'const v=compile(gl.VERTEX_SHADER,"#version 300 es\\n#define INST 1\\n\\n');
    const instScript = [
      'const instBuffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,instBuffer);',
      'gl.bufferData(gl.ARRAY_BUFFER,3*80,gl.DYNAMIC_DRAW);',
      'for(let col=0;col<5;col++){',
      ' gl.enableVertexAttribArray(3+col);',
      ' gl.vertexAttribPointer(3+col,4,gl.FLOAT,false,80,col*16);',
      ' gl.vertexAttribDivisor(3+col,1);',
      '}',
      'const instanceData=new Float32Array(60);',
      'for(let n=0;n<3;n++){',
      ' const o=n*20;',
      ' instanceData.set([1,0,0,0,0,1,0,0,0,0,1,0,(n-1)*0.55,0,0,1],o);',
      ' instanceData.set([0.3+n*0.2,0.8-n*0.1,0.7,0],o+16);',
      '}',
      'gl.bufferSubData(gl.ARRAY_BUFFER,0,instanceData,0,60);',
      'window.k73InstanceBufferBytes=instanceData.byteLength;',
      'const index=gl.createBuffer();'
    ].join('\n');
    html = replaceOnce(html, 'const index=gl.createBuffer();', instScript);
    html = replaceOnce(html,
      'gl.drawElements(gl.TRIANGLES,3,gl.UNSIGNED_SHORT,0);window.k73ShaderTestDraws',
      'gl.drawElementsInstanced(gl.TRIANGLES,3,gl.UNSIGNED_SHORT,0,3);window.k73ShaderTestDraws');
    writeFileSync(join(dir, 'index.html'), html);
    const { status, context, rec } = await runWebapp(dir, {frames: 20});
    assert.equal(status.booted, true);
    assert.equal(status.bootError, null);
    assert.deepEqual(status.errors, []);
    assert.equal(context.k73InstanceBufferBytes, 240);
    assert.ok(context.k73ShaderTestDraws >= 15);
    assert.equal(rec.uploads, 1, 'base geometry uploaded once');
    assert.equal(rec.instanceUploads, 1, 'static instance set uploaded once');
    assert.equal(rec.instances.size, 1);
    const inst = [...rec.instances.values()][0];
    assert.equal(inst.count, 3);
    assert.equal(inst.hasColors, true);
    assert.equal(inst.first[0], 1);
    assert.ok(Math.abs(inst.first[12] + 0.55) < 1e-5);
    const p = decodePass(rec.passes[0]);
    assert.equal(p.draws.length, 1);
    assert.equal(p.draws[0].instanceCount, 3);
    assert.ok(p.draws[0].instanceId > 0);
    assert.equal(p.draws[0].flags & 1024, 1024);
  } finally {
    rmSync(dir, {recursive:true,force:true});
  }
});