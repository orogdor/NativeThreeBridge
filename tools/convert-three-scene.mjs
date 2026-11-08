#!/usr/bin/env node
// Run with a trusted local ESM module exporting a THREE.Scene as default,
// named "scene", or a buildScene() function. Does not execute in a sandbox.
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {convertThreeScene} from '../js/native-three-converter.mjs';
const [, ,input,output]=process.argv;
if(!input || !output){
  console.error('Usage: node tools/convert-three-scene.mjs ./my-scene.mjs ./manifest.json');
  process.exitCode=2;
} else {
  try {
    const mod=await import(pathToFileURL(resolve(input)).href);
    let scene=mod.scene??mod.default;
    if(!scene && mod.buildScene)scene=await mod.buildScene();
    if(typeof scene==='function')scene=await scene();
    const data=convertThreeScene(scene);
    await writeFile(resolve(output),JSON.stringify(data,null,2)+'\n','utf8');
    console.log('Exported',data.objects.length,'objects,',data.issues.length,'compatibility issues');
    if(data.issues.length)console.log(data.issues.map(i=>i.code+': '+i.name).join('\n'));
  } catch(err) {
    console.error(err);process.exitCode=1;
  }
}
