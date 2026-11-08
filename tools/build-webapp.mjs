import {cp,mkdir,copyFile,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {dirname,join,resolve} from 'node:path';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const output=join(root,'dist-web');
await rm(output,{recursive:true,force:true});
await mkdir(join(output,'vendor'),{recursive:true});
for(const name of ['index.html','style.css','main.mjs'])
  await copyFile(join(root,'webapp',name),join(output,name));
await copyFile(join(root,'game','scene.js'),join(output,'scene.js'));
await copyFile(join(root,'node_modules','three','build','three.module.js'),join(output,'vendor','three.module.js'));
await copyFile(join(root,'node_modules','three','examples','jsm','controls','OrbitControls.js'),join(output,'vendor','OrbitControls.js'));
console.log(`Built ${output}`);
