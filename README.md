# NativeThreeBridge v0.14.0 — juhuslikult paigutatud mets

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
