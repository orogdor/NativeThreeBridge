import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source=readFileSync(new URL('../diagnostic/NativeThree-Diagnostics.c',import.meta.url),'utf8');

test('native diagnostic paints complete frames offscreen',()=>{
  assert.match(source,/CreateCompatibleDC\s*\(/);
  assert.match(source,/CreateCompatibleBitmap\s*\(/);
  assert.match(source,/BitBlt\s*\(\s*dc/);
  assert.match(source,/case WM_ERASEBKGND\s*:\s*return 1/);
  assert.match(source,/wc\.hbrBackground\s*=\s*NULL/);
});
test('scene objects sorted by camera depth',()=>{
  assert.match(source,/itemCompare/);
  assert.match(source,/qsort\s*\(\s*items/);
  assert.match(source,/item->depth = x \* s \+ z \* c;/);
  assert.match(source,/item->kind = 1/);
});
test('backbuffer and GDI objects released on shutdown',()=>{
  assert.match(source,/releaseBackbuffer\s*\(\s*\)/);
  assert.match(source,/DeleteObject\s*\(\s*backBitmap\s*\)/);
  assert.match(source,/RestoreDC\(dc,saved\)/);
});
