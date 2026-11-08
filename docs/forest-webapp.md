# Forest battle web app

Run `npm install`, `npm run web:build`, then `npm run web:serve` and open
`http://127.0.0.1:4173/`. The build is self-contained: it copies the pinned
Three.js module, OrbitControls, and the existing battle scene into `dist-web`.
The native `game/scene.js` remains the engine benchmark and is not replaced in
this first migration step.

The browser app executes only the battle scene bundled from this repository.
It supplies browser geometry for the native mesh placeholders and replaces the
native 1,000-light stress fixture with simple browser lighting. This gives a
visible battle and shared simulation behavior, but browser and DX12 rendering
are not visually equivalent yet.

## Path to launching a web app in the native engine

The current native host accepts a scene script and a limited Three.js API. It
does not implement a browser document, canvas, WebGLRenderer, ES module loader,
or arbitrary web APIs. Passing `index.html` to it therefore cannot launch this
app. A practical next step is a versioned app package with a manifest listing
the entry module, assets, hashes, and required capabilities. A compatibility
check should report missing capabilities before any game code runs. Then move
the battle simulation into a shared module and give it separate browser and
native rendering adapters. Expand the native API against that package one
capability at a time, while retaining this forest battle as the engine test.

Downloaded third-party JavaScript must remain data until the user explicitly
selects a trusted game package. Validate the manifest, paths, and hashes,
keep game files isolated from engine files, and show unsupported APIs rather
than silently substituting behavior. Kuningriigid is a separate compatibility
target; this web build does not establish that it runs through native DX12.
