import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,mkdtemp,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {convertHtmlToNative} from '../tools/html-to-native.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');

test('webapp index.html converts to the SAME scene script used by native QuickJS',async()=>{
  const out=await mkdtemp(join(tmpdir(),'n3b-html-'));
  try {
    const target=join(out,'scene.js'),report=join(out,'report.json');
    const info=await convertHtmlToNative({
      input:join(root,'webapp/index.html'),
      output:target,report,root
    });
    assert.equal(info.readyForNativeSmoke,true,JSON.stringify(info.errors));
    assert.equal(info.entryKind,'explicit-native');
    assert.equal(info.scriptsIncluded,1);
    assert.ok(info.warnings.some(w=>w.code==='BROWSER_SCRIPTS_EXCLUDED'));
    const generated=await readFile(target,'utf8');
    const original=await readFile(join(root,'game/scene.js'),'utf8');
    assert.ok(generated.includes(original));
    assert.ok(generated.includes('__nativeThreeFrame'));
    assert.ok(!generated.includes('OrbitControls'));
    assert.deepEqual(JSON.parse(await readFile(report,'utf8')),info);
  } finally {await rm(out,{recursive:true,force:true});}
});

test('ordinary inline classic HTML can produce a native ABI script',async()=>{
  const tmp=await mkdtemp(join(tmpdir(),'n3b-classic-'));
  try {
    const src=join(tmp,'index.html'),dest=join(tmp,'game/scene.js');
    const methods=[
      '__nativeThreeFrame','__nativeThreeLightFrame','__nativeThreeNavStats',
      '__nativeThreeDebugSegments','__nativeThreeCombatFrame','__nativeThreeBattleStatus',
      '__nativeThreeQuickBattle','__nativeThreeDiagnostics'
    ];
    await writeFile(src,'<html><script>'+methods.map(s=>'globalThis.'+s+' = () => 0;').join('\n')+'</script></html>');
    const result=await convertHtmlToNative({input:src,output:dest,root:tmp});
    assert.equal(result.readyForNativeSmoke,true);
    assert.match(await readFile(dest,'utf8'),/__nativeThreeDiagnostics/);
  }finally{await rm(tmp,{recursive:true,force:true});}
});

test('browser-only ES modules cannot pretend to run in native engine',async()=>{
  const tmp=await mkdtemp(join(tmpdir(),'n3b-browser-'));
  try {
    await writeFile(join(tmp,'index.html'),'<script type="module" src="./main.mjs"></script>');
    await writeFile(join(tmp,'main.mjs'),'document.querySelector("canvas");');
    const outfile=join(tmp,'scene.js');
    const report=join(tmp,'report.json');
    const result=await convertHtmlToNative({input:join(tmp,'index.html'),output:outfile,report,root:tmp});
    assert.equal(result.readyForNativeSmoke,false);
    assert.ok(result.errors.some(e=>e.code==='MODULE_ENTRY_REQUIRES_ADAPTER'));
    await assert.rejects(()=>access(outfile));
    assert.equal(JSON.parse(await readFile(report,'utf8')).readyForNativeSmoke,false);
  } finally {await rm(tmp,{recursive:true,force:true});}
});

test('converter refuses scripts outside the selected project root',async()=>{
  const tmp=await mkdtemp(join(tmpdir(),'n3b-scope-'));
  try {
    await mkdir(join(tmp,'html'));
    await writeFile(join(tmp,'private.js'),'doNotImport();');
    await writeFile(join(tmp,'html/index.html'),'<script src="../../private.js"></script>');
    const result=await convertHtmlToNative({
      input:join(tmp,'html/index.html'),output:join(tmp,'scene.js'),root:join(tmp,'html')
    });
    assert.equal(result.readyForNativeSmoke,false);
    assert.ok(result.errors.some(e=>e.code==='SCRIPT_SOURCE_UNAVAILABLE'));
  } finally {await rm(tmp,{recursive:true,force:true});}
});
