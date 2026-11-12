NativeThreeBridge v0.32.20 - KAKS MÄNGU, ÜKS ENGINE
==================================================
Game1.exe            metsalahingu test (kaust game1)
Game2.exe            webapp kaustas game2 (alguses tühi)
UpdateKuningriigid.exe  laeb Kuningriigid GitHubist kausta game2 või uuendab
                     selle uusimale versioonile (ainult muutunud failid,
                     eelmine versioon jääb kausta game2.previous)
UpdateEngine.exe     uuendab GitHubi uusimast stabiilsest väljalaskest ainult
                     engine'i faile (NativeThree-Engine.exe, Game1/Game2,
                     V8 DLL-id); game1 ja game2 kaustu ei puudutata.
                     Eelmine engine jääb kausta engine.previous.
Esimene kord: käivita UpdateKuningriigid.exe (umbes 550 MB), siis Game2.exe.
Kuningriigid käivitub umbes 25 s (maailma genereerimine) enne akna avanemist.
Mõlemad uuendajad nõuavad, et Game1/Game2 oleks suletud.

v0.32.20 TEST: Three.js veebirakenduste staatiline geomeetria joonistatakse
DX12 GPU-lokaalsest mälust. Dünaamilise geomeetria üleslaadimine jätkub
voogedastusmälust. Eraldi DX12 renderduslõime kasutamisel võib JavaScript
järgmise kaadri andmeid saata eelmise kaadri kuvamise ooteajal.
Testimiseks paki Windowsi ZIP eraldi kausta. UpdateEngine.exe valib
jätkuvalt uusima stabiilse versiooni.

v0.32.1 PARANDUS: onBeforeCompile materjalides, mille tipuatribuut juhib
smoothstep-läbipaistvust, tõlgitakse mask nüüd RGBA tipuvärvideks.
Näiteks rannajoone servad ei kata enam maastikku ühtlase pinnana.
Keerukad maastiku ja vee GLSL-efektid vajavad veel eraldi tuge.

v0.32.0 UUS: 3D tekstuurid (PNG/JPEG/WebP pildid, GLB mudelite tekstuurid,
alphaTest lehestik - nt Kuningriigide puud), Canvas 2D joonistamine (minikaart,
ikoonid, CanvasTexture), THREE.Sprite, tone mapping (ACES jt), taeva ja
onBeforeCompile veepinna värvid. Paneeli näitamine/peitmine ei paiguta enam
kogu lehte ümber. Pole veel: normaal-/keskkonnakaardid, varjud, udu,
render-to-texture, Canvas 2D varjud.

v0.31.0 UUS: mängu HTML/CSS kasutajaliides (menüüd, nupud, paneelid, pildid,
tekst) joonistatakse nüüd engine'i poolt 3D-stseeni peale - ilma brauserita.
Klikid jõuavad õigetele nuppudele, rullik kerib paneele, hiir üle nupu
muudab :hover stiili. Pole veel: CSS animatsioonid, filter/blur, veebifondid,
<select> rippmenüü (klõps vahetab valikut). WebP pildid vajavad Windowsi
"WebP Image Extension" laiendust. Info: NativeThreeBridge-webapp-log.txt.

NativeThreeBridge v0.28.0 - THREE.JS WEBAPPS IN THE ENGINE (TEST)
=================================================================
NEW: a whole Three.js webapp folder (index.html + ES modules) now runs in
the engine, not only one scene.js file. No browser, WebView or WebGL.
TRY IT: double-click Run-Hello-Webapp.bat. Drag = orbit, wheel = zoom,
Space = pause, R = reset camera, L = point light on/off.
YOUR OWN WEBAPP: NativeThree-Game.exe --webapp "C:\path\to\folder"
or drag the folder (or its index.html) onto NativeThree-Game.exe.
'three' always uses the engine's built-in Three.js r181; THREE.WebGLRenderer
renders natively with DX12. Built-in addons: OrbitControls, PointerLockControls.
Works now: meshes, InstancedMesh, groups, Basic/Lambert/Phong/Standard/
Normal materials, colours, vertex colours, opacity, ambient/hemisphere/
directional/point/spot lights, lines (GridHelper), keyboard/mouse/wheel,
resize, timers, fetch of files inside the webapp folder, document.title.
Not yet (reported in NativeThreeBridge-webapp-log.txt): textures/images,
GLTF models, shadows, fog, ShaderMaterial, post-processing, HTML/CSS
overlays (DOM exists but is not drawn), audio, internet URLs.
Without --webapp the forest battle starts exactly as before.
WEBAPP JAVASCRIPT ENGINE: V8 13 (JIT, same engine as Chrome) runs the
webapp's JavaScript; rendering is still NativeThreeBridge DX12. Keep the
v8*.dll, icu*.dll and icudtl.dat files beside NativeThree-Game.exe.
The forest battle still uses the embedded QuickJS-NG.

NativeThreeBridge v0.27.1 - FOREST BATTLE ENGINE
The forest battle is still the primary scenario and starts normally from
NativeThree-Game.exe. A separate engine-update-v1.json release asset lets
other game installations update only the engine binary. Browser projects
in game/ are reported as incompatible before their JavaScript is executed.

NativeThreeBridge v0.26.0 - SMOOTH CLOSE-UP SOLDIER MOTION
FIX: same fractional 60 Hz simulation time is used for character XYZ,
rotation, battle animation and tracking camera at all DX12 frame rates.
A* waypoint-facing rotates smoothly; F12 instantly refreshes instances.
Compare with v0.25.0 by following soldiers using F2/F3 and zooming in.
F8 still toggles gait, F7 day/night, F12 quick battle, CSS Restart resets.

