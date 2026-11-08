// NativeThreeBridge experimental V8 worker.
// Executes the SAME browser shim, official Three.js module and DX12 NativeRenderer
// in Node.js V8 (not Chromium). No game source conversion or modifications.
// Binary IPC protocol documented in native-dx12/v8_webapp_host.cpp.
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBuiltins, resolveModule } from '../test/helpers/webapp-node-host.mjs';

const baseDir=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const gameRoot=path.resolve(process.argv[2] || path.join(baseDir, 'game'));
const builtins=loadBuiltins();
const builtinNames=[...builtins.keys()];
const context=vm.createContext({});
const SandboxArrayBuffer=vm.runInContext('ArrayBuffer',context);
let importMap=[];
let booted=false;
let host=null;
let modules=new Map();
let warned=new Set();
const OP={LOG:1,TITLE:2,GEO:3,FREE_GEO:4,INST:5,FREE_INST:6,PASS:7,DONE:8,ERROR:9};
let commandCount=0;

function emit(type, data=Buffer.alloc(0)) {
  const buf=typeof data==='string'?Buffer.from(data,'utf8'):data;
  const header=Buffer.allocUnsafe(5);
  header.writeUInt32LE(buf.byteLength+1,0);header[4]=type;
  fs.writeSync(1,header);
  if(buf.length)fs.writeSync(1,buf);
}
function log(level,msg) {
  const text=String(level)+'\n'+String(msg);
  emit(OP.LOG,text);
}
function reportError(where,e) {
  const detail=where+': '+String(e?.stack||e?.message||e);
  log('error',detail);
}
function done(info='') {emit(OP.DONE,info);}
function safePath(p) {
  const source=String(p).replace(/\\/g,'/');
  if(!source || source.includes('\0') || source.includes(':') || source.startsWith('/'))
    throw new Error('Invalid game path '+source);
  const normalized=path.posix.normalize(source);
  if(normalized==='..'||normalized.startsWith('../')) throw new Error('Path escapes game/: '+source);
  const full=path.resolve(gameRoot,...normalized.split('/'));
  if(full!==gameRoot && !full.startsWith(gameRoot+path.sep))throw new Error('Path escapes game/: '+source);
  return full;
}
function readGameFile(rel) {return fs.readFileSync(safePath(rel));}
const metaURL=name=>name.startsWith('nt:')?name:'nt://game/'+name.replace(/#.*$/,'');
const modCache=new Map();
async function dynamicImport(specifier,referrer) {
  const module=await linkModule(specifier,referrer);
  if(module.status==='unlinked')await module.link(linkModule);
  if(module.status==='linked')await module.evaluate();
  return module;
}
function newModule(source,name) {
  return new vm.SourceTextModule(source,{
    context,identifier:name,
    initializeImportMeta(meta){meta.url=metaURL(name);meta.main=false;},
    importModuleDynamically:(specifier,referrer)=>dynamicImport(specifier,referrer)
  });
}
async function linkModule(specifier,referencing) {
  const name=resolveModule(referencing.identifier,specifier,importMap,builtinNames);
  if(name==='nt:three' && specifier!=='three' && !specifier.startsWith('nt:') && !warned.has(specifier)){
    warned.add(specifier);
    log('warn',"'"+specifier+"' replaced by the engine's built-in Three.js r181");
  }
  if(modCache.has(name))return modCache.get(name);
  let source;
  if(name.startsWith('nt:')) {
    if(!builtins.has(name))throw new Error('Embedded module not found: '+name);
    source=builtins.get(name);
  } else {
    log('info','V8 module requested: '+name);
    source=readGameFile(name).toString('utf8');
    log('info','V8 compiling '+name+' ('+source.length+' chars)');
  }
  const module=newModule(source,name);
  modCache.set(name,module);
  if(!name.startsWith('nt:'))log('info','V8 compiled: '+name);
  return module;
}
const typed=v=>v && ArrayBuffer.isView(v);
const floatBytes=(v,n)=>v?Buffer.from(v.buffer,v.byteOffset,n===undefined?v.byteLength:n*4):Buffer.alloc(0);
const nt={
 log,
 setTitle(title){emit(OP.TITLE,String(title));},
 readText(p){return readGameFile(p).toString('utf8');},
 readBinary(p){
   const b=readGameFile(p);
   const out=new SandboxArrayBuffer(b.byteLength);
   new Uint8Array(out).set(b);
   return out;
 },
 setImportMap(entries){importMap=Array.from(entries,String);},
 evalScript(source,name) {
   log('info','V8 executing script: '+name);
   const result=vm.runInContext(String(source),context,{
     filename:String(name),
     importModuleDynamically:(specifier)=>dynamicImport(specifier,{identifier:String(name).includes('#')?'index.html':String(name)})
   });
   log('info','V8 script completed: '+name);
   return result;
 },
 async evalModule(source,name) {
   log('info','V8 executing module entry: '+name);
   const module=newModule(String(source),String(name));
   await module.link(linkModule);
   await module.evaluate();
   log('info','V8 module entry evaluated: '+name);
 },
 uploadGeometry(id,positions,normals,colors,indices) {
   if(!typed(positions)||positions.length%3)throw new Error('uploadGeometry positions must be Float32Array xyz');
   const vertices=positions.length/3,ix=indices?.length||0;
   if(normals && normals.length!==positions.length)throw new Error('bad normals length');
   if(colors && colors.length!==positions.length)throw new Error('bad colours length');
   const flags=(normals?1:0)|(colors?2:0);
   const hdr=Buffer.alloc(16);hdr.writeUInt32LE(id>>>0,0);hdr.writeUInt32LE(vertices,4);hdr.writeUInt32LE(ix,8);hdr.writeUInt32LE(flags,12);
   const chunks=[hdr,floatBytes(positions),floatBytes(normals),floatBytes(colors),indices?floatBytes(indices):Buffer.alloc(0)];
   emit(OP.GEO,Buffer.concat(chunks));
 },
 releaseGeometry(id){const hdr=Buffer.alloc(4);hdr.writeUInt32LE(id>>>0);emit(OP.FREE_GEO,hdr);},
 uploadInstances(id,matrices,colors,count){
   if(!typed(matrices)||matrices.length<count*16||(colors && colors.length<count*3))
     throw new Error('bad instance matrices or colours');
   const hdr=Buffer.alloc(12);hdr.writeUInt32LE(id>>>0,0);hdr.writeUInt32LE(count,4);hdr.writeUInt32LE(colors?1:0,8);
   emit(OP.INST,Buffer.concat([hdr,floatBytes(matrices,count*16),floatBytes(colors,count*3)]));
 },
 releaseInstances(id){const hdr=Buffer.alloc(4);hdr.writeUInt32LE(id>>>0);emit(OP.FREE_INST,hdr);},
 submitPass(packet,floats) {
   if(!typed(packet)||floats<64||floats>packet.length)throw new Error('invalid render pass');
   const hdr=Buffer.alloc(4);hdr.writeUInt32LE(floats,0);
   emit(OP.PASS,Buffer.concat([hdr,floatBytes(packet,floats)]));
 }
};
context.__nt=nt;
const shim=fs.readFileSync(path.join(baseDir,'js','webapp-shim.js'),'utf8');
vm.runInContext(shim,context,{filename:'nt:webapp-shim.js'});
host=context.__ntHost;
log('info','V8 process ready; Node '+process.version+', V8 '+process.versions.v8);
done('ready');

async function handle(command) {
  commandCount++;
  switch(command.type) {
    case 'boot':
      host.resize(command.width||1280,command.height||720,1);
      host.boot(readGameFile('index.html').toString('utf8'));
      done(host.status());
      break;
    case 'frame':
      host.frame(command.time||0);
      done(host.status());
      break;
    case 'resize':
      host.resize(command.width,command.height,command.pixelRatio||1);
      done(host.status()); break;
    case 'key':
      host.key(!!command.down,command.key,command.code,!!command.repeat,
               !!command.alt,!!command.ctrl,!!command.shift,!!command.meta);
      done(host.status()); break;
    case 'pointer':
      host.pointer(command.kind,command.x,command.y,command.button||0);
      done(host.status()); break;
    case 'wheel':
      host.wheel(command.x,command.y,command.deltaX,command.deltaY);
      done(host.status()); break;
    case 'focus':
      host.focus(!!command.focused);
      done(host.status()); break;
    case 'status':
      done(host.status()); break;
    case 'exit':
      done('shutdown');process.exit(0);break;
    default: throw new Error('Unknown V8 host command: '+command.type);
  }
}
let pending='';
let serial=Promise.resolve();
process.stdin.setEncoding('utf8');
process.stdin.on('data',chunk=>{
  pending+=chunk;
  let newline;
  while((newline=pending.indexOf('\n'))>=0){
    const line=pending.slice(0,newline);
    pending=pending.slice(newline+1);
    if(!line.trim())continue;
    serial=serial.then(async()=>{
      try{await handle(JSON.parse(line));}
      catch(e){reportError('V8 worker command',e);done(JSON.stringify({booted:false,bootError:String(e?.stack||e)}));}
    });
  }
});
process.stdin.on('end',()=>process.exit(0));
process.on('unhandledRejection',e=>reportError('Unhandled V8 promise',e));
process.on('uncaughtException',e=>{reportError('Uncaught V8 exception',e);done(JSON.stringify({booted:false,bootError:String(e)}));});
