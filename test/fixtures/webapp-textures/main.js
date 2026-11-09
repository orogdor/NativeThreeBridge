import * as THREE from 'three';

const renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('world') });
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.02;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 100);
camera.position.set(0, 0, 6);
scene.add(new THREE.AmbientLight(0xffffff, 1));

// 1) GLB-style texture: image bytes -> Blob -> createImageBitmap -> THREE.Texture
const bytes = await (await fetch('icon.png')).arrayBuffer();
const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' }), { premultiplyAlpha: 'none' });
window.bitmapSize = [bitmap.width, bitmap.height];
const glbMap = new THREE.Texture(bitmap);
glbMap.flipY = false;
glbMap.colorSpace = THREE.SRGBColorSpace;
glbMap.needsUpdate = true;
bitmap.close(); // browsers allow this after upload; the engine uploads lazily
const leaf = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshStandardMaterial({ map: glbMap, alphaTest: 0.4, side: THREE.DoubleSide }));
leaf.name = 'leaf';
leaf.position.x = -2;
scene.add(leaf);

// 2) TextureLoader (flipY = true) with repeat wrapping
const loaded = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0xffffff }));
loaded.name = 'loaded';
scene.add(loaded);
new THREE.TextureLoader().load('icon.png', (t) => {
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(2, 2);
  loaded.material.map = t;
  loaded.material.needsUpdate = true;
  window.loaderDone = true;
});

// 3) Canvas 2D -> CanvasTexture -> Sprite (city icon style)
const c = document.createElement('canvas');
c.width = c.height = 64;
const g = c.getContext('2d');
g.fillStyle = 'rgba(30,20,11,.86)';
g.beginPath(); g.arc(32, 32, 28, 0, Math.PI * 2); g.fill();
g.strokeStyle = '#d9b673'; g.lineWidth = 3; g.stroke();
g.fillStyle = '#fff'; g.font = 'bold 38px Arial'; g.textAlign = 'center'; g.textBaseline = 'middle';
g.fillText('K', 32, 34);
const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
grad.addColorStop(0, 'rgba(255,220,150,1)'); grad.addColorStop(1, 'rgba(255,140,40,0)');
g.fillStyle = grad; g.fillRect(0, 0, 64, 64);
window.measured = g.measureText('Kuningriigid').width;
const icon = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false }));
icon.name = 'icon';
icon.scale.set(2, 2, 1);
icon.position.set(2, 1, 0);
scene.add(icon);

// 4) DataTexture
const data = new Uint8Array(4 * 4 * 4).fill(200);
const dataTex = new THREE.DataTexture(data, 4, 4);
dataTex.needsUpdate = true;
const floor = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), new THREE.MeshLambertMaterial({ map: dataTex }));
floor.position.y = -2;
scene.add(floor);

// 4a) ShaderMaterial with one direct texture sampler and unchanged UVs.
const shaderTextured = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShaderMaterial({
  uniforms: { uSurface: { value: glbMap } },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: 'uniform sampler2D uSurface; varying vec2 vUv; void main() { gl_FragColor = texture2D(uSurface, vUv); }',
}));
shaderTextured.name = 'shaderTextured';
shaderTextured.position.set(0, 1, 0);
scene.add(shaderTextured);

// 5) onBeforeCompile sea: the patch writes diffuseColor from two colour uniforms
const sea = new THREE.MeshStandardMaterial({ vertexColors: true, transparent: true, depthWrite: false, roughness: 0.14 });
sea.onBeforeCompile = (shader) => {
  shader.uniforms.uDeep = { value: new THREE.Color('#1f4b55') };
  shader.uniforms.uShallow = { value: new THREE.Color('#5e8466') };
  shader.fragmentShader = 'uniform vec3 uDeep; uniform vec3 uShallow;\n' + shader.fragmentShader.replace('#include <color_fragment>',
    '#include <color_fragment>\n vec3 seaC = mix(uDeep, uShallow, 0.3);\n diffuseColor.rgb = seaC;\n diffuseColor.a = .94 - .3 * 0.0;');
};
const water = new THREE.Mesh(new THREE.PlaneGeometry(10, 10), sea);
water.name = 'sea';
water.rotation.x = -Math.PI / 2;
water.position.y = -1;
scene.add(water);

// 5a) Generic onBeforeCompile coast fade: a custom float attribute drives
// smoothstep alpha in the fragment shader (without the engine running GLSL).
const coastGeo = new THREE.PlaneGeometry(1, 1);
coastGeo.setAttribute('aCoastFade', new THREE.Float32BufferAttribute([-0.3, -0.1, 0.1, 0.5], 1));
const coastMat = new THREE.MeshStandardMaterial({ color: 0x56789a, transparent: true, opacity: 0.72, depthWrite: false });
coastMat.onBeforeCompile = (shader) => {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nattribute float aCoastFade; varying float vFade;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFade=aCoastFade;');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying float vFade;')
    .replace('#include <opaque_fragment>', 'float fade=smoothstep(-.12,.20,vFade);if(fade<.008)discard;diffuseColor.a*=fade;\n#include <opaque_fragment>');
};
const coast = new THREE.Mesh(coastGeo, coastMat);
coast.name = 'coastFade';
coast.position.set(1, 0, 0);
scene.add(coast);

