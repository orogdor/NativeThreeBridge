// A sea material like Kuningriigid V352: depth and shore read from a texture,
// more than 12 floats of uniforms (two colours, sky colour, a vec4 box,
// a vec2 origin, two scalars) and an alpha fade that discards dry pixels.
import * as THREE from 'three';
const renderer = new THREE.WebGLRenderer();
document.body.appendChild(renderer.domElement);
renderer.setSize(innerWidth, innerHeight);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 100);
camera.position.set(0, 3, 4);
camera.lookAt(0, 0, 0);
scene.add(new THREE.HemisphereLight('#ffffff', '#445533', 2));

const depth = new THREE.DataTexture(new Uint8Array([0, 255, 0, 255, 90, 160, 0, 255, 180, 60, 0, 255, 255, 0, 0, 255]), 2, 2);
depth.needsUpdate = true;
const time = { value: 0.5 };
window.setSeaTime = (t) => { time.value = t; };
const sea = new THREE.MeshStandardMaterial({ transparent: true, depthWrite: false, roughness: 0.14 });
sea.onBeforeCompile = (shader) => {
  Object.assign(shader.uniforms, {
    uTime: time, uFx: { value: 1 }, uDepth: { value: depth }, uBox: { value: new THREE.Vector4(-2, -2, 4, 4) },
    uDeep: { value: new THREE.Color('#1f4b55') }, uShallow: { value: new THREE.Color('#5e8466') },
    uSky: { value: new THREE.Color('#9fc3dd') }, uOrigin: { value: new THREE.Vector2(0.25, 0.75) },
  });
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vSeaP;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSeaP = position;');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>
      uniform float uTime; uniform float uFx; uniform sampler2D uDepth; uniform vec4 uBox;
      uniform vec3 uDeep; uniform vec3 uShallow; uniform vec3 uSky; uniform vec2 uOrigin;
      varying vec3 vSeaP;
      float seaD; float seaS;`)
    .replace('#include <color_fragment>', `#include <color_fragment>
      {vec2 sd = texture2D(uDepth, (vSeaP.xy + uOrigin - uBox.xy) / uBox.zw).rg; seaD = sd.r; seaS = sd.g;}
      vec3 water = mix(uDeep, uShallow, pow(seaS, 2.2) * .85);
      water = mix(water, uSky, .15 * uFx * (.5 + .5 * sin(vSeaP.x * 3.0 + uTime)));
      diffuseColor.rgb = water;
      diffuseColor.a = .94 - .36 * pow(seaS, 2.5);`)
    .replace('#include <opaque_fragment>', `float wet = smoothstep(-.12, .20, seaD); if (wet < .008) discard; diffuseColor.a *= wet;
      #include <opaque_fragment>`);
};
const plane = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), sea);
plane.rotation.x = -Math.PI / 2;
plane.name = 'sea';
scene.add(plane);
// Ground like Kuningriigid's detail map: nine photo textures blended in
// helper functions that take sampler2D parameters, an inout weight vector,
// one-value constructors (vec3(x)), a written global and a normal block.
const photo = (r, g, b) => { const t = new THREE.DataTexture(new Uint8Array([r, g, b, 255, g, b, r, 255, b, r, g, 255, r, r, b, 255]), 2, 2); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.needsUpdate = true; return t; };
const ground = new THREE.MeshStandardMaterial({ color: '#6f8f4a' });
ground.onBeforeCompile = (shader) => {
  const names = ['grass', 'soil', 'forest'], kinds = ['color', 'normal', 'rough'];
  let k = 0;
  for (const n of names) for (const kind of kinds) shader.uniforms[`uG_${n}_${kind}`] = { value: photo(40 + 20 * k, 200 - 15 * k, 90 + 10 * k++) };
  shader.uniforms.uReady = { value: 1 };
  shader.uniforms.uForest = { value: 0.3 };
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec2 vGroundL;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGroundL = position.xy;');
  const uniforms = names.flatMap((n) => kinds.map((kind) => `uniform sampler2D uG_${n}_${kind};`)).join('\n');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>
      ${uniforms}
      uniform float uReady; uniform float uForest;
      varying vec2 vGroundL;
      float bumpG; float sample;
      vec4 groundSample(sampler2D image, vec2 uv) { return mix(texture2D(image, uv), texture2D(image, uv * .73 + vec2(.37, .61)), .5); }
      vec3 groundColor(vec2 uv, inout vec3 w) {
        vec3 g = groundSample(uG_grass_color, uv).rgb, s = groundSample(uG_soil_color, uv).rgb, f = groundSample(uG_forest_color, uv).rgb;
        vec3 h = vec3(dot(g, vec3(.3, .59, .11)), dot(s, vec3(.3, .59, .11)), dot(f, vec3(.3, .59, .11))) * .55 + w;
        float top = max(h.x, max(h.y, h.z)) - .22;
        vec3 b = max(h - vec3(top), vec3(0.0)) * step(vec3(.001), w);
        w = b / max(b.x + b.y + b.z, 1e-4);
        return g * w.x + s * w.y + f * w.z;
      }
      vec3 groundNormal(vec2 uv, vec3 w) { return normalize((groundSample(uG_grass_normal, uv).xyz * w.x + groundSample(uG_soil_normal, uv).xyz * w.y + groundSample(uG_forest_normal, uv).xyz * w.z) * 2.0 - 1.0); }
      float groundRough(vec2 uv, vec3 w) { return groundSample(uG_grass_rough, uv).r * w.x + groundSample(uG_soil_rough, uv).r * w.y + groundSample(uG_forest_rough, uv).r * w.z; }`)
    .replace('#include <color_fragment>', `#include <color_fragment>
      vec3 gw = vec3(1.0 - uForest, .2, uForest);
      sample = .5; bumpG = .4;
      vec3 photoC = groundColor(vGroundL * .5, gw);
      diffuseColor.rgb = mix(diffuseColor.rgb, photoC, uReady * .88 * sample * 2.0);`)
    .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n roughnessFactor=mix(1.0,clamp(groundRough(vGroundL*.5,gw),.65,1.0),uReady);')
    .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
      { vec3 pn = groundNormal(vGroundL * .5, gw); const float e = .35;
        vec3 tX = normalize((viewMatrix * vec4(1.0, 0.0, 0.0, 0.0)).xyz);
        normal = normalize(normal + pn.x * tX * .32 * bumpG * e); }`);
};
const field = new THREE.Mesh(new THREE.PlaneGeometry(3, 3), ground);
field.position.set(0, -0.2, -2.5);
field.name = 'ground';
scene.add(field);

renderer.setAnimationLoop(() => renderer.render(scene, camera));
