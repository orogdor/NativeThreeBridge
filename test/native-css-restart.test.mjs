import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
const css=read('game/ui.css');
const html=read('game/ui.html');
const parser=read('native-dx12/native_css_style.h');
const win=read('native-dx12/native_css_win32.h');
const dx=read('native-dx12/NativeThree-DX12.cpp');
const host=read('native-dx12/three_js_host.cpp');
const smoke=read('native-dx12/three_scene_smoke.cpp');
const ci=read('.github/workflows/native-threejs.yml');
test('CSS and markup define one Restart button without embedding a browser',()=>{
  assert.match(html,/<button id="restart-button">Restart<\/button>/);
  assert.match(css,/#restart-button\s*\{/);
  for(const prop of ['right','top','width','height','background-color','color',
                    'border-color','border-radius','font-size','font-weight'])
    assert.match(css,new RegExp(prop.replaceAll('-','\\-')+':'));
  assert.match(parser,/parseNativeButton/);
  assert.match(parser,/cssHexColor/);
  assert.match(win,/CreateWindowExW\(/);
  assert.match(win,/BS_OWNERDRAW/);
  assert.match(win,/RoundRect\(/);
  assert.doesNotMatch(win,/CreateCoreWebView2EnvironmentWithOptions|CreateWindowExA\(/);
});
test('click dispatches to native C++ reset, preserving GPU forest cache',()=>{
  assert.match(dx,/WS_CLIPCHILDREN/);
  assert.match(dx,/RESTARTS %u/);
  assert.match(dx,/case WM_DRAWITEM:/);
  assert.match(dx,/case WM_COMMAND:/);
  assert.match(dx,/gRestartButton\.isClick\(wp\)/);
  assert.match(dx,/gRestartRequested=true/);
  assert.match(dx,/NativeThreeJS_Restart\(\)/);
  assert.match(dx,/gSceneEpoch/);
  assert.match(dx,/simulation=native_three::FixedStepper/);
  assert.match(dx,/soldierWalk=native_three::WalkAnimation/);
  assert.match(dx,/gHaveVisibilityCache=false/);
  const restartCode=dx.slice(dx.indexOf('if(gRestartRequested) {'),
    dx.indexOf('if(!gPause&&!IsIconic(gWindow))renderFrame();'));
  assert.doesNotMatch(restartCode,/gTreesUploaded=false;/);
  assert.match(host,/void NativeThreeJS_Restart\(\)/);
  assert.match(host,/NativeThreeJS_Shutdown\(\);\s*NativeThreeJS_Init\(\);/);
  assert.match(smoke,/NativeThreeJS_Restart\(\)/);
  assert.match(smoke,/reset\.moved!=0 \|\| reset\.planned!=0/);
});
test('current test ZIP uses Kuningriigid source while battle CSS fixture still builds',()=>{
  assert.match(ci,/Copy-Item game\/SOURCE\.txt dist\/game\/SOURCE\.txt/);
  assert.doesNotMatch(ci,/Copy-Item game\/ui\.css dist\/game\/ui\.css/);
  assert.match(ci,/ThreeSceneSmoke\.exe/);
  assert.equal(read('version.txt').trim(),'0.27.0-test.1');
});