// 5b) fog-of-war parchment: alpha cut out by its own 'seen' texture (cannot run here: left out)
const seen = new THREE.DataTexture(new Uint8Array(16), 4, 4, THREE.RedFormat);
seen.needsUpdate = true;
const fogMat = new THREE.MeshBasicMaterial({ color: 0xd7c195, transparent: true, depthTest: false });
fogMat.onBeforeCompile = (shader) => {
  shader.uniforms.uSeen = { value: seen };
  shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', '#include <map_fragment>\n diffuseColor.a *= 1.0 - texture2D(uSeen, vec2(0.5)).r;');
};
const fog = new THREE.Mesh(new THREE.PlaneGeometry(10, 10), fogMat);
fog.name = 'fog';
scene.add(fog);

// 5c) river surface: transparency from RGBA vertex colours (alpha 0 over the sea)
const riverGeo = new THREE.PlaneGeometry(10, 10);
riverGeo.setAttribute('color', new THREE.Float32BufferAttribute(new Array(4).fill([0.2, 0.5, 0.1, 0]).flat(), 4));
const river = new THREE.Mesh(riverGeo, new THREE.MeshStandardMaterial({ vertexColors: true, transparent: true, depthWrite: false }));
river.name = 'river';
river.position.z = 0.4;
const reflection = { value: new THREE.Color('#738ab5') };
window.changeReflection = () => reflection.value.set('#102030');
river.material.onBeforeCompile = (shader) => {
  shader.uniforms.uSky = reflection;
  shader.fragmentShader = 'uniform vec3 uSky;\n' + shader.fragmentShader
    .replace('#include <color_fragment>', '#include <color_fragment>\n vec3 water = diffuseColor.rgb * .98; diffuseColor.rgb = water;')
    .replace('#include <opaque_fragment>', `
      vec3 V = normalize(vViewPosition);
      float angle = clamp(dot(V, normal), 0.0, 1.0);
      float fres = .03 + .97 * pow(1.0 - angle, 5.0);
      outgoingLight = mix(outgoingLight, uSky, clamp(fres * .75, 0.0, .75));
      diffuseColor.a = clamp(diffuseColor.a + fres * .35, 0.0, 1.0);
      #include <opaque_fragment>
    `);
};
scene.add(river);

// Opaque procedural surface using the same vertex inputs as world terrain.
const heightBlend = { value: 0.85 };
window.changeTerrainBlend = () => { heightBlend.value = 0.25; };
const strataMaterial = new THREE.MeshStandardMaterial({ color: '#426f45', side: THREE.DoubleSide });
strataMaterial.onBeforeCompile = (shader) => {
  shader.uniforms.uHeightBlend = heightBlend;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec3 patchPosition; varying vec3 patchNormal;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\npatchPosition=position; patchNormal=normalize(objectNormal);');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>
      varying vec3 patchPosition;
      varying vec3 patchNormal;
      uniform float uHeightBlend;
      float grain(vec2 p) { return fract(sin(dot(p, vec2(12.3, 34.5))) * 43.21); }
    `)
    .replace('#include <color_fragment>', `#include <color_fragment>
      float height = smoothstep(-.7, .7, patchPosition.y + .07 * grain(patchPosition.xz));
      float slope = 1.0 - abs(normalize(patchNormal).y);
      vec3 rock = mix(vec3(.22, .27, .36), vec3(.63, .72, .84), height);
      diffuseColor.rgb = mix(diffuseColor.rgb, rock, uHeightBlend * slope);
    `);
};
const strata = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 1.5), strataMaterial);
strata.position.set(-2, 1, 0);
scene.add(strata);

// 6) gradient sky dome (custom GLSL)
const sky = new THREE.Mesh(new THREE.SphereGeometry(50, 16, 8), new THREE.ShaderMaterial({
  side: THREE.BackSide, depthWrite: false,
  uniforms: { top: { value: new THREE.Color('#7fa9c8') }, horizon: { value: new THREE.Color('#d9e3dc') }, ground: { value: new THREE.Color('#a8b79a') } },
  vertexShader: 'varying vec3 vP;void main(){vP=normalize(position);gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);gl_Position.z=gl_Position.w;}',
  fragmentShader: 'uniform vec3 top,horizon,ground;varying vec3 vP;void main(){float h=vP.y;vec3 c=h>0.0?mix(horizon,top,h):mix(horizon,ground,-h);gl_FragColor=vec4(c,1.0);}',
}));
sky.name = 'sky';
sky.frustumCulled = false;
sky.renderOrder = -10;
scene.add(sky);

// 7) HTML minimap canvas: thousands of small rectangles
const mini = document.getElementById('mini').getContext('2d');
window.drawMini = (shift = 0) => {
  mini.fillStyle = '#1f5368';
  mini.fillRect(0, 0, 50, 50);
  for (let y = 0; y < 25; y++) for (let x = 0; x < 25; x++) {
    mini.fillStyle = (x + y + shift) % 3 ? '#a6b577' : '#65804f';
    mini.fillRect(x * 2, y * 2, 2, 2);
  }
  mini.strokeStyle = '#fff';
  mini.strokeRect(10.5, 10.5, 20, 15);
};
window.drawMini();

renderer.setAnimationLoop(() => renderer.render(scene, camera));
window.ready = true;