NativeThreeBridge v0.25.0 - 1000 SOLDIER DIRECTIONAL BATTLE TEST
================================================================
NEW: 500 vs 500 soldiers now acquire an opponent, fight in melee,
and seek their next living enemy after defeating the current target.
F12 jumps 48 from each army into a central skirmish while the full
1000-soldier A* / 10,000-tree workload continues running.
Front: 5 hits to die; flank: 3 hits; rear: 1 hit (15 armor points).
Weapon thrust, stagger and fallen-body animation are in the main AND
real shadow DX12 passes; dead units free navigation slots and lose lights.
When one army loses all soldiers, survivors return to original positions.
The title now reports BATTLE red/blue alive, kills, hits and engaged units.
Three extra editable native WAV cues: game/audio/{swing,hit,death}.wav
F9/CSS Restart resets the battle; F10 tests sound, F11 toggles sound.
Press F2/F3 to follow armies, wheel to zoom and inspect fighting closely.

NEW: JavaScript now emits sound events through NativeThreeAudio.play().
Windows C++ plays short PCM16 WAVs with XAudio2 (no Web Audio browser).
F10 plays the JavaScript-to-XAudio2 test ping. F11 toggles sound output.
Two moving soldiers provide positional footstep cues with stereo panning.
Restart stops all old voices and plays a new acknowledgement sound.
The ZIP includes game/audio/signal.wav, step.wav and restart.wav.
Add short PCM16 mono/stereo WAVs (8-96 kHz) to the game/audio folder.
Example: NativeThreeAudio.play('my_sound',x,y,z,0.7,true,false).
24 simultaneous native voices maximum, with shared cached sound clips.
Not yet: complete Three.js Audio/PositionalAudio API, MP3/OGG decoder,
streaming background music or sophisticated HRTF/audio occlusion.

CSS test: game/ui.html declares <button id=restart-button>; game/ui.css
sets right/top/size/background/text/border/radius/font. Engine parses these
on startup and creates a real owner-drawn Win32 BUTTON, no browser or WebView.
Press Restart to reset 1000 soldiers, A* routes, lights and gait to initial
conditions without reloading the static 10000-tree GPU assets.
You can edit game/ui.css and relaunch to test supported native styles.
F9 is a keyboard shortcut to invoke the same C++ restart command.
Full web CSS layout, animations, flexbox and scripts are NOT implemented.

New: all radius-overlapping lights contribute to each 16x16 spatial tile.
The former nearest-16 light list created hard moving square boundaries.
Light indices are now compact per-frame SRVs; 16 real shadow maps remain.
Compare v0.19.0 and v0.20.0 on the same Windows DX12 camera and settings.
A physical GPU is needed to check lighting pixels and FPS. FPS is not guaranteed.

NEW: Red army 500 spearmen use an actual 8-bone skin generated from the original
Odamees GLB, with JOINTS_0, WEIGHTS_0, hierarchy and inverse bind matrices.
Knees, hips, spine and arms are procedurally moved using skeletal influences.
Blue army 500 retains the v0.21 unrigged procedural gait for comparison.
The same skinning runs in the real shadow depth pass. F8 toggles animation.
game/odamees-rigged.glb contains the exported rig for inspection and reuse.
Rigging is automatic/experimental; it needs a close visual assessment.

10,000 pines / two 500-unit armies / 1,000 lights / 16 shadow maps.
C++ scene registry, spatial index, async A*, native fixed 60Hz simulation
with render interpolation, GPU timing and offline texture mipmaps.

Extract ZIP with NativeThree-Game.exe and game/scene.js together.
Run NativeThree-Game.exe directly to bypass updater checks.
Run NativeThree-Updater.exe separately to check GitHub for deltas.

Controls: F1 overview, F2/F3 army follow, F4 routes, F5 shadow toggle,
F6 VSync, F7 day/night, F8 walking, F9 restart scene.
Mouse drag orbit, wheel zoom; F2/F3 follow army to see legs close up.
Space pause; Esc exit.

Window title metrics: FPS, MAX longest frame ms, GPU FENCE wait ms, CPU
JS/LIGHT/DRAW/PRESENT ms, GPU shadow/main ms, visible trees and dirty objects.
NativeThreeBridge-frames.csv is created in the CURRENT WORKING DIRECTORY,
with one-second summaries and frames longer than 40 ms. File I/O is async.
GPU times are only available if DirectX 12 timestamp queries are supported.

The bundled demo now uses the async native path service; the browser/Node
fallback remains synchronous. Workers find paths on immutable map snapshots.
The test still uses local occupancy/reservation avoidance.
NativeThreeNavigation JS API (Windows only): configure(width,height,blocked
Uint8Array); updateAgents(occupiedInt32Array,reservedInt32Array);
request(startCell,goalCell,urgent); poll(32); cancel(token).

Reusing engine components in new games: generic C++ spatial_index.h,
scene_registry.h, navigation_service.h, fixed_stepper.h, lod_policy.h.
For trusted local Three.js ESM scene modules, run on a developer PC:
  npm install
  npm run convert -- ./my-scene.mjs ./manifest.json
This currently EXPORTS a JSON manifest with compatibility diagnostics;
the DX12 game cannot yet directly run arbitrary imported manifest games.
Full mesh LOD, universal DX12 scene imports and GPU ExecuteIndirect still
need implementing. Windows CI cannot measure your actual GPU FPS.
