# HTML -> QuickJS native scene: first proof of concept

The Windows native engine **cannot execute a whole browser HTML page**. This
experiment lets the native engine and the browser page select **the same battle
simulation** from a single `index.html`, with separate render/UI hosts.

## Convert the forest-battle web app

From the repository root:

```sh
node tools/html-to-native.mjs webapp/index.html build/html-native/scene.js build/html-native/report.json
```

`webapp/index.html` contains both:

- `<script type="module" src="./main.mjs"></script>`: the **browser** renderer
  and HTML/DOM controls, never evaluated in QuickJS.
- `<script type="application/x-nativethree-scene" src="../game/scene.js"></script>`:
  an inert HTML data script used by the offline converter to select **native**
  gameplay code. Its `src` is read locally by the converter, not by browsers.

The generated `scene.js` contains the current forest battle logic. It uses
the exact `__nativeThreeFrame` / lights / navigation / combat callback contract
already required by `native-dx12/three_js_host.cpp`. A converted file can be
substituted for the EXE-adjacent `game/scene.js` in a **test installation**.
Keep the original as a backup. Do not add
`game/.native-three-game-manifest.json`: that marker intentionally blocks
incompatible browser source in the current engine.

The Windows CI builds the real native executable and runs `ThreeSceneSmoke.exe`
first against the default game, then against the HTML-converted `scene.js`.
It does **not** prove actual DX12 pixels/FPS on a user's GPU.

## General HTML inputs

For ordinary classic local scripts, the converter copies scripts in document
order only if they contain the native scene callbacks and no obvious browser
APIs. Script paths must remain within the selected project root. A conversion
report explains why a script cannot be used. There is no execution at conversion
time and no remote JS download.

The converter deliberately **rejects** unbundled ES modules, DOM/canvas APIs,
`WebGLRenderer`, `requestAnimationFrame`, and projects lacking the required
native callbacks. An arbitrary `index.html` is **not yet** a native game.

## Next engine changes for Kuningriigid

1. Separate gameplay simulation from browser controls and WebGLRenderer, then
   build native/browser adapters around the same simulation.
2. Replace the current fixed 10,000-tree/1,000-soldier DX12 ABI with a generic,
   dynamically sized scene registry and mesh/texture/material import path.
3. Add an explicit versioned native app manifest, integrity verification,
   capability checks, and a deliberate trusted-game selection step.
4. Add a native UI event/mouse/keyboard layer and adapters for required browser
   APIs instead of trying to execute arbitrary DOM code in QuickJS.

The 2026-11-08 experiment targets the forest webapp only. It does **not**
assert that the full Kuningriigid web repository is executable in the native
DX12 engine.
