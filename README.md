# NativeThreeBridge v0.18.0 — 10,000-tree / 1,000-soldier DX12 stress test

This release extends the v0.17.0 **native Windows DirectX 12 benchmark**, not yet the universal Three.js importer. It renders 10,000 randomly scattered Sapling pine instances (one bark batch + one alpha-tested foliage batch), **two 500-soldier armies**, 1,000 independently moving Three.js SpotLight objects, and **16 live depth-map shadow-casting lights** selected from the 1,000. All 10,000 trees are created and used as navigation obstacles; only camera-visible trees are submitted to the main DX12 tree draw calls (CPU frustum-culling with GPU index indirection). The shadow passes retain independent per-light visibility lists.

- World: 360x360 navigation cells, 3 world units each; a forest spanning roughly 300x300 cells. A* plans are independent for each soldier, collision/reservation protected, and capped at **four complete searches per frame** to avoid bursts on the expanded grid. This is not yet asynchronous worker-based pathfinding.
- Tree matrix data: 10,000 x 16 floats = 640,000 bytes. The engine **uses a GPU-local structured shader resource buffer**, avoiding the 64KB D3D constant buffer cap. Soldier matrices: 1,000 x 16 floats = 64,000 bytes, inside a 64KB per-frame constant buffer. Per-frame upload buffers and two-frame GPU fences are retained.
- Night mode is enabled by default. The 1,000 moving spotlights use angled positions; at most 16 real 256x256 depth shadow maps are updated per frame. The light grid chooses up to 16 affecting lights per tile.
- Diagnostics now include FPS, the worst completed frame duration within the preceding one-second interval, average frame-buffer fence-wait time, CPU JS/LIGHT/DRAW/PRESENT averages, number of camera-visible trees, and route status. These **are not GPU timestamp metrics**.

Controls: **F1** whole forest (default); **F2** near red army; **F3** near blue army; **F4** A* debug paths; **F5** real shadow maps on/off; **F6** VSync; **F7** day/night; mouse drag/scroll to move camera; Space pause; Escape exit.

This build is intended to determine whether the present bridge can run at larger scales. Windows GitHub Actions tests JavaScript logic, native JS execution, DX12 compilation, HLSL shader compilation, and packaged updater. **Only a real Windows DX12-capable GPU can establish actual FPS, frame pacing, and correct final lighting/shadows**. Compare F1/F2, F5 shadows ON/OFF, F6 VSync OFF; avoid comparing F1 to the former v0.17 close camera as though workload were identical.

---

# NativeThreeBridge v0.17.0 — dark-night benchmark, smoother CPU and pathfinding

The DX12 demo now opens in **dark-night mode** by default. The 500 moving soldier spotlights are angled above/aside their units so tree/soldier shadows are easier to inspect. Use **F7** to switch between day and night, **F5** to switch depth shadows on/off, **F6** to toggle VSync, **F4** to show A* debug paths (off by default). Sunlight is not used for this test; the night terrain has only a tiny ambient fill.

Performance optimizations: reusable typed-array A* binary heap avoids per-node JavaScript allocations while preserving 12 searches/frame, direct copying of official Three.js InstancedMesh matrices without forced whole-scene matrix updates each frame, and one-time GPU-local DEFAULT heap upload of all 1000 static tree matrices. CPU timing breakdown in window title: JS frame, light processing, DX12 command recording and Present. High-resolution QueryPerformanceCounter delta replaces millisecond GetTickCount64 for simulation.

Night lighting remains an actual DX12 forward shading calculation for 500 moving lights (up to 16 per tile/pixel, 16 real moving shadow maps), not just fake translucent light decals. This is a native DX12-only night mode; the offline WebGL2 HTML benchmark is separate. GitHub Actions validates JS navigation, Windows compilation and HLSL shaders; real hardware FPS and shadow image validation need a Windows GPU.

---

# NativeThreeBridge v0.16.0 — DX12 performance fixes

