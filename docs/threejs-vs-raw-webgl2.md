# Renderdamisteede eraldamine: Three.js ja lihtne WebGL2

NativeThreeBridge toetab kahte eri API-taset, kuid **mitte ühte ühist WebGL2/Three.js renderdajat**.

## 1. Tavapärane Three.js — vaikimisi

Jäta mängu kood muutmata:

```js
import * as THREE from 'three';
const renderer = new THREE.WebGLRenderer({ canvas: document.querySelector('#game') });
renderer.render(scene, camera);
```

NativeThreeBridge asendab sisemise `THREE.WebGLRenderer`-i oma `NativeRenderer`-iga. See ei kasuta katsetuslikku `canvas.getContext('webgl2')` silda. Canvas kuulub seejärel `native-three` renderdajale ja WebGL2 prototüüp ei saa seda hõivata.

## 2. Lihtne toor-WebGL2 — ainult selge opt-in

Ainult rakendustele, mille käsud ja GLSL-mustrid on selle osalise prototüübi poolt toetatud:

```html
<canvas id="raw" data-native-webgl2-prototype width="640" height="480"></canvas>
```
```js
const gl = document.querySelector('#raw').getContext('webgl2');
```

See `getContext('webgl2')` sild ei ole brauseri täielik WebGL2 implementatsioon.
Toetatud on lihtsad puhvrid, tavaline kolmnurga joonistamine ja väike hulk
tuvastatud GLSL-i profiile. K73 spetsiifilised GLSL- ja instantsimise
ligikaudsed tõlked jäävad **eksperimentaalseteks**, mitte üldiseks Three.js
mootori funktsionaalsuseks.

Ilma ülaltoodud atribuudita tagastab `canvas.getContext('webgl2')` `null`,
mitte osaliselt töötava WebGL2 konteksti.

## Eraldatuse reeglid

- Ühel canvasel saab olla üks aktiivne renderdusviis: `native-three`,
  `raw-webgl2` või `2d`.
- Pärast esimest konteksti loomist ei saa atribuudiga renderdajat vahetada.
- `THREE.WebGLRenderer` keeldub kasutamast lõuendit, millel on juba raw WebGL2 kontekst.
- Toores WebGL2 prototüüp keeldub kasutamast Three.js või Canvas 2D lõuendit.
- Tavapärased Three.js materjalid, shaderid ja ressursside käsitlus jäävad
  `NativeRenderer`-i omaks; raw-kihi `compileShader` ei kompileeri Three.js shadereid.
- Mõlemad suunavad lõpuks käsud NativeThreeBridge'i DX12 alamkihti. Kõigi
  nende käskude osas rakenduvad ühised DX12 turvapiirangud.
- Muudatused on ainult katseharus, `main` ja stabiilne EXE on muutmata.

## Automaattestid ilma kasutaja GPU-ta

`test/raw-webgl2-three-isolation.test.mjs` kontrollib:
1. lihtsa toor-WebGL2 näite renderduspakette ning canvas-konteksti lukustust;
2. 2D konteksti säilimist, kui WebGL2 opt-in lisatakse hiljem;
3. tavalise Three.js näite joonistusi ja geomeetriat;
4. et raw opt-in lisamine Three.js lõuendile ei asenda olemasolevat renderdajat.

K73 erifunktsioonide arendus on pausil. Selle jaoks ei käivitata kasutaja
RTX 2080 Superil uusi GPU-teste pärast 10.11.2026 Windowsi `0x1C7` BSOD-i.
