// First HTML -> native QuickJS scene proof-of-concept.
// This is an offline *source* converter, NOT an HTML/DOM/WebGL emulator.
// It never evaluates an input script. Only trusted local projects should be run.
import {readFile, writeFile, mkdir, realpath} from 'node:fs/promises';
import {dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {pathToFileURL} from 'node:url';

const NATIVE_TYPE='application/x-nativethree-scene';
const CONTRACT=[
  '__nativeThreeFrame','__nativeThreeLightFrame',
  '__nativeThreeNavStats','__nativeThreeDebugSegments',
  '__nativeThreeCombatFrame','__nativeThreeBattleStatus',
  '__nativeThreeQuickBattle','__nativeThreeDiagnostics'
];

function attr(attrs,name) {
  const escaped=name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const m=new RegExp('(?:^|\\s)'+escaped+'\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))','i').exec(attrs);
  return m ? (m[1]??m[2]??m[3]) : null;
}
function scriptsFrom(html) {
  const results=[];
  for(const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    results.push({type:(attr(m[1],'type')||'').toLowerCase(),src:attr(m[1],'src'),body:m[2]});
  }
  return results;
}
function within(root,filename) {
  const rel=relative(root,filename);
  return rel!== '..' && !rel.startsWith('..'+sep) && !isAbsolute(rel);
}
async function loadSource(root,htmlDir,src) {
  if(!src || src.startsWith('//') || /^(?:[a-z][a-z\d+.-]*:|\\\\)/i.test(src) ||
    src.includes('\\') || src.includes('\0')) {
    throw new Error('Only local relative script src paths are supported: '+src);
  }
  const local=decodeURIComponent(src.split(/[?#]/,1)[0]);
  const filename=await realpath(resolve(htmlDir,local));
  if(!within(root,filename))throw new Error('Script escapes project root: '+src);
  return readFile(filename,'utf8');
}

/** Converts a trusted, local HTML entry to the existing native scene.js ABI.
 * Browser-only scripts are never silently treated as native-compatible.
 */
export async function convertHtmlToNative({input,output,report,root=process.cwd()}) {
  const project=await realpath(resolve(root));
  const htmlFile=await realpath(resolve(input));
  if(!within(project,htmlFile))throw new Error('HTML entry escapes project root');
  const html=await readFile(htmlFile,'utf8');
  const scripts=scriptsFrom(html);
  const nativeEntries=scripts.filter(s=>s.type===NATIVE_TYPE);
  const problems=[],warnings=[],parts=[];
  if(nativeEntries.length>1)problems.push({code:'MULTIPLE_NATIVE_ENTRIES',detail:'Expected exactly one native entry'});
  if(nativeEntries.length===1) {
    const entry=nativeEntries[0];
    if(!entry.src || entry.body.trim())problems.push({code:'INVALID_NATIVE_ENTRY',detail:'Native entry needs src and no inline body'});
    else {
      try {parts.push(await loadSource(project,dirname(htmlFile),entry.src));}
      catch(e) {problems.push({code:'NATIVE_SOURCE_UNAVAILABLE',detail:e.message});}
    }
    const omitted=scripts.length-nativeEntries.length;
    if(omitted)warnings.push({code:'BROWSER_SCRIPTS_EXCLUDED',detail:omitted+' browser script(s) not loaded in QuickJS'});
  } else {
    for(const script of scripts) {
      if(script.type==='importmap' || script.type==='application/json')continue;
      if(script.type==='module') {
        problems.push({code:'MODULE_ENTRY_REQUIRES_ADAPTER',detail:script.src??'inline ES module'});
        continue;
      }
      if(script.type && !['text/javascript','application/javascript'].includes(script.type)){
        warnings.push({code:'NON_JS_SCRIPT_IGNORED',detail:script.type});
        continue;
      }
      try {
        const source=script.src?await loadSource(project,dirname(htmlFile),script.src):script.body;
        if(/\b(?:document|window|WebGLRenderer|requestAnimationFrame|localStorage|fetch)\b/.test(source))
          problems.push({code:'BROWSER_API_REQUIRED',detail:script.src??'inline script'});
        if(/(^|[;\n])\s*(?:import|export)\s/m.test(source))
          problems.push({code:'UNBUNDLED_ES_MODULE',detail:script.src??'inline script'});
        parts.push(source);
      }catch(e) {problems.push({code:'SCRIPT_SOURCE_UNAVAILABLE',detail:e.message});}
    }
  }
  const combined=parts.join('\n;\n');
  if(!combined.trim())problems.push({code:'NO_NATIVE_GAME_SCRIPT',detail:'No JS scene source found'});
  for(const name of CONTRACT)if(!combined.includes(name))
    problems.push({code:'NATIVE_CONTRACT_MISSING',detail:name});
  // Reject JS syntax not supported by the QuickJS global-script evaluator.
  if(/(^|[;\n])\s*(?:import|export)\s/m.test(combined))
    problems.push({code:'UNBUNDLED_ES_MODULE',detail:'Bundle modules before QuickJS global evaluation'});
  const result={
    format:'NativeThreeHtmlConversion',version:1,
    input:relative(project,htmlFile).replaceAll('\\','/'),
    entryKind:nativeEntries.length?'explicit-native':'classic-scripts',
    scriptsFound:scripts.length, scriptsIncluded:parts.length,
    readyForNativeSmoke:problems.length===0,
    warnings,errors:problems
  };
  if(report) {
    await mkdir(dirname(resolve(report)),{recursive:true});
    await writeFile(resolve(report),JSON.stringify(result,null,2)+'\n');
  }
  if(problems.length===0) {
    await mkdir(dirname(resolve(output)),{recursive:true});
    await writeFile(resolve(output),
      '// NativeThreeBridge HTML conversion v1: QuickJS scene script; NOT browser HTML.\n'+
      combined+'\n','utf8');
  }
  return result;
}

if(process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url) {
  const [, ,input,output,report]=process.argv;
  if(!input || !output) {
    console.error('Usage: node tools/html-to-native.mjs <index.html> <game/scene.js> [report.json]');
    process.exitCode=2;
  } else {
    try {
      const result=await convertHtmlToNative({input,output,report});
      console.log(JSON.stringify(result,null,2));
      if(!result.readyForNativeSmoke)process.exitCode=1;
    }catch(e) {console.error(e.message);process.exitCode=1;}
  }
}