DX12 performance pass (Windows):
- Replaced the unconditional per-frame GPU fence stall with backbuffer-specific fences, command allocators and per-frame dynamic upload buffers. CPU can prepare the next frame while the GPU is rendering the previous one.
- Moved static model vertex/index buffers to GPU-local DEFAULT memory using startup-only copy uploads.
- Compact per-light visible instance lists replace the original unconditional 1000 trees + 500 soldiers for *every* one of the 16 shadow maps. Conservative light-radius culling keeps local trees and soldiers casting shadows.
- F5 now stops rendering the shadow-map passes (it is no longer just a shader contribution toggle). F6 toggles VSync, OFF by default for uncapped benchmark comparisons.
- Device selection explicitly prefers the high-performance hardware adapter; title shows GPU, FPS, how many shadow instances are submitted, and VSync state.
- Dynamic A* routing, 1000 random trees, 500 moving soldiers and 500 dynamic lights remain in place.

**Benchmark protocol:** Run the [v0.15.0 release](https://github.com/orogdor/NativeThreeBridge/releases/tag/v0.15.0) and v0.16.0 on the same computer. Compare F2 and F3 close views, shadows F5 ON/OFF and VSync F6 OFF; allow the scene to settle before comparing FPS. The latest standalone [HTML WebGL2 v0.19](benchmarks/NativeThreeBridge-v019-SOLDIER-SHADOWS.html) uses a different lighting implementation and is not yet a perfectly equal GPU workload. GitHub Actions validates compilation and CPU tests; hardware FPS and real shadows require a physical Windows GPU test.

---

# NativeThreeBridge v0.15.0 — iga sõduri dünaamiline A* ja kokkupõrgete vältimine

## 500 sõdurit ei saa enam üksteisest läbi kõndida

Varasemates versioonides arvutati 500 A* marsruuti **ühekorraga stseeni alguses** ning sõdurid liikusid mööda neid sõltumata teiste üksuste asukohast. v0.15 eemaldab selle käitumise.

- **Ükski sõdur ei alusta ettearvutatud marsruudiga.** Iga üksus teeb enda A* otsingu siis, kui ta hakkab liikuma või vajab ummikust ümbersõitu.
- **A* arvestab ka teisi sõdureid**: puude hõivatud ruudud, teiste üksuste praegused ruudud ja nende reserveeritud järgmised ruudud on läbimatud. Otsitakse uus tee, kui järgmist ruutu ei saa kasutada.
- **Ruutude reserveerimine:** enne liikumist peab sõdur saama ainuõiguse järgmisele ruudule. Lähteruut jääb tema kasutusse, kuni sõdur jõuab uude ruutu. Seega pole kaks sõdurit samas ruudus ning ei teki vastassuunalisi ruuduvahetusi.
- **Ummikute lahendamine:** seisma jäänud üksus ootab lühidalt ja teeb seejärel uue A* otsingu. Otsingud jagatakse kaadrite vahel (kuni 12 otsingut kaadris), et 500 korraga arvutatavat marsruuti FPS-i ei blokeeriks.
- **Reaalajas individuaalsed käsud:** `__nativeThreeSetDestination(id, gridX, gridZ)` muudab valitud sõduri sihtkohta. Ta planeerib marsruudi uuesti, kui jõuab ohutult järgmisse ruutu.
- **500 sõdurit** (kaks 250-mehelist armeed), **1000 juhuslikku puud** ning **500 liikuvat Three.js-i SpotLight-valgustit** säilivad; 16 aktiivse DX12 varjukaardi piirang on sama.
- Sõdurite algusruudud on kahe ruudu vahedega. See jätab liikumiskoridorid ja vähendab kohe tekkivaid ummikuid.

Mänguakna pealkiri näitab nüüd näiteks `A* moving 500/500, planned 500, replans 36, waits 120`. See eristab uue raja otsimise ja teise sõduri järel ootamise.

## Testid ja tegelikud piirangud

JavaScripti automaattestid kontrollivad, et alguses on **0 planeeritud rada**, kõik 500 sõdurit teevad oma otsingu mängu ajal, lähte- ja sihtruutudel on eri omaniku vastu konfliktikaitse, dünaamilised liikumiskäsud põhjustavad uuesti planeerimise ning blokeeritud sihtruutu ei saa hõivata. Windowsi natiivne QuickJS-i test kontrollib samuti, et stseeni laadimisel radu ette ei arvutata.

Tegemist on **ruudustikupõhise üksuste kokkupõrketõkkega**, mitte veel täisfüüsikalise mudelite/speade kokkupõrkesüsteemiga. Muutunud rajad kuvatakse F4 diagnostikas valitud sõdurite proovimarsruutidena. DX12 tegeliku varjupildi ja FPS-i kontrollimiseks on jätkuvalt vaja Windowsi masinat.

## Eelnev v0.14 metsakatse

## Uus mets (1000 puud)

Männimudelid ei asu enam korrapäraselt 32×32 ruudustikuridades. **1000 puud** paigutatakse nüüd määratud metsapiirkonnas juhuslikesse kohtadesse, sh navigeerimisruudu keskpunktide vahele. Puudel on erinev pöördenurk ja suurus ning paiknemistihedus varieerub, tekitades looduslikuma mulje ja väikeseid lagendikke. Vähemalt umbes 6,15 maailmaühikut tüvede vahel vähendab kattumist. Kõik puud märgitakse A* takistuskaardile vastavalt nende tegelikele asukohtadele.

Mets kasutab fikseeritud juhuseemet `FOREST_SEED=173019` failis `game/scene.js`, et test oleks igal käivitamisel korratav. Seemne muutmisel tekib teistsugune mets ilma C++-koodi ümber kompileerimata.

Ülejäänud katse jääb samaks: **500 A* järgi liikuvat sõdurit**, **500 liikuvat valgustit**, **16 aktiivset DX12 varjukaarti** ning klahvid F1–F5 diagnostikaks. Eelmise versiooni kunstlik sirge puutõke on eemaldatud. Uued JavaScripti testid kontrollivad, et puude asukohad ei moodustaks ridu, tüved ei kattuks ja 500 sõduri teekonnad jääksid läbitavaks.

**Märkus:** GitHub Actions kontrollib JavaScripti, Windowsi EXE koostamist ja HLSL-i. Tegelik GPU pilt ja FPS vajavad jätkuvalt arvutis testimist.

## Eelmise v0.13 arenduse taust


## Mis v0.12 juures ei olnud nähtav

Eelmises versioonis ei tõestanud 500 A* raja olemasolu, et sõdurid ekraanil selgelt puude vahel pööraksid. Puud paiknesid korrapäraselt, armeed alustasid metsast kaugel ja kaamera oli väga kõrgel. 500 liikuva valgusti hulgas arvutati vaid 16 varjukaarti, mis valiti **metsa keskpunkti**, mitte kaamera lähedusse jäävate sõdurite järgi.

### Kontrollitavad parandused
- 1000 männist väike osa moodustab keskmise puutõkke koos läbipääsuga. **Kõik 500 sõdurit kasutavad päris A* rada**; testid kontrollivad nüüd ka ümberpõikeid ja suunamuutusi, mitte ainult raja olemasolu.
- Mõlemast armeest eksporditakse 6 päris A* teekonda JavaScriptist QuickJS-i kaudu DX12-sse. Need joonistatakse maapinnale **kollaste ja tsüaansete** heledate rajajoontena, mida saab F4-ga sisse/välja lülitada. Rajad ei ole C++-s väljamõeldud.
- **F1**: kogu 1000 puuga mets; **F2**: punase armee lähedane kaamera; **F3**: sinise armee lähedane kaamera; **F4**: A* rajajooned; **F5**: tegeliku DX12 varjutuse sisse/välja lülitamise võrdlus.
- 16 varjukaarti valitakse nüüd **kaamera sihtpunkti lähimate** liikuvate sõdurite valgusallikate järgi. Kõik 500 SpotLight-objekti jäävad alles; ainult 16-st arvutatakse samal kaadril sügavusvarjud.
- Tugevam valgus ja lähivaade aitavad varjusid eristada. FPS-i ja A* edenemise näidud on akna pealkirjas.

**Oluline:** GitHub Actions kontrollib endiselt Windowsi EXE koostamist, HLSL-i kompileerimist ja natiivset JavaScripti ning A* rajaandmete eksporti. See **ei tõesta füüsilise GPU valgustuspikslite tulemust**. Kui F5 sisse/välja ei muuda pilti ka F2 lähivaates, vajab DX12 varjude renderdus järgmise etapina GPU-pildikaadri analüüsi.

## Varasem põhiarhitektuur

## Why soldiers appeared stuck in v0.11

The scene calculated all 500 valid A* routes, but its movement loop discarded most elapsed time at low FPS by capping every render frame to **0.06 seconds**. At 5 FPS, only 0.30 simulated seconds advanced for one real second, making long routes across the 160×160 forest appear frozen.

**v0.12 fixes the time-step**: the JS waypoint-following loop accepts up to 0.5 seconds per frame (still capped against alt-tab/long suspension) and can cross multiple consecutive path cells safely. To make progress across the larger map visible, army movement speed was increased from ~6.2 to ~10.5 world units/second.

Windows title now displays **FPS, moving soldiers out of 500, traversed A* waypoints, and failed routes**. This distinguishes an actual route failure from slow animation or rendering.

Regression tests run **5 FPS versus 60 FPS for four simulated seconds**, verify equal soldier positions, and check that all 500 units progress. The native QuickJS/Windows smoke test additionally checks the live navigation status.

## Original v0.11 10× forest benchmark

Native Windows DirectX 12 prototype using official Three.js within QuickJS-NG, without a browser, Chromium or WebView.

## New forest benchmark

- **1000 original Sapling pines**, ten times the 100-tree population in v0.10. The forest expands to an approximately 32×32 tree-placement lattice (1024 candidate locations, 24 omitted to leave exactly 1000), retaining the previous 3-cell tree spacing. The visible forest footprint is roughly ten times larger.
- **Two armies of 250 Kuningriigid spearmen**, for 500 moving units. All 500 still have independent A* paths through the forest.
- **500 real moving Three.js spotlights**, one per soldier, with warm/cool army colors.
- **16 real-time shadow maps** chosen from the 500 lights each frame; other nearby lights illuminate without a depth shadow.
- Navigation expanded from **64×64 to 160×160 cells**. Tree-occupied cells are blocked; soldiers move on passable routes.
- GPU instancing still draws pine bark, pine foliage, red soldiers, and blue soldiers in four draw batches plus the ground.
- DX12 world, camera and 16×16 tiled-light coverage enlarged to match the forest.

### Windows/DX12 memory change

1000 trees + 500 soldiers require **1500 Matrix4 transforms** (96,000 bytes). This is larger than one DirectX12 constant-buffer-view limit of 64 KiB, so the engine uses **two GPU CBVs**: 1000 static tree transforms (64,000 bytes) and 500 dynamic soldier transforms (32,000 bytes). Tree transforms are uploaded once; soldier matrices are updated per frame. This preserves real Three.js Scene/InstancedMesh transforms, rather than replacing them with hardcoded C++ positions.

## Download and update

Use the latest [NativeThreeBridge Windows GitHub Release](https://github.com/orogdor/NativeThreeBridge/releases/latest). Keep the ZIP layout:

    NativeThree-Updater.exe  – separate SHA-256 verified updater
    NativeThree-Game.exe     – standalone native DX12 + QuickJS-NG + Three.js
    game/scene.js            – independently editable forest/army pathfinding

Close the game and open the updater to check for changed EXE and scene.js files, or run the game EXE directly. If PRESERVE-SCENE.txt exists, it protects local game script changes; remove it to install the new forest scene. NO-UPDATE.txt disables update checks.

Mouse drag rotates the camera, mouse wheel zooms, Space pauses, Esc closes. FPS appears in the window title.

## Verification boundary

GitHub Actions checks actual Three.js instancing, 1000 tree placements, 500 A* routes, native QuickJS matrix export, C++/DX12 compilation and HLSL shader compilation. Graphical rendering, GPU FPS and shadow appearance still need testing on Windows hardware. This remains a limited Three.js-to-DX12 adapter, not a complete WebGLRenderer/GLTFLoader replacement.

Original unchanged source assets: Kuningriigid `models-trellis-v262/odamees.glb`, `assets/sapling-trees/pine_01/mid.glb`.
