# v0.26.0-based native Three.js WebApp proof of concept

This is deliberately **not Kuningriigid** and does not replace the v0.26.0
10,000-tree / 1,000-soldier native game. It is a separate experiment.

The same `webapp/index.html` + `webapp/app.js` runs in a regular browser
(with the internet available to load official Three.js 0.181.0 from jsDelivr)
and in the new native Windows executable. Native mode starts from
`index.html`, finds its explicit `nativethree-entry` metadata and evaluates
`app.js` with the existing bundled official Three.js classes in QuickJS-NG.
Native mode replaces only the WebGLRenderer boundary, captures the real
Three.js scene graph each frame, and draws its BoxGeometry in DirectX 12.

**Native prototype restrictions:** 1 BoxGeometry, 1 color material,
PerspectiveCamera at (0,0,6), one canvas id `stage`, animation driven by
requestAnimationFrame. It does not parse CSS, provide a complete DOM,
execute arbitrary modules, use WebGL, render texture maps or support all
Three.js lights/shaders. An unsupported app fails with an explicit error.
This is only a first end-to-end proof that an HTML entry can launch JS and
drive a native GPU scene without Chromium, not general WebApp compatibility.

## How to test

Download the Actions artifact `NativeThreeWebApp-v026-Windows-x64` from
the workflow for branch `experiments/v026-webapp-cube`. Extract the whole
ZIP, then run `Run-WebApp.cmd` (or `NativeThree-WebApp.exe`) on Windows 10/11 with a DX12 GPU.
You should see a rotating blue cube; Escape closes it.

For the browser comparison open `webapp/index.html` using a local HTTP
server (for example `python -m http.server 8000` from the extracted folder,
then visit http://localhost:8000/webapp/). Browsers generally disallow
module imports from file://.

Windows CI compiles the DX12 EXE and runs `ThreeWebAppSmoke.exe`, which
checks real QuickJS / Three.js initialization and animated matrices
**without requiring a GPU**. The visual DX12 result still requires
interactive testing on a Windows machine.


## Startup troubleshooting

The EXE writes a fresh `webapp-startup.log` alongside itself on each launch.
If the window fails to open or immediately closes, run `Run-WebApp.cmd`
from the extracted ZIP folder. It will show the log and keep the console
visible on nonzero exits. If you want to test the software fallback instead,
run `NativeThree-WebApp.exe --warp` from a terminal.

The native EXE uses the MSVC static runtime to avoid missing VC++ DLLs.
Windows CI tests actual D3D12 creation, shader compilation, swapchain
initialization and three presented frames on the WARP software adapter.
That is stronger than the JS-only smoke, but does not replace a visual test
on physical hardware.
