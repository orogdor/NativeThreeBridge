// Regression guard for experimental DX12/V8 worker boundaries.
// The full native branch is also compiled and exercised with forced async
// DX12, resize and reload on the Windows CI runner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../native-dx12/webapp_dx12.cpp', import.meta.url), 'utf8');
test('V8 is never entered from the DX12 worker', () => {
  const block = src.slice(src.indexOf('void WebappWindow::startRenderThread'), src.indexOf('void WebappWindow::renderFrame'));
  assert.match(block, /renderFrame\(\)/);
  assert.doesNotMatch(block, /host_\.frame|host_\.start|host_\.pointer/);
});
test('render worker is drained for hot reload, exit and resize', () => {
  assert.match(src, /void WebappWindow::resetPage\(\)\s*\{\s*stopRenderThread\(\);/);
  assert.match(src, /msg\.message == WM_QUIT\)\s*\{\s*stopRenderThread\(\);/);
  assert.match(src, /void WebappWindow::resize[\s\S]*?waitRenderThread\(\);/);
});
test('fallback and adaptive modes exist and resource paths are serialized', () => {
  assert.match(src, /NTB_ASYNC_RENDER/);
  assert.match(src, /std::thread::hardware_concurrency\(\) >= 4/);
  for (const name of ['uploadGeometry','uploadInstances','releaseGeometry','releaseInstances','uploadTexture','releaseTexture','registerColorPatch']) {
    const p = src.indexOf('WebappWindow::' + name + '(');
    assert(p >= 0);
    assert.match(src.slice(p, p + 1100), /gpuLock\(gfxMutex_\)/);
  }
});

test('worker obtains the native resource snapshot before V8 frame N+1', () => {
  assert.match(src, /renderStarted_ = true;/);
  assert.match(src, /renderCv_\.wait\(lock, \[this\] \{ return renderStarted_/);
});

test('native UI raster runs independently and publishes immutable frames', () => {
  assert.match(src, /void WebappWindow::startUiThread\(\)/);
  assert.match(src, /std::shared_ptr<const UiFrame> uiPublished_/);
  assert.match(src, /uiPublished_ = std::move\(bitmap\)/);
  assert.match(src, /NTB_ASYNC_UI/);
  assert.match(src, /void WebappWindow::stopUiThread\(\)/);
});
test('native Canvas and text layout are serialized with UI raster', () => {
  for (const name of ['canvasCommands', 'canvasRead', 'canvasWrite', 'registerImage', 'measureText']) {
    const p = src.indexOf(' ' + name + '(');
    assert(p >= 0, name);
    assert.match(src.slice(p, p + 800), /uiLock\(uiMutex_\)/);
  }
});
test('UI raster worker uses no V8 callbacks or DX12 command recording', () => {
  const worker = src.slice(src.indexOf('void WebappWindow::startUiThread() {'), src.indexOf('void WebappWindow::requestUiRender()'));
  assert.match(worker, /ui_\.render/);
  assert.doesNotMatch(worker, /host_\.|renderFrame\(|queue_->|cmd_->/);
});
