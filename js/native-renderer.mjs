// NativeThreeBridge NativeRenderer: drop-in replacement for THREE.WebGLRenderer.
//
// The engine exports this class as `WebGLRenderer` from the 'three' module, so
// an unchanged webapp calling `new THREE.WebGLRenderer({ canvas })` gets native
// DX12 rendering instead of WebGL. render(scene, camera) walks the real
// Three.js scene graph and sends the engine:
//   * geometry buffers once (again only when an attribute version changes),
//   * InstancedMesh matrices/colours only when they change,
//   * textures once per image (encoded bytes are decoded natively),
//   * one compact Float32Array "pass" per render() call: camera, lights and
//     a fixed-size record per visible draw.
// This module has no imports so it can be unit tested with any THREE + fake nt.

// Header 55: render target texture id (0 = window).
// Header 56: shadow lights, 57: shadow views (map slices), 58: bone matrices,
// 59: shadow map size. After the lights come the shadow light records
// (SHADOW_LIGHT_FLOATS each: light index, first slice, kind (0, or 1 + near
// for point lights), bias, normalBias, radius, intensity, far), one
// view-projection per shadow view, the bone matrices, then the draws.
export const PASS_HEADER_FLOATS = 96;
export const LIGHT_FLOATS = 16;
export const DRAW_FLOATS = 96;
export const SHADOW_LIGHT_FLOATS = 8;
export const MAX_SHADOW_LIGHTS = 8, MAX_SHADOW_VIEWS = 16, MAX_BONES = 65536;
// Section offsets of a pass packet (same as webappPassLayout in webapp_host.h).
export function passLayout(p) {
  const lights = p[35], shadowLights = p[56], shadowViews = p[57], bones = p[58], draws = p[43];
  const shadowLightOffset = PASS_HEADER_FLOATS + lights * LIGHT_FLOATS;
  const shadowViewOffset = shadowLightOffset + shadowLights * SHADOW_LIGHT_FLOATS;
  const boneOffset = shadowViewOffset + shadowViews * 16;
  const drawOffset = boneOffset + bones * 16;
  return { lights, shadowLights, shadowViews, bones, draws, shadowLightOffset, shadowViewOffset, boneOffset, drawOffset, floats: drawOffset + draws * DRAW_FLOATS };
}
// Draw float 88: shadow bits (castShadow, receiveShadow, only in the shadow pass).
// 89: standard map bits (StandardMaps), 90..91 normalScale, 92 aoMapIntensity,
// 93: first bone + 1 of a SkinnedMesh skinned on the GPU (0: not skinned).
export const ShadowFlags = { CAST: 1, RECEIVE: 2, ONLY: 4 };
// Material maps besides `map`, bound to t1..t6 (bit i = slot i).
export const StandardMaps = { NORMAL: 1, ROUGHNESS: 2, METALNESS: 4, EMISSIVE: 8, AO: 16, ALPHA: 32 };
const STANDARD_MAP_KEYS = ['normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap', 'alphaMap'];
// Translated material stages: up to 28 uniform floats (draw floats 49..60 and 72..87).
const STAGE_UNIFORM_FLOATS = 28;
export const MAX_LIGHTS = 16;

export const LightType = { DIRECTIONAL: 3, POINT: 4, SPOT: 5, HEMISPHERE: 2 };
export const DrawFlags = {
  TRANSPARENT: 1, DOUBLE_SIDED: 2, BACK_SIDE: 4, VERTEX_COLORS: 8, UNLIT: 16,
  NO_DEPTH_WRITE: 32, NO_DEPTH_TEST: 64, LINES: 128, LINE_STRIP: 256,
  NORMAL_COLOR: 512, INSTANCE_COLORS: 1024, FLAT: 2048,
  MAP: 4096, MAP_REPEAT: 8192, MAP_MIRROR: 16384, FAR_DEPTH: 32768, NO_TONE_MAP: 65536, FOG: 131072, FRESNEL: 262144,
  // matrixWorld has a negative determinant (mirrored, e.g. scale -1 in a GLTF):
  // the triangle winding is reversed, as Three.js' WebGLRenderer flips frontFace.
  MIRRORED: 524288,
  ADDITIVE: 1048576, PREMULTIPLIED_ADDITIVE: 2097152,
  // InstancedMesh with at least one mirrored instance matrix (drawn without culling).
  INSTANCE_MIRRORED: 4194304,
};
// nt.uploadTexture(id, bytes, width, height, flags): width 0 = encoded file bytes.
export const TextureFlags = { SRGB: 1, MIPMAPS: 2 };
// Pass header [48]: tone mapping curve (same numbers as THREE.*ToneMapping).
export const ToneMapping = { NONE: 0, LINEAR: 1, REINHARD: 2, CINEON: 3, ACES: 4, AGX: 6, NEUTRAL: 7 };
export const PassFlags = { CLEAR_COLOR: 1, CLEAR_DEPTH: 2 };

function attributeVersion(attribute) {
  return attribute?.isInterleavedBufferAttribute ? attribute.data.version : attribute?.version;
}

// `shaders`: { ShaderLib, UniformsUtils } from three.module.js (not in three.core.js).
export function createNativeRendererClasses(THREE, nt, host = globalThis.__ntHost, shaders = {}) {
  const warnOnce = (key, text) => (host && host.warnOnce ? host.warnOnce(key, text) : undefined);
  const unsupported = (feature, detail) => (host && host.unsupported ? host.unsupported(feature, detail) : undefined);

  const _projScreen = new THREE.Matrix4();
  const _shadowViewProj = new THREE.Matrix4();
  const _identityMatrix = new THREE.Matrix4();
  const _skinBone = new THREE.Matrix4();
  const _faceMatrix = new THREE.Matrix4();
  const _faceProjection = new THREE.Matrix4();
  const _faceTarget = new THREE.Vector3();
  const _faceUp = new THREE.Vector3();
  const _sphere = THREE.Sphere ? new THREE.Sphere() : null; // (minimal fakes in unit tests lack it)
  // Point light shadows: six views (+x -x +y -y +z -z) slightly wider than 90
  // degrees, so the soft edge of one face still has map around it.
  const CUBE_DIRECTIONS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  const CUBE_UPS = [[0, 1, 0], [0, 1, 0], [0, 0, 1], [0, 0, 1], [0, 1, 0], [0, 1, 0]];
  const _frustum = new THREE.Frustum();
  const _vec = new THREE.Vector3();
  const _vec2 = new THREE.Vector3();
  const _color = new THREE.Color();
  const _srgb = { r: 0, g: 0, b: 0 };
  const _uvIdentity = new Float32Array(6);
  const _spriteScale = new THREE.Vector3();
  const _spriteQuat = new THREE.Quaternion();
  const _spriteTmp = new THREE.Matrix4();
  const defaultCompile = THREE.Material?.prototype.onBeforeCompile;
  const defaultCompileSource = defaultCompile?.toString();
  const hasCompilePatch = fn => !!fn && fn !== defaultCompile && fn.toString() !== defaultCompileSource;

  let nextGeometryId = 1;
  let nextInstanceId = 1;
  let nextTextureId = 1;
  const colorPatches = new Map();
  const shaderMaterials = new WeakMap();
  const attributeGetters = ['getX', 'getY', 'getZ', 'getW'];
  function registerMaterialStage(stage) {
    if (!stage) return null;
    let id = colorPatches.get(stage.source);
    if (id === undefined && colorPatches.size < 32) {
      id = colorPatches.size + 1;
      if (!nt.registerColorPatch(id, stage.source)) id = 0;
      colorPatches.set(stage.source, id);
    }
    return id ? { ...stage, id } : null;
  }
  const SHADER_IDS = { MeshStandardMaterial: 'standard', MeshPhysicalMaterial: 'physical', MeshLambertMaterial: 'lambert', MeshPhongMaterial: 'phong', MeshBasicMaterial: 'basic', MeshToonMaterial: 'toon', MeshMatcapMaterial: 'matcap' };

  class NativeRenderer {
    constructor(parameters = {}) {
      this.isWebGLRenderer = true; // many helpers test this flag
      this.isNativeRenderer = true;
      const canvas = parameters.canvas || (typeof document !== 'undefined' ? document.createElement('canvas') : { width: 300, height: 150, style: {} });
      this.domElement = canvas;
      // The HTML UI layer composites everything painted above this canvas.
      try { canvas._ntRendererCanvas = true; } catch { /* plain object */ }
      this.parameters = parameters;
      this.autoClear = true;
      this.autoClearColor = true;
      this.autoClearDepth = true;
      this.autoClearStencil = true;
      this.sortObjects = true;
      this.clippingPlanes = [];
      this.localClippingEnabled = false;
      this.outputColorSpace = THREE.SRGBColorSpace;
      this.toneMapping = THREE.NoToneMapping;
      this.toneMappingExposure = 1;
      this.transmissionResolutionScale = 1;
      this.shadowMap = { enabled: false, autoUpdate: true, needsUpdate: false, type: THREE.PCFShadowMap };
      this.info = {
        autoReset: true,
        memory: { geometries: 0, textures: 0 },
        render: { frame: 0, calls: 0, triangles: 0, points: 0, lines: 0 },
        programs: [],
        reset() { this.render.calls = 0; this.render.triangles = 0; this.render.points = 0; this.render.lines = 0; },
      };
      this.capabilities = {
        isWebGL2: true, precision: 'highp', logarithmicDepthBuffer: false, reverseDepthBuffer: false,
        maxTextures: 16, maxVertexTextures: 16, maxTextureSize: 16384, maxCubemapSize: 16384,
        maxAttributes: 16, maxVertexUniforms: 4096, maxVaryings: 16, maxFragmentUniforms: 4096, maxSamples: 4,
        vertexTextures: true, getMaxAnisotropy: () => 1, getMaxPrecision: () => 'highp',
        textureFormatReadable: () => true, textureTypeReadable: () => true,
      };
      this.extensions = { has: () => false, get: () => null, init() {} };
      this.properties = { get: () => ({}), remove() {}, update() {} };
      this.state = { reset() {}, buffers: { color: {}, depth: { setTest() {}, setMask() {} }, stencil: {} } };
      this.xr = {
        enabled: false, isPresenting: false, cameraAutoUpdate: true,
        addEventListener() {}, removeEventListener() {}, setReferenceSpaceType() {}, setFramebufferScaleFactor() {},
        getSession: () => null, getCamera: () => null, setAnimationLoop() {}, getController: () => new THREE.Group(),
        getControllerGrip: () => new THREE.Group(), getHand: () => new THREE.Group(),
      };
      this.debug = { checkShaderErrors: false, onShaderError: null };

      this._pixelRatio = 1;
      this._width = canvas.width || 300;
      this._height = canvas.height || 150;
      this._viewport = new THREE.Vector4(0, 0, this._width, this._height);
      this._scissor = new THREE.Vector4(0, 0, this._width, this._height);
      this._scissorTest = false;
      this._clearColor = new THREE.Color(0x000000);
      this._clearAlpha = parameters.alpha ? 0 : 1;
      this._renderTarget = null;
      this._pendingClear = 0;
      this._animationLoop = null;
      this._animationHandle = 0;
      this._geometries = new WeakMap();
      this._shaderGeometries = new WeakMap();
      this._instances = new WeakMap();
      this._textures = new WeakMap();   // THREE.Source -> { id, version, ok }
      this._patches = new WeakMap();    // material -> what its shader patch does to colours
      this._maskedGeometries = new WeakMap(); // geometry -> cached RGBA attribute-mask variants
      this._packet = new Float32Array(PASS_HEADER_FLOATS + MAX_LIGHTS * LIGHT_FLOATS + 256 * DRAW_FLOATS);
      this._opaque = [];
      this.collectTimings = false;
      this._transparent = [];
      this._lights = [];
      this._lastFrame = -1;
      this._disposed = false;
    }

    // ------------------------------------------------------------- sizing
    getContext() {
      const noop = () => {};
      return {
        canvas: this.domElement, drawingBufferWidth: this._width * this._pixelRatio, drawingBufferHeight: this._height * this._pixelRatio,
        getExtension: () => null, getParameter: () => 0, getSupportedExtensions: () => [], getContextAttributes: () => ({ alpha: this._clearAlpha < 1, antialias: true, depth: true, stencil: false, premultipliedAlpha: true, preserveDrawingBuffer: false }),
        isContextLost: () => false, viewport: noop, clear: noop, clearColor: noop, flush: noop, finish: noop,
      };
    }
    getContextAttributes() { return this.getContext().getContextAttributes(); }
    forceContextLoss() {}
    forceContextRestore() {}
    getPixelRatio() { return this._pixelRatio; }
    setPixelRatio(value) {
      if (value === undefined) return;
      this._pixelRatio = value;
      this.setSize(this._width, this._height, false);
    }
    getSize(target) { return target.set(this._width, this._height); }
    setSize(width, height, updateStyle = true) {
      this._width = width; this._height = height;
      this.domElement.width = Math.floor(width * this._pixelRatio);
      this.domElement.height = Math.floor(height * this._pixelRatio);
      if (updateStyle && this.domElement.style) {
        this.domElement.style.width = `${width}px`;
        this.domElement.style.height = `${height}px`;
      }
      this.setViewport(0, 0, width, height);
    }
    getDrawingBufferSize(target) { return target.set(this._width * this._pixelRatio, this._height * this._pixelRatio).floor(); }
    setDrawingBufferSize(width, height, pixelRatio) { this._pixelRatio = pixelRatio; this.setSize(width, height, false); }
    getCurrentViewport(target) { return target.copy(this._viewport).multiplyScalar(this._pixelRatio); }
    getViewport(target) { return target.copy(this._viewport); }
    setViewport(x, y, width, height) {
      if (x.isVector4) this._viewport.copy(x); else this._viewport.set(x, y, width, height);
    }
    getScissor(target) { return target.copy(this._scissor); }
    setScissor(x, y, width, height) { if (x.isVector4) this._scissor.copy(x); else this._scissor.set(x, y, width, height); }
    getScissorTest() { return this._scissorTest; }
    setScissorTest(enabled) { this._scissorTest = !!enabled; if (enabled) unsupported('renderer.setScissorTest', 'scissor rectangles are ignored'); }
    setOpaqueSort() {}
    setTransparentSort() {}

    // ------------------------------------------------------------- clearing
    getClearColor(target) { return target.copy(this._clearColor); }
    setClearColor(color, alpha) {
      this._clearColor.set(color);
      if (alpha !== undefined) this._clearAlpha = alpha;
    }
    getClearAlpha() { return this._clearAlpha; }
    setClearAlpha(alpha) { this._clearAlpha = alpha; }
    clear(color = true, depth = true) {
      if (color) this._pendingClear |= PassFlags.CLEAR_COLOR;
      if (depth) this._pendingClear |= PassFlags.CLEAR_DEPTH;
    }
    clearColor() { this.clear(true, false); }
    clearDepth() { this.clear(false, true); }
    clearStencil() {}

    // ------------------------------------------------------ render targets
    getRenderTarget() { return this._renderTarget; }
    setRenderTarget(target) {
      this._renderTarget = target || null;
      if (target) this._targetRecord(target);
    }
    // WebGLRenderTarget -> native render target (linear RGBA16F + depth) whose
    // colour is a texture id that materials can sample (target.texture).
    _targetRecord(target) {
      if (!this._targets) this._targets = new Map();
      if (target.isWebGLCubeRenderTarget || target.isCubeRenderTarget) { unsupported('Cube render targets (CubeCamera)'); return null; }
      if (target.textures && target.textures.length > 1) unsupported('Multiple render target attachments (MRT)', 'only the first is drawn');
      if (target.depthTexture) unsupported('WebGLRenderTarget.depthTexture', 'depth is not readable');
      if (!nt.createRenderTarget) { unsupported('Render targets (render-to-texture, post-processing)', 'those passes are skipped'); return null; }
      let record = this._targets.get(target);
      const width = Math.max(1, Math.round(target.width)), height = Math.max(1, Math.round(target.height));
      if (!record) {
        record = { id: nextTextureId++, width: 0, height: 0, ok: false };
        this._targets.set(target, record);
        if (!this._targetTextures) this._targetTextures = new WeakMap();
        const onDispose = () => {
          target.removeEventListener('dispose', onDispose);
          this._targets.delete(target);
          nt.releaseTexture(record.id);
        };
        target.addEventListener('dispose', onDispose);
      }
      if (record.width !== width || record.height !== height) {
        record.ok = !!nt.createRenderTarget(record.id, width, height);
        record.width = width; record.height = height;
        if (!record.ok) warnOnce('render-target-failed', `Render target ${width}x${height} could not be created`);
      }
      this._targetTextures.set(target.texture, record);
      return record.ok ? record : null;
    }
    getActiveCubeFace() { return 0; }
    getActiveMipmapLevel() { return 0; }
    readRenderTargetPixels() { unsupported('readRenderTargetPixels'); }
    readRenderTargetPixelsAsync() { unsupported('readRenderTargetPixelsAsync'); return Promise.resolve(); }
    copyFramebufferToTexture() { unsupported('copyFramebufferToTexture'); }
    copyTextureToTexture() { unsupported('copyTextureToTexture'); }
    initTexture() {}
    initRenderTarget() {}
    resetState() {}

    compile() { return new Set(); }
    compileAsync() { return Promise.resolve(); }
    dispose() {
      this._disposed = true;
      this.setAnimationLoop(null);
    }

    // --------------------------------------------------------- animation
    setAnimationLoop(callback) {
      this._animationLoop = callback;
      if (this._animationHandle) { cancelAnimationFrame(this._animationHandle); this._animationHandle = 0; }
      if (!callback) return;
      const loop = (time) => {
        if (this._animationLoop !== callback) return;
        this._animationHandle = requestAnimationFrame(loop);
        callback(time);
      };
      this._animationHandle = requestAnimationFrame(loop);
    }

    // ------------------------------------------------------------ uploads
    _geometryRecord(geometry, shaderInputs = null) {
      const position = geometry.attributes.position;
      if (!position) return null;
      const custom = shaderInputs?.map(input => geometry.attributes[input.name]);
      if (custom?.some((attr, i) => !attr || attr.itemSize !== shaderInputs[i].width || attr.count !== position.count)) return null;
      const versions = custom?.map(attributeVersion);
      const key = shaderInputs?.map(input => input.name).join(' ');
      let variants = key && this._shaderGeometries.get(geometry);
      let record = key ? variants?.get(key) : this._geometries.get(geometry);
      const normal = geometry.attributes.normal;
      const color = geometry.attributes.color;
      const uv = geometry.attributes.uv;
      const index = geometry.index;
      const pv = attributeVersion(position), nv = attributeVersion(normal), cv = attributeVersion(color);
      const uvv = attributeVersion(uv), iv = attributeVersion(index);
      if (record && record.position === position && record.normal === normal &&
          record.index === index && record.color === color && record.uv === uv &&
          record.pv === pv && record.nv === nv && record.cv === cv && record.uvv === uvv && record.iv === iv &&
          record.vertexCount === position.count && record.indexCount === (index?.count ?? 0) &&
          (!custom || custom.every((attr, i) => attr === record.custom[i] && versions[i] === record.versions[i]))) return record;
      if (!record) {
        record = { id: nextGeometryId++, revision: 0 };
        if (key) {
          if (!variants) this._shaderGeometries.set(geometry, variants = new Map());
          variants.set(key, record);
        } else this._geometries.set(geometry, record);
        this.info.memory.geometries++;
        const onDispose = () => {
          geometry.removeEventListener('dispose', onDispose);
          if (key) variants.delete(key); else this._geometries.delete(geometry);
          this.info.memory.geometries--;
          nt.releaseGeometry(record.id);
        };
        geometry.addEventListener('dispose', onDispose);
      }
      const positions = toFloat3(position);
      let normals = normal ? toFloat3(normal) : null;
      if (!normals) normals = computeNormals(THREE, position, index);
      const colors = color ? (color.itemSize === 4 ? toFloat4(color) : toFloat3(color)) : null;
      const uvs = uv ? toFloat2(uv) : null;
      let indices = null;
      if (index) indices = index.array instanceof Uint32Array ? index.array : Uint32Array.from(index.array);
      const gpuLocal = [position, normal, color, uv, index, ...(custom ?? [])].every(attribute =>
        !attribute || (attribute.isInterleavedBufferAttribute ? attribute.data.usage : attribute.usage) === THREE.StaticDrawUsage);
      let packed = null;
      if (custom?.length) {
        packed = new Float32Array(position.count * 4);
        let channel = 0;
        for (const attr of custom) {
          for (let i = 0; i < position.count; i++) {
            for (let j = 0; j < attr.itemSize; j++) packed[4 * i + channel + j] = attr[attributeGetters[j]](i);
          }
          channel += attr.itemSize;
        }
      }
      nt.uploadGeometry(record.id, positions, normals, colors, indices, uvs, gpuLocal, packed);
      Object.assign(record, { position, normal, color, uv, index, pv, nv, cv, uvv, iv, custom, versions,
        hasColors: !!colors, hasUvs: !!uvs, vertexCount: position.count, indexCount: index?.count ?? 0 });
      record.revision++;
      return record;
    }

    // A common onBeforeCompile pattern passes a float vertex attribute through a
    // varying and uses smoothstep() to fade its alpha (coasts, decals, foliage).
    // Approximate that ramp at vertices rather than drawing an opaque rectangle.
    // This works for arbitrary float attributes; it is not tied to game names.
    _maskedGeometryRecord(geometry, base, material, ramp, preserveRgb, colorRamp) {
      const mask = geometry.attributes[ramp.attribute];
      const vertexCount = base.vertexCount;
      if (!mask || mask.itemSize !== 1 || mask.count !== vertexCount) return null;
      let variants = this._maskedGeometries.get(geometry);
      if (!variants) {
        variants = new Map();
        this._maskedGeometries.set(geometry, variants);
        const onDispose = () => {
          for (const variant of variants.values()) {
            nt.releaseGeometry(variant.id);
            this.info.memory.geometries--;
          }
          variants.clear();
          this._maskedGeometries.delete(geometry);
          geometry.removeEventListener('dispose', onDispose);
        };
        geometry.addEventListener('dispose', onDispose);
      }
      let record = variants.get(material);
      if (!record) {
        record = { id: nextGeometryId++, key: '' };
        variants.set(material, record);
        this.info.memory.geometries++;
      }
      const original = geometry.attributes.color;
      const c0 = colorRamp?.from.value, c1 = colorRamp?.to.value;
      const colorKey = colorRamp ? [colorRamp.lo, colorRamp.hi, colorRamp.power, colorRamp.scale, c0.r, c0.g, c0.b, c1.r, c1.g, c1.b].join(':') : '';
      const key = `${base.revision}:${attributeVersion(mask)}:${ramp.lo}:${ramp.hi}:${preserveRgb}:${attributeVersion(original)}:${colorKey}`;
      if (key === record.key && record.mask === mask && record.colorAttribute === original) return record;
      const colors = new Float32Array(vertexCount * 4);
      for (let i = 0; i < vertexCount; i++) {
        const o = i * 4;
        colors[o] = preserveRgb && original ? original.getX(i) : 1;
        colors[o + 1] = preserveRgb && original && original.itemSize > 1 ? original.getY(i) : 1;
        colors[o + 2] = preserveRgb && original && original.itemSize > 2 ? original.getZ(i) : 1;
        const depth = mask.getX(i);
        if (colorRamp) {
          const weight = Math.pow(1 - smoothRamp(colorRamp.lo, colorRamp.hi, depth), colorRamp.power) * colorRamp.scale;
          colors[o] = c0.r + (c1.r - c0.r) * weight;
          colors[o + 1] = c0.g + (c1.g - c0.g) * weight;
          colors[o + 2] = c0.b + (c1.b - c0.b) * weight;
        }
        const alpha = smoothRamp(ramp.lo, ramp.hi, depth);
        colors[o + 3] = (preserveRgb && original && original.itemSize > 3 ? original.getW(i) : 1) * alpha;
      }
      const positions = toFloat3(geometry.attributes.position);
      const normals = geometry.attributes.normal ? toFloat3(geometry.attributes.normal)
        : computeNormals(THREE, geometry.attributes.position, geometry.index);
      const indices = geometry.index
        ? (geometry.index.array instanceof Uint32Array ? geometry.index.array : Uint32Array.from(geometry.index.array)) : null;
      const uvs = geometry.attributes.uv ? toFloat2(geometry.attributes.uv) : null;
      nt.uploadGeometry(record.id, positions, normals, colors, indices, uvs);
      Object.assign(record, { key, mask, colorAttribute: original, hasColors: true, hasUvs: !!uvs,
        vertexCount, indexCount: base.indexCount });
      return record;
    }

    // SkinnedMesh and morph targets: the deformed shape of this frame, computed
    // on the CPU the way Three.js' skinning/morph shader chunks do it, as a
    // geometry that shares every other attribute with the original.
    _deformedGeometry(mesh, geometry, gpuSkin = false) {
      const attributes = geometry.attributes;
      const skinned = !gpuSkin && mesh.isSkinnedMesh && mesh.skeleton && attributes.skinIndex && attributes.skinWeight;
      const morphs = geometry.morphAttributes?.position;
      const influences = mesh.morphTargetInfluences;
      const morphed = !!(morphs && morphs.length && influences && influences.length && !mesh.isInstancedMesh);
      if (!skinned && !morphed) return geometry;
      const source = attributes.position, sourceNormal = attributes.normal;
      const n = source.count;
      if (!this._deformed) this._deformed = new WeakMap();
      let d = this._deformed.get(mesh);
      if (!d || d.source !== geometry || d.count !== n || d.gpuSkin !== gpuSkin) {
        const g = new THREE.BufferGeometry();
        for (const [name, attr] of Object.entries(attributes)) if (name !== 'position' && name !== 'normal') g.setAttribute(name, attr);
        g.setIndex(geometry.index);
        g.groups = geometry.groups;
        g.drawRange = geometry.drawRange;
        g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
        g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
        let baseNormal = null;
        if (!sourceNormal) { // rest-pose normals, then deformed like real ones
          const rest = new THREE.BufferGeometry();
          rest.setAttribute('position', source);
          rest.setIndex(geometry.index);
          rest.computeVertexNormals();
          baseNormal = rest.attributes.normal.array.slice();
        }
        if (d) d.geometry.dispose();
        d = { geometry: g, source: geometry, count: n, frame: -1, baseNormal, work: new Float32Array(n * 6), bones: new Float32Array(0), gpuSkin };
        this._deformed.set(mesh, d);
      }
      const frame = this.info.render.frame;
      if (d.frame === frame) return d.geometry;
      d.frame = frame;
      const out = d.geometry.attributes.position.array, outN = d.geometry.attributes.normal.array;
      const work = d.work; // morphed position (0..3n) and normal (3n..6n)
      for (let i = 0; i < n; i++) {
        work[i * 3] = source.getX(i); work[i * 3 + 1] = source.getY(i); work[i * 3 + 2] = source.getZ(i);
        if (sourceNormal) {
          work[n * 3 + i * 3] = sourceNormal.getX(i); work[n * 3 + i * 3 + 1] = sourceNormal.getY(i); work[n * 3 + i * 3 + 2] = sourceNormal.getZ(i);
        } else {
          work[n * 3 + i * 3] = d.baseNormal[i * 3]; work[n * 3 + i * 3 + 1] = d.baseNormal[i * 3 + 1]; work[n * 3 + i * 3 + 2] = d.baseNormal[i * 3 + 2];
        }
      }
      if (morphed) {
        // morphTargetsRelative: p += w * delta; otherwise p += w * (target - base).
        const relative = geometry.morphTargetsRelative;
        const morphNormals = geometry.morphAttributes.normal;
        for (let k = 0; k < morphs.length && k < influences.length; k++) {
          const w = influences[k];
          if (!w) continue;
          const target = morphs[k], targetNormal = morphNormals?.[k];
          for (let i = 0; i < n; i++) {
            const o = i * 3;
            if (relative) {
              work[o] += w * target.getX(i); work[o + 1] += w * target.getY(i); work[o + 2] += w * target.getZ(i);
            } else {
              work[o] += w * (target.getX(i) - source.getX(i)); work[o + 1] += w * (target.getY(i) - source.getY(i)); work[o + 2] += w * (target.getZ(i) - source.getZ(i));
            }
            if (targetNormal) {
              const on = n * 3 + o;
              if (relative) { work[on] += w * targetNormal.getX(i); work[on + 1] += w * targetNormal.getY(i); work[on + 2] += w * targetNormal.getZ(i); }
              else if (sourceNormal) {
                work[on] += w * (targetNormal.getX(i) - sourceNormal.getX(i)); work[on + 1] += w * (targetNormal.getY(i) - sourceNormal.getY(i));
                work[on + 2] += w * (targetNormal.getZ(i) - sourceNormal.getZ(i));
              }
            }
          }
        }
      }
      if (skinned) {
        const skeleton = mesh.skeleton;
        if (skeleton._ntFrame !== frame) { skeleton.update(); skeleton._ntFrame = frame; }
        // Per bone: bindMatrixInverse * boneMatrix * bindMatrix (skinning_vertex).
        const boneCount = skeleton.bones.length;
        if (d.bones.length < boneCount * 16) d.bones = new Float32Array(boneCount * 16);
        const bm = skeleton.boneMatrices;
        for (let b = 0; b < boneCount; b++) {
          _skinBone.fromArray(bm, b * 16).premultiply(mesh.bindMatrixInverse).multiply(mesh.bindMatrix);
          d.bones.set(_skinBone.elements, b * 16);
        }
        const bones = d.bones, skinIndex = attributes.skinIndex, skinWeight = attributes.skinWeight;
        for (let i = 0; i < n; i++) {
          const o = i * 3, on = n * 3 + o;
          const x = work[o], y = work[o + 1], z = work[o + 2], nx = work[on], ny = work[on + 1], nz = work[on + 2];
          let px = 0, py = 0, pz = 0, qx = 0, qy = 0, qz = 0, total = 0;
          for (let j = 0; j < 4; j++) {
            const w = skinWeight.getComponent(i, j);
            if (!w) continue;
            const b = skinIndex.getComponent(i, j);
            if (b >= boneCount) continue;
            const e = b * 16;
            px += w * (bones[e] * x + bones[e + 4] * y + bones[e + 8] * z + bones[e + 12]);
            py += w * (bones[e + 1] * x + bones[e + 5] * y + bones[e + 9] * z + bones[e + 13]);
            pz += w * (bones[e + 2] * x + bones[e + 6] * y + bones[e + 10] * z + bones[e + 14]);
            qx += w * (bones[e] * nx + bones[e + 4] * ny + bones[e + 8] * nz);
            qy += w * (bones[e + 1] * nx + bones[e + 5] * ny + bones[e + 9] * nz);
            qz += w * (bones[e + 2] * nx + bones[e + 6] * ny + bones[e + 10] * nz);
            total += w;
          }
          if (total > 0) {
            out[o] = px; out[o + 1] = py; out[o + 2] = pz;
            const len = Math.hypot(qx, qy, qz) || 1;
            outN[o] = qx / len; outN[o + 1] = qy / len; outN[o + 2] = qz / len;
          } else {
            out[o] = x; out[o + 1] = y; out[o + 2] = z; outN[o] = nx; outN[o + 1] = ny; outN[o + 2] = nz;
          }
        }
      } else {
        out.set(work.subarray(0, n * 3));
        for (let i = 0; i < n; i++) {
          const o = n * 3 + i * 3, len = Math.hypot(work[o], work[o + 1], work[o + 2]) || 1;
          outN[i * 3] = work[o] / len; outN[i * 3 + 1] = work[o + 1] / len; outN[i * 3 + 2] = work[o + 2] / len;
        }
      }
      d.geometry.attributes.position.needsUpdate = true;
      d.geometry.attributes.normal.needsUpdate = true;
      return d.geometry;
    }

    // GPU skinning: skinIndex/skinWeight of a geometry record (indices outside
    // the skeleton get weight 0), uploaded again when they change.
    _skinRecord(record, geometry, boneCount) {
      const si = geometry.attributes.skinIndex, sw = geometry.attributes.skinWeight;
      const key = `${record.id}:${record.revision}:${attributeVersion(si)}:${attributeVersion(sw)}:${boneCount}`;
      if (record.skinKey === key) return record.skinOk;
      const n = record.vertexCount;
      if (si.count !== n || sw.count !== n) { record.skinKey = key; record.skinOk = false; return false; }
      const indices = new Float32Array(n * 4), weights = new Float32Array(n * 4);
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < 4; j++) {
          const b = j < si.itemSize ? si.getComponent(i, j) : 0;
          const w = j < sw.itemSize ? sw.getComponent(i, j) : 0;
          const valid = b >= 0 && b < boneCount;
          indices[i * 4 + j] = valid ? b : 0;
          weights[i * 4 + j] = valid ? w : 0;
        }
      }
      record.skinKey = key;
      record.skinOk = !!nt.uploadSkin(record.id, indices, weights, n);
      return record.skinOk;
    }
    // Bone matrices of a SkinnedMesh for this pass: bindMatrixInverse * bone *
    // bindMatrix (skinning_vertex). Returns the index of the first one.
    _addBones(mesh) {
      const skeleton = mesh.skeleton, frame = this.info.render.frame;
      if (skeleton._ntFrame !== frame) { skeleton.update(); skeleton._ntFrame = frame; }
      const count = skeleton.bones.length, first = this._boneCount;
      if (first + count > MAX_BONES) return -1;
      if (this._bones.length < (first + count) * 16) {
        const grown = new Float32Array(Math.max(this._bones.length * 2, (first + count) * 16));
        grown.set(this._bones.subarray(0, first * 16));
        this._bones = grown;
      }
      const bm = skeleton.boneMatrices;
      for (let b = 0; b < count; b++) {
        _skinBone.fromArray(bm, b * 16).premultiply(mesh.bindMatrixInverse).multiply(mesh.bindMatrix);
        this._bones.set(_skinBone.elements, (first + b) * 16);
      }
      this._boneCount += count;
      return first;
    }

    _instanceRecord(mesh) {
      let record = this._instances.get(mesh);
      const im = mesh.instanceMatrix, ic = mesh.instanceColor;
      if (!record) {
        record = { id: nextInstanceId++, matrixVersion: -1, colorVersion: -1, colorRef: null, count: -1 };
        this._instances.set(mesh, record);
        const onDispose = () => {
          mesh.removeEventListener('dispose', onDispose);
          this._instances.delete(mesh);
          nt.releaseInstances(record.id);
        };
        mesh.addEventListener('dispose', onDispose);
      }
      const capacity = im.count;
      if (record.matrixVersion !== im.version || record.colorRef !== ic || (ic && record.colorVersion !== ic.version) || record.count !== capacity) {
        const matrices = im.array instanceof Float32Array ? im.array : Float32Array.from(im.array);
        const colors = ic ? (ic.array instanceof Float32Array ? ic.array : Float32Array.from(ic.array)) : null;
        nt.uploadInstances(record.id, matrices, colors, capacity);
        // A mirrored instance (negative determinant) needs per-instance face culling.
        record.mirrored = false;
        for (let i = 0, o = 0; i < capacity; i++, o += 16) {
          const det = matrices[o] * (matrices[o + 5] * matrices[o + 10] - matrices[o + 6] * matrices[o + 9]) -
            matrices[o + 4] * (matrices[o + 1] * matrices[o + 10] - matrices[o + 2] * matrices[o + 9]) +
            matrices[o + 8] * (matrices[o + 1] * matrices[o + 6] - matrices[o + 2] * matrices[o + 5]);
          if (det < 0) { record.mirrored = true; break; }
        }
        record.matrixVersion = im.version;
        record.colorVersion = ic ? ic.version : -1;
        record.colorRef = ic;
        record.count = capacity;
      }
      return record;
    }

    // One native texture per image (THREE.Source), re-sent when needsUpdate.
    _textureRecord(texture) {
      if (texture && texture.isRenderTargetTexture) {
        const record = this._targetTextures?.get(texture);
        return record && record.ok ? record : null;
      }
      if (!texture || !texture.isTexture || texture.isCubeTexture || texture.isCompressedTexture || texture.isData3DTexture || texture.isDataArrayTexture || texture.isVideoTexture) return null;
      const source = texture.source || texture;
      const image = source.data !== undefined ? source.data : texture.image;
      if (!image) return null;
      let record = this._textures.get(source);
      if (!record) {
        record = { id: nextTextureId++, version: -1, srgb: null, ok: false };
        this._textures.set(source, record);
        this.info.memory.textures++;
        const onDispose = () => {
          texture.removeEventListener('dispose', onDispose);
          if (this._textures.get(source) !== record) return;
          this._textures.delete(source);
          this.info.memory.textures--;
          if (nt.releaseTexture) nt.releaseTexture(record.id);
        };
        texture.addEventListener('dispose', onDispose);
      }
      const srgb = texture.colorSpace === THREE.SRGBColorSpace;
      const version = source.version !== undefined ? source.version : texture.version;
      if (record.version !== version || record.srgb !== srgb || (image.isCanvasNative && record.canvasVersion !== image._ntCanvasVersion)) {
        record.version = version; record.srgb = srgb;
        let flags = srgb ? TextureFlags.SRGB : 0;
        const mips = texture.generateMipmaps !== false && texture.minFilter !== THREE.NearestFilter && texture.minFilter !== THREE.LinearFilter;
        if (mips) flags |= TextureFlags.MIPMAPS;
        record.ok = false;
        try { record.ok = !!this._sendTexture(record, image, texture, flags); } catch (e) { warnOnce(`texture-${record.id}`, `Texture upload failed: ${e && e.message || e}`); }
      }
      return record.ok ? record : null;
    }
    _sendTexture(record, image, texture, flags) {
      if (!nt.uploadTexture) { unsupported('Textures', 'this engine build has no texture upload'); return false; }
      const src = image._ntSource;
      if (src) {
        if (src.bytes) return nt.uploadTexture(record.id, src.bytes, 0, 0, flags);
        if (src.path) return nt.uploadTexture(record.id, new Uint8Array(nt.readBinary(src.path)), 0, 0, flags);
        if (src.rgba) return nt.uploadTexture(record.id, rgba8(src.rgba), src.w, src.h, flags);
        if (src.canvas) return this._sendCanvas(record, src.canvas, flags);
      }
      if (image._ntCanvas !== undefined || (typeof image.getContext === 'function' && image.localName === 'canvas')) return this._sendCanvas(record, image, flags);
      if (image.data && image.width > 0 && image.height > 0) { // DataTexture
        const px = dataTexturePixels(THREE, image, texture);
        if (!px) { unsupported(`DataTexture format ${texture.format}/${texture.type}`, 'drawn untextured'); return false; }
        return nt.uploadTexture(record.id, px, image.width, image.height, flags);
      }
      return false;
    }
    _sendCanvas(record, canvas, flags) {
      // Canvas 2D drawings live natively (js/webapp-shim.js canvas commands).
      if (!canvas._ntCanvasId || !nt.uploadCanvasTexture) { unsupported('Canvas textures', 'canvas textures stay blank'); return false; }
      if (canvas._ntFlushCanvas) canvas._ntFlushCanvas();
      record.canvasVersion = canvas._ntCanvasVersion;
      return nt.uploadCanvasTexture(record.id, canvas._ntCanvasId, flags);
    }
    // material.onBeforeCompile patches GLSL the engine cannot run. Run the
    // patch once against Three.js' own shader source and remember which
    // colour uniforms it writes into diffuseColor, so the surface at least
    // gets the intended colour (e.g. a sea that mixes deep/shallow colours).
    _patchInfo(m) {
      let info = this._patches.get(m);
      if (info && info.fn === m.onBeforeCompile && info.version === m.version) return info;
      info = { fn: m.onBeforeCompile, version: m.version, colors: null, alpha: null, hide: false, alphaRamp: null, colorRamp: null, reflection: null, colorStage: null };
      this._patches.set(m, info);
      const ShaderLib = shaders.ShaderLib || THREE.ShaderLib, UniformsUtils = shaders.UniformsUtils || THREE.UniformsUtils;
      const lib = ShaderLib && UniformsUtils && ShaderLib[SHADER_IDS[m.type]];
      if (!lib) return info;
      try {
        const shader = { shaderName: m.type, uniforms: UniformsUtils.clone(lib.uniforms), vertexShader: lib.vertexShader, fragmentShader: lib.fragmentShader, defines: Object.assign({}, m.defines) };
        const before = new Set(Object.keys(shader.uniforms));
        m.onBeforeCompile(shader, this);
        const added = Object.entries(shader.uniforms).filter(([k, u]) => !before.has(k) && u && u.value && u.value.isColor);
        if (nt.registerColorPatch) info.colorStage = registerMaterialStage(translateMaterialStage(shader));
        const palette = new Map(added);
        info.colors = diffusePalette(shader.fragmentShader, palette);
        info.reflection = outgoingReflection(shader.fragmentShader, palette);
        const a = /diffuseColor\.a\s*=\s*([0-9]*\.?[0-9]+)/.exec(shader.fragmentShader);
        if (a) info.alpha = parseFloat(a[1]);
        // Alpha cut out by a texture of the patch's own (fog-of-war masks, reveal effects):
        // drawing the surface whole would cover the scene, so it is left out.
        const maskTextures = Object.entries(shader.uniforms).some(([k, u]) => !before.has(k) && u && u.value && u.value.isTexture);
        if (maskTextures && m.transparent && /diffuseColor\.a\s*(\*=|=)|gl_FragColor\.a\s*(\*=|=)/.test(shader.fragmentShader)) info.hide = true;
        info.alphaRamp = attributeAlphaRamp(shader.vertexShader, shader.fragmentShader);
        if (info.alphaRamp) {
          info.colorRamp = attributeColorRamp(shader.vertexShader, shader.fragmentShader, info.alphaRamp.attribute, palette);
        }
      } catch (e) { warnOnce(`patch-${m.uuid}`, `material.onBeforeCompile could not be inspected: ${e && e.message || e}`); }
      return info;
    }

    // ---------------------------------------------------------------- render
    render(scene, camera) {
      // Debug aid: tests and tools inspect what the game drew last.
      globalThis.__ntLastRender = { scene, camera, renderer: this };
      if (this._disposed) return;
      if (!camera || !camera.isCamera) { warnOnce('render-no-camera', 'render() called without a camera'); return; }
      const target = this._renderTarget ? this._targetRecord(this._renderTarget) : null;
      if (this._renderTarget && !target) return; // unsupported target: skip, do not draw to the screen

      const timings = this.collectTimings ? {} : null;
      let start = timings ? performance.now() : 0;
      if (scene.matrixWorldAutoUpdate !== false) scene.updateMatrixWorld();
      if (camera.parent === null && camera.matrixWorldAutoUpdate !== false) camera.updateMatrixWorld();
      if (timings) { const now = performance.now(); timings.matrices = now - start; start = now; }
      if (this.info.autoReset) this.info.reset();
      this.info.render.frame++;

      if (scene.onBeforeRender) scene.onBeforeRender(this, scene, camera, this._renderTarget);
      _projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      _frustum.setFromProjectionMatrix(_projScreen, camera.coordinateSystem);

      const opaque = this._opaque, transparent = this._transparent, lights = this._lights;
      opaque.length = 0; transparent.length = 0; lights.length = 0;
      const ambient = [0, 0, 0];
      this._spriteCount = 0;
      this._shadowLights = this._shadowLights || [];
      this._shadowLights.length = 0;
      this._shadowViewCount = 0;
      this._boneCount = 0;
      if (!this._bones) this._bones = new Float32Array(1024);
      this._offscreenCasters = this._offscreenCasters || [];
      this._offscreenCasters.length = 0;
      this._collect(scene, camera, opaque, transparent, lights, ambient);
      const shadowLights = this.shadowMap.enabled ? this._shadowLights : [];
      if (shadowLights.length) {
        if (!this._shadowViews) this._shadowViews = new Float32Array(MAX_SHADOW_VIEWS * 16);
        for (const entry of shadowLights) this._shadowCamera(entry);
        // Casters outside the camera view whose shadow falls inside a shadow camera.
        this._shadowPass = true;
        for (const mesh of this._offscreenCasters) {
          if (shadowLights.some(entry => this._castsInto(entry, mesh))) this._addMesh(mesh, camera, opaque, transparent);
        }
        this._shadowPass = false;
      }
      if (timings) { const now = performance.now(); timings.collect = now - start; start = now; }

      if (this.sortObjects) {
        opaque.sort((a, b) => a.renderOrder - b.renderOrder || a.z - b.z);
        transparent.sort((a, b) => a.renderOrder - b.renderOrder || b.z - a.z);
      }
      if (timings) { const now = performance.now(); timings.sort = now - start; start = now; }

      // ---- pass header
      const drawCount = opaque.length + transparent.length;
      const lightCount = Math.min(lights.length, MAX_LIGHTS);
      if (lights.length > MAX_LIGHTS) warnOnce('too-many-lights', `Only the first ${MAX_LIGHTS} lights are used (scene has ${lights.length})`);
      const shadowCount = shadowLights.length, viewCount = shadowCount ? this._shadowViewCount : 0, boneCount = this._boneCount;
      const floats = PASS_HEADER_FLOATS + lightCount * LIGHT_FLOATS + shadowCount * SHADOW_LIGHT_FLOATS + viewCount * 16 +
        boneCount * 16 + drawCount * DRAW_FLOATS;
      if (this._packet.length < floats) this._packet = new Float32Array(Math.ceil(floats * 1.5));
      const p = this._packet;
      p.fill(0, 0, PASS_HEADER_FLOATS);
      p.set(camera.matrixWorldInverse.elements, 0);
      p.set(camera.projectionMatrix.elements, 16);
      _vec.setFromMatrixPosition(camera.matrixWorld);
      p[32] = _vec.x; p[33] = _vec.y; p[34] = _vec.z; p[35] = lightCount;
      // Clear colour leaves as display (sRGB) values; everything else is linear.
      const bg = scene.background;
      let alpha = this._clearAlpha;
      if (bg && bg.isColor) { bg.getRGB(_srgb, THREE.SRGBColorSpace); alpha = 1; }
      else {
        if (bg) unsupported('scene.background textures/cube maps', 'using the clear colour');
        this._clearColor.getRGB(_srgb, THREE.SRGBColorSpace);
      }
      p[36] = _srgb.r; p[37] = _srgb.g; p[38] = _srgb.b; p[39] = alpha;
      p[40] = ambient[0]; p[41] = ambient[1]; p[42] = ambient[2]; p[43] = drawCount;
      let flags = this._pendingClear;
      if (this.autoClear) {
        if (this.autoClearColor) flags |= PassFlags.CLEAR_COLOR;
        if (this.autoClearDepth) flags |= PassFlags.CLEAR_DEPTH;
      }
      this._pendingClear = 0;
      p[44] = flags;
      p[45] = target ? target.width : this._width; p[46] = target ? target.height : this._height;
      p[55] = target ? target.id : 0;
      p[47] = this.toneMappingExposure;
      const tm = this.toneMapping;
      p[48] = tm === THREE.LinearToneMapping ? ToneMapping.LINEAR : tm === THREE.ReinhardToneMapping ? ToneMapping.REINHARD
        : tm === THREE.CineonToneMapping ? ToneMapping.CINEON : tm === THREE.ACESFilmicToneMapping ? ToneMapping.ACES
          : tm === THREE.AgXToneMapping ? ToneMapping.AGX : tm === THREE.NeutralToneMapping ? ToneMapping.NEUTRAL : ToneMapping.NONE;
      if (tm === THREE.CustomToneMapping) unsupported('CustomToneMapping', 'no tone mapping is applied');
      const fog = scene.fog;
      p[56] = shadowCount; p[57] = viewCount; p[58] = boneCount;
      if (shadowCount) {
        // One map size for the whole array: the largest mapSize, kept under ~160 MB.
        let size = 256;
        for (const { light } of shadowLights) size = Math.max(size, Math.min(4096, light.shadow.mapSize.x || 512));
        while (size > 512 && size * size * 4 * viewCount > 160 * 1024 * 1024) size /= 2;
        p[59] = size;
      }
      if (fog?.isFog || fog?.isFogExp2) {
        fog.color.getRGB(_srgb, THREE.SRGBColorSpace);
        p[49] = _srgb.r; p[50] = _srgb.g; p[51] = _srgb.b;
        p[52] = fog.isFogExp2 ? 2 : 1;
        p[53] = fog.isFogExp2 ? fog.density : fog.near;
        p[54] = fog.far ?? 0;
      }

      let o = PASS_HEADER_FLOATS;
      for (let i = 0; i < lightCount; i++, o += LIGHT_FLOATS) writeLight(p, o, lights[i]);
      for (const entry of shadowLights) {
        const ls = entry.light.shadow, point = entry.light.isPointLight;
        p[o] = entry.index; p[o + 1] = entry.first; p[o + 2] = point ? 1 + ls.camera.near : 0;
        p[o + 3] = ls.bias; p[o + 4] = ls.normalBias; p[o + 5] = ls.radius; p[o + 6] = ls.intensity ?? 1;
        p[o + 7] = point ? ls.camera.far : 0;
        o += SHADOW_LIGHT_FLOATS;
      }
      if (viewCount) { p.set(this._shadowViews.subarray(0, viewCount * 16), o); o += viewCount * 16; }
      if (boneCount) { p.set(this._bones.subarray(0, boneCount * 16), o); o += boneCount * 16; }
      for (const d of opaque) { writeDraw(p, o, d); o += DRAW_FLOATS; }
      for (const d of transparent) { writeDraw(p, o, d); o += DRAW_FLOATS; }

      this.info.render.calls += drawCount;
      if (timings) { const now = performance.now(); timings.pack = now - start; start = now; }
      nt.submitPass(p, floats);
      if (timings) { timings.submit = performance.now() - start; this.lastRenderTimings = timings; }
      if (scene.onAfterRender) scene.onAfterRender(this, scene, camera, this._renderTarget);
    }

    _collect(object, camera, opaque, transparent, lights, ambient) {
      if (object.visible === false) return;
      const layerVisible = object.layers.test(camera.layers);
      if (layerVisible) {
        // Three.js updates LOD before visiting its children. Kuningriigid's
        // Sapling trees use this callback to reveal or populate instanced meshes.
        if (object.isLOD && object.autoUpdate !== false) object.update(camera);
        if (object.isLight) this._addLight(object, lights, ambient);
        else if (object.isMesh || object.isLine) this._addMesh(object, camera, opaque, transparent);
        else if (object.isPoints) this._addPoints(object, camera, opaque, transparent);
        else if (object.isSprite) this._addSprite(object, camera, opaque, transparent);
      }
      const children = object.children;
      for (let i = 0; i < children.length; i++) this._collect(children[i], camera, opaque, transparent, lights, ambient);
    }

    _addLight(light, lights, ambient) {
      const c = light.color, k = light.intensity;
      if (light.isAmbientLight) { ambient[0] += c.r * k; ambient[1] += c.g * k; ambient[2] += c.b * k; return; }
      if (light.isLightProbe) { unsupported('LightProbe'); return; }
      if (light.isRectAreaLight) { unsupported('RectAreaLight'); return; }
      const rec = { type: 0, r: c.r * k, g: c.g * k, b: c.b * k, px: 0, py: 0, pz: 0, distance: 0, dx: 0, dy: -1, dz: 0, decay: 2, extra0: 0, extra1: 0, extra2: 0, shadow: 0 };
      _vec.setFromMatrixPosition(light.matrixWorld);
      rec.px = _vec.x; rec.py = _vec.y; rec.pz = _vec.z;
      if (light.isHemisphereLight) {
        rec.type = LightType.HEMISPHERE;
        _vec2.copy(_vec).normalize();
        rec.dx = _vec2.x; rec.dy = _vec2.y; rec.dz = _vec2.z;
        const g = light.groundColor; rec.extra0 = g.r * k; rec.extra1 = g.g * k; rec.extra2 = g.b * k;
      } else if (light.isDirectionalLight || light.isSpotLight) {
        _vec2.setFromMatrixPosition(light.target.matrixWorld).sub(_vec);
        if (_vec2.lengthSq() < 1e-12) _vec2.set(0, -1, 0);
        _vec2.normalize();
        rec.dx = _vec2.x; rec.dy = _vec2.y; rec.dz = _vec2.z;
        if (light.isDirectionalLight) rec.type = LightType.DIRECTIONAL;
        else {
          rec.type = LightType.SPOT; rec.distance = light.distance; rec.decay = light.decay;
          rec.extra0 = Math.cos(light.angle); rec.extra1 = Math.cos(light.angle * (1 - light.penumbra));
          if (light.map) unsupported('SpotLight.map');
        }
      } else if (light.isPointLight) {
        rec.type = LightType.POINT; rec.distance = light.distance; rec.decay = light.decay;
      } else return;
      lights.push(rec);
      if (light.castShadow && light.shadow && this.shadowMap.enabled) {
        // Directional and spot lights: one shadow map slice; point lights: six (cube faces).
        const views = light.isPointLight ? 6 : 1;
        if (this._shadowLights.length < MAX_SHADOW_LIGHTS && this._shadowViewCount + views <= MAX_SHADOW_VIEWS && lights.length <= MAX_LIGHTS) {
          this._shadowLights.push({ light, index: lights.length - 1, first: this._shadowViewCount, views, frustum: null, position: new THREE.Vector3() });
          rec.shadow = this._shadowLights.length;
          this._shadowViewCount += views;
        } else warnOnce('shadow-lights', `Shadows of at most ${MAX_SHADOW_LIGHTS} lights (${MAX_SHADOW_VIEWS} map slices, a point light uses 6) are drawn per render()`);
      }
    }

    // View-projection of every shadow map slice of one light.
    _shadowCamera(entry) {
      const light = entry.light, ls = light.shadow, out = this._shadowViews;
      if (light.isPointLight) {
        const near = ls.camera.near, far = ls.camera.far, t = near * 1.05;
        _faceProjection.makePerspective(-t, t, t, -t, near, far);
        entry.position.setFromMatrixPosition(light.matrixWorld);
        for (let face = 0; face < 6; face++) {
          const d = CUBE_DIRECTIONS[face], u = CUBE_UPS[face];
          _faceTarget.set(entry.position.x + d[0], entry.position.y + d[1], entry.position.z + d[2]);
          _faceUp.set(u[0], u[1], u[2]);
          _faceMatrix.lookAt(entry.position, _faceTarget, _faceUp).setPosition(entry.position).invert();
          _shadowViewProj.multiplyMatrices(_faceProjection, _faceMatrix);
          out.set(_shadowViewProj.elements, (entry.first + face) * 16);
        }
        return;
      }
      if (!light.target.parent) light.target.updateMatrixWorld();
      ls.updateMatrices(light);
      entry.frustum = ls.getFrustum();
      _shadowViewProj.multiplyMatrices(ls.camera.projectionMatrix, ls.camera.matrixWorldInverse);
      out.set(_shadowViewProj.elements, entry.first * 16);
    }
    _castsInto(entry, mesh) {
      if (entry.frustum) return entry.frustum.intersectsObject(mesh);
      const geometry = mesh.geometry;
      if (!geometry.boundingSphere) geometry.computeBoundingSphere();
      _sphere.copy(geometry.boundingSphere).applyMatrix4(mesh.matrixWorld);
      return _sphere.center.distanceTo(entry.position) - _sphere.radius <= entry.light.shadow.camera.far;
    }

    // THREE.Sprite: a camera-facing textured quad (SpriteMaterial is unlit).
    _addSprite(sprite, camera, opaque, transparent) {
      const m = sprite.material;
      if (!m || !m.visible) return;
      if (sprite.frustumCulled && !_frustum.intersectsSprite(sprite)) return;
      const record = this._geometryRecord(this._spriteQuad());
      if (!record) return;
      _vec.setFromMatrixPosition(sprite.matrixWorld);
      _spriteScale.setFromMatrixScale(sprite.matrixWorld);
      if (m.sizeAttenuation === false && camera.isPerspectiveCamera) {
        _vec2.copy(_vec).applyMatrix4(camera.matrixWorldInverse);
        _spriteScale.multiplyScalar(-_vec2.z);
      }
      _spriteQuat.setFromRotationMatrix(camera.matrixWorld);
      // model = T(position) * R(camera) * Rz(rotation) * S(scale) * T(0.5 - center)
      const matrix = this._spriteMatrix(this._spriteCount++);
      matrix.makeTranslation(0.5 - sprite.center.x, 0.5 - sprite.center.y, 0);
      _spriteTmp.makeScale(_spriteScale.x, _spriteScale.y, 1); matrix.premultiply(_spriteTmp);
      if (m.rotation) { _spriteTmp.makeRotationZ(m.rotation); matrix.premultiply(_spriteTmp); }
      _spriteTmp.makeRotationFromQuaternion(_spriteQuat); matrix.premultiply(_spriteTmp);
      _spriteTmp.makeTranslation(_vec.x, _vec.y, _vec.z); matrix.premultiply(_spriteTmp);
      _vec.applyMatrix4(_projScreen);
      const proxy = { isSprite: true, matrixWorld: matrix, renderOrder: sprite.renderOrder || 0, name: sprite.name, type: 'Sprite', geometry: this._spriteGeometry };
      this._queue({ mesh: proxy, record, instances: null, z: _vec.z }, m, 0, 6, opaque, transparent);
    }
    _spriteQuad() {
      if (!this._spriteGeometry) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
        g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
        g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
        g.setIndex([0, 1, 2, 0, 2, 3]);
        this._spriteGeometry = g;
      }
      return this._spriteGeometry;
    }

    // THREE.Points: every point is a camera-facing quad of PointsMaterial.size
    // (pixels, shrinking with distance when sizeAttenuation), all points of
    // one object in a single instanced draw.
    _addPoints(points, camera, opaque, transparent) {
      const geometry = points.geometry, m = points.material;
      if (!geometry || !geometry.attributes || !geometry.attributes.position || !m) return;
      if (Array.isArray(m)) { unsupported('THREE.Points with several materials'); return; }
      if (!m.visible) return;
      if (points.frustumCulled && geometry.boundingSphere !== undefined && !_frustum.intersectsObject(points)) return;
      if (!m.isPointsMaterial) unsupported('THREE.Points with ' + m.type, 'drawn as PointsMaterial squares');
      const position = geometry.attributes.position, colorAttr = geometry.attributes.color;
      const range = geometry.drawRange;
      const first = Math.max(0, range.start);
      const last = Math.min(position.count, range.start + range.count);
      let count = last - first;
      if (count <= 0) return;
      if (count > 262144) { warnOnce('points-cap', 'Only the first 262144 points of a THREE.Points are drawn'); count = 262144; }
      const quad = this._geometryRecord(this._spriteQuad());
      if (!quad) return;
      if (!this._pointRecords) this._pointRecords = new Map();
      let rec = this._pointRecords.get(points);
      if (!rec) {
        rec = { id: nextInstanceId++, matrices: new Float32Array(0), colors: null };
        this._pointRecords.set(points, rec);
        const onDispose = () => {
          points.removeEventListener('dispose', onDispose);
          this._pointRecords.delete(points);
          nt.releaseInstances(rec.id);
        };
        points.addEventListener('dispose', onDispose);
      }
      if (rec.matrices.length < count * 16) rec.matrices = new Float32Array(Math.ceil(count * 1.25) * 16);
      const useColors = !!(m.vertexColors && colorAttr);
      if (useColors && (!rec.colors || rec.colors.length < count * 3)) rec.colors = new Float32Array(Math.ceil(count * 1.25) * 3);
      const ce = camera.matrixWorld.elements;
      _vec2.set(ce[0], ce[1], ce[2]).normalize();
      const rx = _vec2.x, ry = _vec2.y, rz = _vec2.z;
      _vec2.set(ce[4], ce[5], ce[6]).normalize();
      const ux = _vec2.x, uy = _vec2.y, uz = _vec2.z;
      _vec2.set(ce[8], ce[9], ce[10]).normalize();
      const fx = _vec2.x, fy = _vec2.y, fz = _vec2.z;
      const cx = ce[12], cy = ce[13], cz = ce[14];
      const height = Math.max(1, this._height || 1);
      const size = m.size ?? 1;
      let perPixelAtDepth = 0, fixedWorld = 0;
      if (camera.isPerspectiveCamera) {
        const tanHalf = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) / (camera.zoom || 1);
        if (m.sizeAttenuation !== false) fixedWorld = size * tanHalf;      // gl_PointSize = size * (h/2) / -z
        else perPixelAtDepth = 2 * tanHalf / height;                       // constant size in pixels
      } else {
        fixedWorld = size * (camera.top - camera.bottom) / (camera.zoom || 1) / height;
      }
      const out = rec.matrices, colors = rec.colors, mw = points.matrixWorld;
      let zSum = 0;
      for (let i = 0; i < count; i++) {
        _vec.fromBufferAttribute(position, first + i).applyMatrix4(mw);
        const depth = (cx - _vec.x) * fx + (cy - _vec.y) * fy + (cz - _vec.z) * fz; // distance in front of the camera
        zSum += depth;
        const w = fixedWorld || size * perPixelAtDepth * Math.max(depth, 0);
        const o = i * 16;
        out[o] = rx * w; out[o + 1] = ry * w; out[o + 2] = rz * w; out[o + 3] = 0;
        out[o + 4] = ux * w; out[o + 5] = uy * w; out[o + 6] = uz * w; out[o + 7] = 0;
        out[o + 8] = fx; out[o + 9] = fy; out[o + 10] = fz; out[o + 11] = 0;
        out[o + 12] = _vec.x; out[o + 13] = _vec.y; out[o + 14] = _vec.z; out[o + 15] = 1;
        if (useColors) {
          colors[i * 3] = colorAttr.getX(first + i); colors[i * 3 + 1] = colorAttr.getY(first + i); colors[i * 3 + 2] = colorAttr.getZ(first + i);
        }
      }
      nt.uploadInstances(rec.id, out.subarray(0, count * 16), useColors ? colors.subarray(0, count * 3) : null, count);
      _vec.set(cx - fx * zSum / count, cy - fy * zSum / count, cz - fz * zSum / count).applyMatrix4(_projScreen);
      const proxy = {
        isPoints: true, matrixWorld: _identityMatrix, renderOrder: points.renderOrder || 0, name: points.name, type: 'Points',
        geometry: this._spriteGeometry, count, instanceColor: useColors ? colorAttr : null, castShadow: false, receiveShadow: false,
      };
      this._queue({ mesh: proxy, record: quad, instances: rec, z: _vec.z }, m, 0, 6, opaque, transparent);
      this.info.render.points += count;
    }

    _spriteMatrix(i) {
      if (!this._spriteMatrices) this._spriteMatrices = [];
      return this._spriteMatrices[i] || (this._spriteMatrices[i] = new THREE.Matrix4());
    }

    _addMesh(mesh, camera, opaque, transparent) {
      const geometry = mesh.geometry;
      if (!geometry || !geometry.isBufferGeometry || !geometry.attributes.position) return;
      if (mesh.isInstancedMesh && mesh.count === 0) return;
      if (mesh.frustumCulled && !this._shadowPass && !_frustum.intersectsObject(mesh)) {
        // Off screen, but its shadow may still fall into the view.
        if (mesh.castShadow && this.shadowMap.enabled) this._offscreenCasters.push(mesh);
        return;
      }
      if (mesh.isBatchedMesh) { unsupported('BatchedMesh'); return; }
      // SkinnedMesh: bones applied in the vertex shader (CPU only without engine support).
      const gpuSkin = !!(mesh.isSkinnedMesh && mesh.skeleton && geometry.attributes.skinIndex && geometry.attributes.skinWeight &&
        nt.uploadSkin && !this._noGpuSkin);
      let shape = this._deformedGeometry(mesh, geometry, gpuSkin);
      let record = this._geometryRecord(shape);
      if (!record) return;
      let bones = 0;
      if (gpuSkin) {
        const first = this._skinRecord(record, shape, mesh.skeleton.bones.length) ? this._addBones(mesh) : -1;
        if (first >= 0) bones = first + 1;
        else { // not possible here: skin on the CPU
          if (!record.skinOk) { this._noGpuSkin = true; warnOnce('gpu-skinning', 'GPU skinning is not available: SkinnedMesh is skinned on the CPU'); }
          shape = this._deformedGeometry(mesh, geometry, false);
          record = this._geometryRecord(shape);
          if (!record) return;
        }
      }
      if (mesh.onBeforeRender !== THREE.Object3D.prototype.onBeforeRender) mesh.onBeforeRender(this, null, camera, geometry, mesh.material, null);
      const instances = mesh.isInstancedMesh ? this._instanceRecord(mesh) : null;
      _vec.setFromMatrixPosition(mesh.matrixWorld).applyMatrix4(_projScreen);
      const z = _vec.z;
      const total = record.indexCount || record.vertexCount;
      const range = geometry.drawRange;
      const base = { mesh, record, instances, z, bones };
      if (Array.isArray(mesh.material)) {
        const groups = geometry.groups.length ? geometry.groups : [{ start: 0, count: total, materialIndex: 0 }];
        for (const group of groups) {
          const material = mesh.material[group.materialIndex];
          if (!material || !material.visible) continue;
          const start = Math.max(group.start, range.start);
          const end = Math.min(group.start + group.count, range.start + range.count, total);
          if (end > start) this._queue(base, material, start, end - start, opaque, transparent);
        }
      } else if (mesh.material && mesh.material.visible) {
        const start = Math.max(0, range.start);
        const end = Math.min(total, range.start + range.count);
        if (end > start) this._queue(base, mesh.material, start, end - start, opaque, transparent);
      }
    }

    _queue(base, material, start, count, opaque, transparent) {
      const m = material, mesh = base.mesh;
      let flags = 0;
      if (mesh.isLine) {
        flags |= DrawFlags.UNLIT | (mesh.isLineSegments ? DrawFlags.LINES : DrawFlags.LINE_STRIP);
        if (mesh.isLineLoop) unsupported('LineLoop', 'drawn as an open line');
      }
      if (m.transparent) flags |= DrawFlags.TRANSPARENT;
      if (m.side === THREE.DoubleSide) flags |= DrawFlags.DOUBLE_SIDED;
      else if (m.side === THREE.BackSide) flags |= DrawFlags.BACK_SIDE;
      if (m.vertexColors && base.record.hasColors) flags |= DrawFlags.VERTEX_COLORS;
      if (m.depthWrite === false) flags |= DrawFlags.NO_DEPTH_WRITE;
      if (m.depthTest === false) flags |= DrawFlags.NO_DEPTH_TEST;
      if (m.flatShading) flags |= DrawFlags.FLAT;
      if (base.instances && mesh.instanceColor) flags |= DrawFlags.INSTANCE_COLORS;
      if (base.instances?.mirrored) flags |= DrawFlags.INSTANCE_MIRRORED;
      if (!mesh.isSprite && mesh.matrixWorld.determinant() < 0) flags |= DrawFlags.MIRRORED;
      let roughness = 1, metalness = 0, shininess = -1;
      let color = m.color || null, opacity = m.opacity ?? 1;
      let shaderMap = null, reflection = null, reflectionMask = false, colorStage = null;
      if (m.isMeshBasicMaterial || m.isLineBasicMaterial || m.isLineDashedMaterial) flags |= DrawFlags.UNLIT;
      else if (m.isSpriteMaterial || m.isPointsMaterial || mesh.isPoints) flags |= DrawFlags.UNLIT | DrawFlags.DOUBLE_SIDED;
      else if (m.isMeshNormalMaterial) flags |= DrawFlags.NORMAL_COLOR;
      else if (m.isMeshStandardMaterial) { roughness = m.roughness; metalness = m.metalness; }
      else if (m.isMeshPhongMaterial) { shininess = m.shininess; roughness = Math.sqrt(2 / (m.shininess + 2)); }
      else if (m.isMeshLambertMaterial || m.isMeshToonMaterial) { roughness = 1; }
      else if (m.isShadowMaterial) return;
      else if (m.isShaderMaterial || m.isRawShaderMaterial) {
        if (nt.registerColorPatch) {
          let cached = shaderMaterials.get(m);
          if (!cached || cached.version !== m.version) {
            cached = { version: m.version, stage: registerMaterialStage(translateMaterialStage(m, true)) };
            shaderMaterials.set(m, cached);
          }
          colorStage = cached.stage;
        }
        if (colorStage) {
          flags |= DrawFlags.UNLIT;
        } else {
          // Keep the existing color-map and palette fallbacks for other GLSL.
          const fragment = m.fragmentShader || '';
          const samplers = [...fragment.matchAll(/\b(?:texture2D|texture)\s*\(\s*([A-Za-z_]\w*)\s*,\s*vUv\s*\)/g)];
          if (samplers.length === 1 && m.uniforms && m.uniforms[samplers[0][1]]?.value?.isTexture &&
              /\bvarying\s+vec2\s+vUv\b/.test(fragment) &&
              /\bvUv\s*=\s*uv\s*;/.test(m.vertexShader || '')) {
            shaderMap = m.uniforms[samplers[0][1]].value;
            if (!m.lights) flags |= DrawFlags.UNLIT;
          }
          const shaderColors = Object.entries(m.uniforms ?? {}).filter(([, u]) => u?.value?.isColor);
          if (shaderColors.length) {
            color = mixColors(_color, colorWeights(shaderColors, fragment));
            if (!m.lights) flags |= DrawFlags.UNLIT;
            unsupported('ShaderMaterial / custom GLSL', 'drawn in the colour of its colour uniforms');
          } else if (!shaderMap) {
            unsupported('ShaderMaterial / custom GLSL', `drawn as a plain lit surface (${m.type})`);
          }
          if (/gl_Position\.z\s*=\s*gl_Position\.w/.test(m.vertexShader || '')) flags |= DrawFlags.FAR_DEPTH;
        }
        // OutputPass: <tonemapping_pars_fragment> + a *_TONE_MAPPING define = the renderer's tone mapping.
        const toneMapped = /tonemapping_fragment/.test(m.fragmentShader || '') ||
          (/#include\s+<tonemapping_pars_fragment>/.test(m.fragmentShader || '') && Object.keys(m.defines ?? {}).some((k) => /_TONE_MAPPING$/.test(k)));
        if (!toneMapped) flags |= DrawFlags.NO_TONE_MAP;
      }
      else if (m.isMeshMatcapMaterial) unsupported('MeshMatcapMaterial', 'drawn as lit colour');
      else if (m.isMeshDepthMaterial || m.isMeshDistanceMaterial) return;
      if (m.toneMapped === false) flags |= DrawFlags.NO_TONE_MAP;
      if (m.fog !== false && (!(m.isShaderMaterial || m.isRawShaderMaterial) ||
          (m.fog && /#include\s+<fog_fragment>/.test(m.fragmentShader)))) flags |= DrawFlags.FOG;
      if (m.envMap || m.lightMap || m.bumpMap || m.displacementMap) {
        unsupported('envMap / lightMap / bumpMap / displacementMap', 'drawn without them');
      }
      if (m.wireframe) unsupported('Wireframe materials', 'drawn solid');
      if (hasCompilePatch(m.onBeforeCompile)) {
        const patch = this._patchInfo(m);
        // A translated stage evaluates the texture mask itself; only untranslated masks are left out.
        if (patch.hide && !patch.colorStage) { unsupported('material.onBeforeCompile alpha masks', 'surfaces cut out by their own texture are not drawn'); return; }
        colorStage = patch.colorStage;
        if (colorStage?.attributes.length) {
          const geometry = this._geometryRecord(mesh.geometry, colorStage.attributes);
          if (geometry) base = { ...base, record: geometry };
          else colorStage = null;
        }
        if (!colorStage && patch.colors) {
          color = mixColors(_color, patch.colors);
          flags &= ~(DrawFlags.VERTEX_COLORS | DrawFlags.INSTANCE_COLORS);
          unsupported('material.onBeforeCompile shader patches', 'patched surfaces use the colours the patch mixes');
        } else if (!colorStage) unsupported('material.onBeforeCompile shader patches');
        if (patch.reflection) {
          flags |= DrawFlags.FRESNEL;
          reflection = patch.reflection;
        }
        if (!colorStage && patch.alpha !== null && m.transparent) opacity = patch.alpha * (m.opacity ?? 1);
        if (!colorStage && patch.alphaRamp && mesh.geometry) {
          const masked = this._maskedGeometryRecord(mesh.geometry, base.record, m, patch.alphaRamp, !!(m.vertexColors && !patch.colors && !patch.colorRamp), patch.colorRamp);
          if (masked) {
            base = { ...base, record: masked };
            if (patch.colorRamp) color = null; // RGB comes from the same attribute as the mask.
            reflectionMask = true;
            flags |= DrawFlags.VERTEX_COLORS;
          }
        }
      }
      if (m.clippingPlanes && m.clippingPlanes.length) unsupported('Clipping planes');
      if (m.blending !== undefined && m.blending === THREE.AdditiveBlending) {
        flags |= DrawFlags.ADDITIVE | DrawFlags.TRANSPARENT;
        if (m.premultipliedAlpha) flags |= DrawFlags.PREMULTIPLIED_ADDITIVE;
      }
      // colour map
      let textureId = 0;
      const uvt = _uvIdentity;
      uvt[0] = 1; uvt[1] = 0; uvt[2] = 0; uvt[3] = 1; uvt[4] = 0; uvt[5] = 0;
      const colorMap = m.map || shaderMap;
      // u' = a u + c v + e ; v' = b u + d v + f  (D3D rows run top-down: flipY mirrors v)
      const setUv = (map) => {
        if (map.matrixAutoUpdate) map.updateMatrix();
        const e = map.matrix.elements;
        let a = e[0], b = e[1], c = e[3], d = e[4], tx = e[6], ty = e[7];
        // Render target textures: rows run top-down in the engine, v = 0 is the bottom in Three.js.
        if (map.flipY || map.isRenderTargetTexture) { b = -b; d = -d; ty = 1 - ty; }
        uvt[0] = a; uvt[1] = b; uvt[2] = c; uvt[3] = d; uvt[4] = tx; uvt[5] = ty;
      };
      let uvSource = null;
      if (colorMap && base.record.hasUvs) {
        const tex = this._textureRecord(colorMap);
        if (tex) {
          const map = colorMap;
          textureId = tex.id;
          flags |= DrawFlags.MAP;
          if (map.wrapS === THREE.RepeatWrapping || map.wrapT === THREE.RepeatWrapping) flags |= DrawFlags.MAP_REPEAT;
          else if (map.wrapS === THREE.MirroredRepeatWrapping || map.wrapT === THREE.MirroredRepeatWrapping) flags |= DrawFlags.MAP_MIRROR;
          setUv(map);
          uvSource = map;
        }
      }
      // normalMap, roughnessMap, metalnessMap, emissiveMap, aoMap, alphaMap:
      // sampled with the colour map's uv transform (or the first of them).
      let stdMaps = 0, stdTextures = null;
      if (!colorStage && base.record.hasUvs) {
        for (let slot = 0; slot < STANDARD_MAP_KEYS.length; slot++) {
          const texture = m[STANDARD_MAP_KEYS[slot]];
          if (!texture || !texture.isTexture) continue;
          const tex = this._textureRecord(texture);
          if (!tex) continue;
          if (!uvSource) { setUv(texture); uvSource = texture; }
          (stdTextures ||= [])[slot] = { id: tex.id, texture, std: true };
          stdMaps |= 1 << slot;
        }
      }
      const normalScale = m.normalScale;
      const uvFlip = uvSource?.flipY ? -1 : 1;
      const emissive = m.emissive || null;
      const ei = m.emissiveIntensity ?? 1;
      const draw = {
        geometryId: base.record.id, instanceId: base.instances ? base.instances.id : 0,
        instanceCount: base.instances ? mesh.count : 1, flags, start, count,
        roughness, metalness, shininess, textureId, alphaTest: m.alphaTest || 0,
        ua: uvt[0], ub: uvt[1], uc: uvt[2], ud: uvt[3], ue: uvt[4], uf: uvt[5],
        r: color && color.isColor ? color.r : 1, g: color && color.isColor ? color.g : 1, b: color && color.isColor ? color.b : 1,
        opacity, reflection, reflectionMask, colorStage,
        materialTextures: colorStage ? colorStage.textures.map(({ uniform }) => {
          const texture = uniform.value;
          return { id: this._textureRecord(texture)?.id ?? 0, texture };
        }) : stdTextures,
        stdMaps, normalScaleX: normalScale ? normalScale.x : 1, normalScaleY: (normalScale ? normalScale.y : 1) * uvFlip,
        aoIntensity: m.aoMapIntensity ?? 1,
        er: emissive ? emissive.r * ei : 0, eg: emissive ? emissive.g * ei : 0, eb: emissive ? emissive.b * ei : 0,
        matrix: mesh.matrixWorld.elements, z: base.z, renderOrder: mesh.renderOrder || 0, bones: base.bones || 0,
        shadow: (mesh.castShadow && !(flags & (DrawFlags.LINES | DrawFlags.LINE_STRIP)) ? ShadowFlags.CAST : 0) |
          (mesh.receiveShadow && !(flags & DrawFlags.UNLIT) ? ShadowFlags.RECEIVE : 0) | (this._shadowPass ? ShadowFlags.ONLY : 0),
      };
      if (globalThis.__ntDebugDraws) {
        const g = mesh.geometry, c = g.attributes.color;
        globalThis.__ntDebugDraws.push({
          mesh: mesh.name || mesh.type, material: m.type, matName: m.name || '', color: color && color.isColor ? color.getHexString() : null,
          vertexColors: !!m.vertexColors, colorAttr: c ? `${c.itemSize}/${c.array.constructor.name}/${c.normalized}` : null,
          map: !!colorMap, onBeforeCompile: hasCompilePatch(m.onBeforeCompile),
          uniforms: m.uniforms ? Object.keys(m.uniforms).slice(0, 12) : null, emissive: emissive ? emissive.getHexString() : null,
          transparent: !!m.transparent, opacity: m.opacity, count, instances: draw.instanceCount, defines: m.defines ? Object.keys(m.defines) : null,
        });
      }
      if (flags & DrawFlags.TRANSPARENT) transparent.push(draw); else opaque.push(draw);
      this.info.render.triangles += (flags & (DrawFlags.LINES | DrawFlags.LINE_STRIP)) ? 0 : Math.floor(count / 3) * draw.instanceCount;
      if (flags & (DrawFlags.LINES | DrawFlags.LINE_STRIP)) this.info.render.lines += count;
    }
  }

  function writeLight(p, o, l) {
    p[o] = l.type; p[o + 1] = l.r; p[o + 2] = l.g; p[o + 3] = l.b;
    p[o + 4] = l.px; p[o + 5] = l.py; p[o + 6] = l.pz; p[o + 7] = l.distance;
    p[o + 8] = l.dx; p[o + 9] = l.dy; p[o + 10] = l.dz; p[o + 11] = l.decay;
    p[o + 12] = l.extra0; p[o + 13] = l.extra1; p[o + 14] = l.extra2; p[o + 15] = l.shadow || 0; // shadow light + 1
  }
  function writeDraw(p, o, d) {
    p[o] = d.geometryId; p[o + 1] = d.instanceId; p[o + 2] = d.instanceCount; p[o + 3] = d.flags;
    p[o + 4] = d.start; p[o + 5] = d.count; p[o + 6] = d.roughness; p[o + 7] = d.metalness;
    p[o + 8] = d.r; p[o + 9] = d.g; p[o + 10] = d.b; p[o + 11] = d.opacity;
    p[o + 12] = d.er; p[o + 13] = d.eg; p[o + 14] = d.eb; p[o + 15] = d.shininess;
    p.set(d.matrix, o + 16);
    p[o + 32] = d.textureId; p[o + 33] = d.alphaTest;
    p[o + 34] = d.ua; p[o + 35] = d.ub; p[o + 36] = d.uc; p[o + 37] = d.ud; p[o + 38] = d.ue; p[o + 39] = d.uf;
    if (!d.reflection && !d.colorStage && !d.stdMaps) {
      p.fill(0, o + 40, o + DRAW_FLOATS);
      p[o + 88] = d.shadow || 0;
      p[o + 93] = d.bones || 0;
      return;
    }
    p[o + 88] = d.shadow || 0;
    p[o + 89] = d.stdMaps || 0; p[o + 90] = d.normalScaleX ?? 1; p[o + 91] = d.normalScaleY ?? 1; p[o + 92] = d.aoIntensity ?? 1;
    p[o + 93] = d.bones || 0; p[o + 94] = 0; p[o + 95] = 0;
    const reflection = d.reflection;
    const sky = reflection?.uniform.value;
    p[o + 40] = sky ? sky.r * reflection.intensity : 0;
    p[o + 41] = sky ? sky.g * reflection.intensity : 0;
    p[o + 42] = sky ? sky.b * reflection.intensity : 0;
    p[o + 43] = reflection?.strength ?? 0;
    p[o + 44] = reflection?.base ?? 0;
    p[o + 45] = reflection?.amplitude ?? 0;
    p[o + 46] = reflection?.power ?? 0;
    p[o + 47] = (reflection?.alphaGain ?? 0) * (d.reflectionMask ? -1 : 1);
    p[o + 48] = d.colorStage?.id ?? 0;
    for (let i = 0; i < STAGE_UNIFORM_FLOATS; i++) {
      const binding = d.colorStage?.uniforms[i];
      const uniform = binding?.index !== undefined ? binding.uniform.value?.[binding.index] : binding?.uniform.value;
      const component = binding?.component;
      const value = component && uniform?.isColor ? uniform['rgb'['xyz'.indexOf(component)]]
        : component ? uniform?.[component] : uniform;
      p[o + (i < 12 ? 49 + i : 60 + i)] = Number.isFinite(value) ? value : 0;
    }
    let flip = 0, repeat = 0, mirror = 0;
    for (let i = 0; i < 9; i++) {
      const binding = d.materialTextures?.[i];
      p[o + 61 + i] = binding?.id ?? 0;
      const texture = binding?.texture;
      if (!texture) continue;
      if ((texture.flipY || texture.isRenderTargetTexture) && !binding.std) flip |= 1 << i; // standard maps use the draw's uv (flip included)
      if (texture.wrapS === THREE.RepeatWrapping || texture.wrapT === THREE.RepeatWrapping) repeat |= 1 << i;
      else if (texture.wrapS === THREE.MirroredRepeatWrapping || texture.wrapT === THREE.MirroredRepeatWrapping) mirror |= 1 << i;
    }
    p[o + 70] = flip;
    p[o + 71] = repeat | (mirror << 9);
  }
  // Weights for colour uniforms: mix(A, B, t) in the shader leans to A.
  function colorWeights(entries, glsl) {
    const names = entries.map(([k]) => k);
    const w = names.map(() => 1);
    // Preserve constant GLSL mix ratios instead of imposing a 65/35 tint.
    // Dynamic blend factors remain an approximation until native GLSL support.
    const mix = /\bmix\s*\(\s*([A-Za-z_]\w*)\s*,\s*([A-Za-z_]\w*)\s*,\s*([+\-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+\-]?\d+)?)\s*\)/g;
    let found = false;
    for (let mm; (mm = mix.exec(glsl));) {
      const i = names.indexOf(mm[1]), j = names.indexOf(mm[2]);
      if (i < 0 || j < 0) continue;
      const t = Math.max(0, Math.min(1, Number(mm[3])));
      if (!found) { w.fill(0); found = true; }
      w[i] += 1 - t; w[j] += t;
    }
    if (!found) {
      // Keep the legacy approximation for non-constant blend factors such as
      // mix(horizon, top, height) until shader execution is available.
      const dynamicMix = /\bmix\s*\(\s*([A-Za-z_]\w*)\s*,\s*([A-Za-z_]\w*)\s*,/g;
      for (let mm; (mm = dynamicMix.exec(glsl));) {
        const i = names.indexOf(mm[1]), j = names.indexOf(mm[2]);
        if (i < 0 || j < 0) continue;
        if (!found) { w.fill(0); found = true; }
        w[i] += 0.65; w[j] += 0.35;
      }
    }
    const total = w.reduce((a, b) => a + b, 0) || 1;
    return entries.map(([, u], i) => [u, w[i] / total]);
  }
  // Conservative GLSL subset: float attribute -> varying -> smoothstep alpha
  // mask. Any more complicated fragment logic keeps its existing fallback.
  function attributeAlphaRamp(vertex, fragment) {
    const re = /\bfloat\s+([A-Za-z_]\w*)\s*=\s*smoothstep\s*\(\s*([+\-\d.eE]+)\s*,\s*([+\-\d.eE]+)\s*,\s*([A-Za-z_]\w*)\s*\)\s*;/g;
    for (const match of fragment.matchAll(re)) {
      const [, name, lower, upper, varying] = match;
      if (!new RegExp(`\\bdiffuseColor\\.a\\s*\\*=\\s*${name}\\b`).test(fragment)) continue;
      const assignment = new RegExp(`\\b${varying}\\s*=\\s*([A-Za-z_]\\w*)\\s*;`).exec(vertex);
      if (!assignment) continue;
      const attribute = assignment[1];
      if (!new RegExp(`\\b(?:attribute|in)\\s+float\\s+${attribute}\\b`).test(vertex)) continue;
      const lo = Number(lower), hi = Number(upper);
      if (Number.isFinite(lo) && Number.isFinite(hi) && lo < hi) return { attribute, lo, hi };
    }
    return null;
  }
  // Translate a bounded, procedural subset of Three.js materials. The native
  // vertex shader still supplies transforms, while HLSL evaluates GLSL math
  // with interpolated inputs and the current draw's uniforms and samplers.
  function translateMaterialStage(shader, standalone = false) {
    const clean = source => source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
    let fragment = clean(shader.fragmentShader);
    let vertex = clean(shader.vertexShader);
    if (standalone) {
      // ShaderMaterial (post-processing passes ...): defines and #if blocks resolved here.
      fragment = preprocessGlsl(fragment, shader.defines);
      vertex = preprocessGlsl(vertex, shader.defines);
      if (fragment === null || vertex === null) return null;
    }
    const uniforms = [], textures = [], attributes = new Map(), inputs = [], arrays = [];
    let valid = true;
    const channels = 'xyzw';
    function components(expression, offset, size) {
      return expression + '.' + channels.slice(offset, offset + size);
    }
    function declarations(source, stage) {
      return source.replace(/\b(uniform|varying|attribute)\s+(float|vec[234]|sampler2D)\s+([A-Za-z_]\w*)\s*(?:\[\s*(\d+)\s*\])?\s*;/g, (_, storage, type, name, length) => {
        const width = type === 'float' ? 1 : Number(type.at(-1));
        if (length !== undefined) {
          // uniform float weights[N]: every element packed like a scalar/vector uniform.
          const uniform = shader.uniforms[name], n = Number(length);
          if (storage !== 'uniform' || type === 'sampler2D' || !uniform || !Array.isArray(uniform.value) ||
              uniforms.length + width * n > STAGE_UNIFORM_FLOATS) { valid = false; return ''; }
          const elements = [];
          for (let k = 0; k < n; k++) {
            const expressions = [];
            for (let i = 0; i < width; i++) {
              const index = uniforms.length;
              const register = index < 12 ? 'gColorStage[' + Math.floor(index / 4) + ']' : 'gColorStageMore[' + Math.floor((index - 12) / 4) + ']';
              expressions.push(components(register, index % 4, 1));
              uniforms.push({ uniform, component: width === 1 ? null : channels[i], index: k });
            }
            elements.push(width === 1 ? expressions[0] : type + '(' + expressions.join(', ') + ')');
          }
          arrays.push({ name, type, elements });
          return '';
        }
        if (storage === 'uniform' && !inputs.some(input => input.name === name)) {
          // Reflected sky color is already packed by the native Fresnel stage.
          if (stage === 'fragment' && !new RegExp('\\b' + name + '\\b').test([source.replace(_ , ''), body, normal, roughness, alpha].join('\n'))) return '';
          const uniform = shader.uniforms[name];
          if (!uniform) valid = false;
          else if (type === 'sampler2D') {
            if (textures.length >= 9 || !uniform.value?.isTexture) valid = false;
            else textures.push({ name, uniform });
          } else if (uniforms.length + width <= STAGE_UNIFORM_FLOATS) {
            const expressions = [];
            for (let i = 0; i < width; i++) {
              const index = uniforms.length;
              const register = index < 12 ? 'gColorStage[' + Math.floor(index / 4) + ']' : 'gColorStageMore[' + Math.floor((index - 12) / 4) + ']';
              expressions.push(components(register, index % 4, 1));
              uniforms.push({ uniform, component: width === 1 ? null : channels[i] });
            }
            inputs.push({ name, type, expression: width === 1 ? expressions[0] : type + '(' + expressions.join(', ') + ')' });
          } else valid = false;
        }
        if (storage === 'attribute' && stage === 'vertex') attributes.set(name, { name, width });
        return '';
      });
    }
    let helpers, body, normal = '', roughness = '', alpha = '';
    if (standalone) {
      if (shader.isRawShaderMaterial || shader.lights || shader.glslVersion) return null;
      const program = fragment.replace(/#include\s+<colorspace_fragment>/g, '');
      const main = program.match(/^([\s\S]*?)\bvoid\s+main\s*\(\s*\)\s*\{([\s\S]*)\}\s*$/);
      if (!main || !/\bgl_FragColor\s*=/.test(main[2])) return null;
      // Keep the direct single-map case on the stock texture path.
      if (/^\s*gl_FragColor\s*=\s*texture2D\(\s*\w+\s*,\s*vUv\s*\)\s*;\s*$/.test(main[2])) return null;
      helpers = main[1];
      body = main[2].replace(/\bgl_FragColor\b/g, 'diffuseColor');
    } else {
      helpers = fragment.match(/#include <common>([^#]*)#include/)?.[1];
      body = fragment.match(/#include <color_fragment>([^#]*)#include/)?.[1];
      if (!helpers || !body || !/\bdiffuseColor\.rgb\s*=/.test(body)) return null;
      // Three.js also permits declarations before the first chunk.
      helpers = (fragment.match(/^[^#]*/)?.[0].match(/\buniform\s+(?:float|vec[234]|sampler2D)\s+\w+\s*;/g) ?? []).join('\n') + '\n' + helpers;
      normal = fragment.match(/#include <normal_fragment_maps>([^#]*)#include/)?.[1].trim() ?? '';
      roughness = fragment.match(/#include <roughnessmap_fragment>([^#]*)#include/)?.[1].trim() ?? '';
      // Alpha fades immediately before opaque_fragment belong after reflection.
      alpha = fragment.match(/((?:float\s+\w+\s*=\s*smoothstep\([^;]+\);\s*)if\s*\([^;]+\)\s*discard\s*;\s*diffuseColor\.a\s*\*=\s*\w+\s*;)\s*#include <opaque_fragment>/)?.[1] ?? '';
      alpha = alpha.replace(/diffuseColor\.a\s*\*=/g, 'alphaMask *=');
    }

    const vertexHead = standalone ? '' : (vertex.match(/#include <common>([^#]*)#include/)?.[1] ?? '');
    declarations(vertexHead, 'vertex');
    const varyingPattern = /\bvarying\s+(float|vec[234])\s+([A-Za-z_]\w*)\s*;/g;
    const varyings = [...helpers.matchAll(varyingPattern)];
    helpers = declarations(helpers, 'fragment');
    const vertexBody = standalone ? vertex : (vertex.match(/#include <begin_vertex>([^#]*)#include/)?.[1] ?? '');
    const assignments = [];
    const uses = new Map();
    for (const [, type, name] of varyings) {
      const expression = new RegExp('\\b' + name + '\\s*=\\s*([^;]+);').exec(vertexBody)?.[1];
      if (!expression) return null;
      if (standalone) {
        if (type === 'vec2' && expression.trim() === 'uv') assignments.push(type + ' ' + name + ' = ntIn.rawUv;');
        else if (type === 'float' && /^fract\s*\(\s*\w+\[3\]\.x\s*\*\s*[\d.]+\s*\+\s*\w+\[3\]\.z\s*\*\s*[\d.]+\s*\)$/.test(expression.trim())) {
          const matrix = expression.match(/\b(\w+)\[3\]/)[1];
          if (!new RegExp('\\bmat4\\s+' + matrix + '\\s*=\\s*modelMatrix\\s*;').test(vertex)) return null;
          assignments.push(type + ' ' + name + ' = ' + expression.replace(new RegExp('\\b' + matrix + '\\[3\\]', 'g'), 'ntIn.origin') + ';');
        } else return null;
      } else {
        assignments.push(type + ' ' + name + ' = ' + expression + ';');
        for (const [attr, spec] of attributes) {
          if (new RegExp('\\b' + attr + '\\b').test(expression)) uses.set(attr, spec);
        }
      }
    }
    if (standalone) {
      const vertexMain = vertex.replace(/\bvarying\s+(?:float|vec[234])\s+\w+\s*;/g, '')
        .replace(/^\s*#ifdef\s+USE_INSTANCING\s*\n\s*(\w+)\s*=\s*modelMatrix\s*\*\s*instanceMatrix\s*;\s*\n\s*#endif\s*$/gm, '');
      const clip = /\bgl_Position\s*=\s*projectionMatrix\s*\*\s*(?:viewMatrix\s*\*\s*(?:\w+|modelMatrix\s*\*\s*vec4\s*\(\s*position\s*,\s*1(?:\.0)?\s*\))|modelViewMatrix\s*\*\s*vec4\s*\(\s*position\s*,\s*1(?:\.0)?\s*\))\s*;/;
      const world = /\bvec4\s+\w+\s*=\s*(?:modelMatrix|\w+)\s*\*\s*vec4\s*\(\s*position\s*,\s*1(?:\.0)?\s*\)\s*;/g;
      let remainder = vertexMain.replace(clip, '').replace(world, '').replace(/\bmat4\s+\w+\s*=\s*modelMatrix\s*;/g, '');
      for (const [, , name] of varyings) remainder = remainder.replace(new RegExp('\\b' + name + '\\s*=\\s*[^;]+;'), '');
      if (!clip.test(vertexMain) || !/^\s*void\s+main\s*\(\s*\)\s*\{\s*\}\s*$/.test(remainder)) return null;
    }

    let cursor = 0;
    for (const { name, width } of uses.values()) {
      const type = width === 1 ? 'float' : 'vec' + width;
      inputs.push({ name, type, expression: components('ntIn.attributes', cursor, width) });
      cursor += width;
    }
    if (!valid || cursor > 4) return null;

    // Match top-level mutable scalar/vector temporaries and move them into
    // this invocation. HLSL global variables are read-only at runtime.
    const locals = [], privates = [];
    let depth = 0;
    helpers = helpers.replace(/[{}]|(?:float|vec[234])\s+\w+\s*=\s*[^;{}]+;|(?:float|vec[234])\s+\w+(?:\s*,\s*\w+)*\s*;/g, code => {
      if (code === '{') depth++;
      else if (code === '}') depth--;
      else if (depth === 0) {
        // Declared without a value: written later by the colour code, so a
        // private (static) global; plain HLSL globals are read-only constants.
        if (!code.includes('=')) { privates.push(code); return ''; }
        locals.push(code);
        return '';
      }
      return code;
    });
    if (normal && !/^\{[\s\S]*\}$|^normal\s*=/.test(normal)) return null;
    if (roughness && !/^roughnessFactor\s*=/.test(roughness)) return null;
    const reflectionScale = /outgoingLight\s*=\s*mix\s*\(\s*outgoingLight\s*,\s*\w+\s*\*\s*\(([^;()]+)\)\s*,/.exec(fragment)?.[1];
    const functions = [...helpers.matchAll(/\b(?:float|vec[234])\s+([A-Za-z_]\w*)\s*\([^()]*\)\s*\{/g)].map(match => match[1]);
    const code = [helpers, body, normal, roughness, alpha, ...locals, ...assignments, reflectionScale || ''].join('\n');
    // Loops only with constant bounds (blur kernels): `for (int i = 1; i < 22; i++)`.
    let loopsOk = true;
    const checked = code.replace(FOR_LOOP, (_, variable, from, op, to) => {
      if (Number(to) - Number(from) + (op === '<=' ? 1 : 0) > 64) loopsOk = false;
      return '';
    });
    if (!loopsOk || code.length > 18000 || /[^\w\s.,;(){}+*/%<>!=?:&|\-\[\]]/.test(checked) ||
        /\b(?:for|while|do|switch|register|static|uniform|varying|layout|texture|samplerCube|cbuffer)\b/.test(checked)) return null;
    const calls = new Set(['vec2', 'vec3', 'vec4', 'float', 'abs', 'min', 'max', 'clamp', 'mix', 'smoothstep',
      'step', 'pow', 'sin', 'cos', 'floor', 'ceil', 'fract', 'dot', 'normalize', 'length', 'sqrt', 'exp',
      'fwidth', 'cross', 'sign', 'texture2D', 'if', 'return', 'luminance', 'int', 'log', 'log2', 'exp2', 'atan',
      'reflect', 'distance', 'tan', 'asin', 'acos', ...functions]);
    for (const [, name] of checked.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)) if (!calls.has(name)) return null;

    // GLSL carries a combined texture/sampler through helper parameters.
    // Pass its uniform slot through the HLSL helper and select the sampler
    // from that draw's wrapping and orientation flags.
    const sample = textures.length ? materialTextureSource(textures.length) : '';
    const translate = source => {
      let result = source.replace(/\bsampler2D\b/g, 'int').replace(/\btexture2D\s*\(/g, 'ntMaterialSample(')
        .replace(/\bvec2\s*\(\s*0\.0\s*\)/g, 'float2(0.0, 0.0)')
        .replace(HLSL_RESERVED, 'nt_$1')
        .replace(/\bvec([234])\b/g, 'float$1').replace(/\bmix\s*\(/g, 'lerp(').replace(/\bfract\s*\(/g, 'frac(')
        .replace(/\bposition\b/g, 'ntPosition').replace(/\bobjectNormal\b/g, 'ntNormal')
        .replace(/\(\s*viewMatrix\s*\*\s*float4\(([^;]+?),\s*0\.0\)\s*\)\.xyz/g, 'mul((float3x3)gView, float3($1))')
        .replace(/\bconst\s+in\b/g, 'in').replace(/\bfor\s*\(/g, '[unroll] for (')
        .replace(/\batan\s*\(([^(),]+),/g, 'atan2($1,');
      textures.forEach(({ name }, slot) => { result = result.replace(new RegExp('\\b' + name + '\\b', 'g'), String(slot)); });
      return splatConstructors(result);
    };
    const globals = [
      ...inputs.filter(input => new RegExp('\\b' + input.name + '\\b').test(helpers)),
      ...varyings.filter(([, , name]) => new RegExp('\\b' + name + '\\b').test(helpers)).map(([, type, name]) => ({ type, name })),
    ];
    const globalNames = new Set(globals.map(input => input.name));
    const init = (type, name, expression) => (globalNames.has(name) ? '' : type + ' ') + name + ' = ' + expression + ';';
    const varyingInit = assignments.map(line => line.replace(/^(\w+) (\w+) = (.*);$/, (_, type, name, expression) => init(type, name, expression)));
    const source = sample + translate(globals.map(({ type, name }) => 'static ' + type + ' ' + name + ';').join('\n') + '\n' +
      arrays.map(({ type, name, elements }) => 'static ' + type + ' ' + name + '[' + elements.length + '];').join('\n') + '\n' +
      privates.map(code => 'static ' + code).join('\n') + '\n' + helpers) + '\n' +
      'void nativeColorStage(VSOut ntIn, inout float4 diffuseColor, inout float3 ntWorldNormal, inout float roughnessFactor, inout float skyScale, inout float alphaMask) {\n' +
      'float3 ntPosition = ntIn.localPosition, ntNormal = ntIn.localNormal;\n' +
      'float3 vViewPosition = -mul(gView, float4(ntIn.world, 1.0)).xyz;\n' +
      inputs.map(({ type, name, expression }) => translate(init(type, name, expression))).join('\n') + '\n' +
      arrays.map(({ name, elements }) => elements.map((e, k) => translate(name + '[' + k + '] = ' + e + ';')).join('\n')).join('\n') + '\n' +
      translate(varyingInit.join('\n') + '\n' + locals.join('\n') + '\n' + body + '\n' + roughness + '\n' + alpha) + '\n' +
      (reflectionScale ? 'skyScale = ' + translate(reflectionScale) + ';\n' : '') +
      (normal ? 'float3 normal = normalize(mul((float3x3)gView, ntWorldNormal));\n' +
        translate(normal) + '\nntWorldNormal = normalize(mul(transpose((float3x3)gView), normal));\n' : '') +
      '}';
    return { source, uniforms, textures, attributes: [...uses.values()] };
  }

  const FOR_LOOP = /\bfor\s*\(\s*int\s+([A-Za-z_]\w*)\s*=\s*(-?\d+)\s*;\s*\1\s*(<=?)\s*(-?\d+)\s*;\s*(?:\1\s*\+\+|\+\+\s*\1|\1\s*\+=\s*1)\s*\)/g;
  // Minimal GLSL preprocessor for ShaderMaterial: material.defines and
  // #define values, #ifdef/#ifndef/#if/#elif/#else/#endif. <common> is
  // provided natively; other #include chunks are not translated (null).
  function preprocessGlsl(source, defines) {
    const values = new Map();
    for (const [k, v] of Object.entries(defines ?? {})) values.set(k, v === true ? '1' : v === false ? '0' : String(v));
    const evaluate = (expression) => {
      let e = expression.replace(/\bdefined\s*\(\s*(\w+)\s*\)|\bdefined\s+(\w+)/g, (_, a, b) => (values.has(a || b) ? '1' : '0'));
      e = e.replace(/\b[A-Za-z_]\w*\b/g, (name) => (values.has(name) && /^[\d.\s+-]+$/.test(values.get(name)) ? values.get(name) : '0'));
      if (!/^[\d.\s()!&|=<>+\-*/]+$/.test(e)) return null;
      try { return !!Function('return (' + e + ');')(); } catch { return null; }
    };
    const out = [], stack = [];
    let active = true;
    for (const raw of source.split('\n')) {
      const line = raw.trim();
      let m;
      if ((m = /^#\s*(ifdef|ifndef)\s+(\w+)/.exec(line))) {
        const cond = values.has(m[2]) === (m[1] === 'ifdef');
        stack.push({ parent: active, taken: cond }); active = active && cond; continue;
      }
      if ((m = /^#\s*if\s+(.+)$/.exec(line))) {
        const cond = evaluate(m[1]); if (cond === null) return null;
        stack.push({ parent: active, taken: cond }); active = active && cond; continue;
      }
      if ((m = /^#\s*elif\s+(.+)$/.exec(line))) {
        const top = stack.at(-1); if (!top) return null;
        const cond = !top.taken && evaluate(m[1]); if (cond === null) return null;
        active = top.parent && cond; top.taken = top.taken || cond; continue;
      }
      if (/^#\s*else\b/.test(line)) { const top = stack.at(-1); if (!top) return null; active = top.parent && !top.taken; top.taken = true; continue; }
      if (/^#\s*endif\b/.test(line)) { const top = stack.pop(); if (!top) return null; active = top.parent; continue; }
      if (!active) continue;
      if ((m = /^#\s*define\s+(\w+)(\()?\s*(.*)$/.exec(line))) { if (m[2]) return null; values.set(m[1], m[3].trim()); continue; }
      if (/^#\s*include\s+<(common|colorspace_fragment|tonemapping_fragment)>\s*$/.test(line)) continue;
      if (/^precision\s+\w+\s+\w+\s*;$/.test(line)) continue;
      if (line.startsWith('#')) return null;
      out.push(raw);
    }
    if (stack.length) return null;
    let code = out.join('\n');
    for (let pass = 0; pass < 3; pass++) {
      for (const [k, v] of values) if (v !== '') code = code.replace(new RegExp('\\b' + k + '\\b', 'g'), v);
    }
    return code;
  }

  // GLSL words that HLSL reserves (interpolation modifiers, types ...).
  const HLSL_RESERVED = /\b(line|point|triangle|sample|linear|centroid|precise|shared|vector|matrix|half|string|pass|compile|snorm|unorm|lineadj|triangleadj|nointerpolation|noperspective|groupshared|technique|dword|row_major|column_major|export|inline)\b/g;
  // GLSL vec3(x) fills every component from one value; HLSL's float3(...)
  // needs all components, but a cast does the same: ((float3)(x)).
  function splatConstructors(code) {
    let out = '', i = 0;
    const head = /\bfloat([234])\s*\(/g;
    for (let match; (match = head.exec(code));) {
      let depth = 1, j = head.lastIndex, comma = false;
      for (; j < code.length && depth; j++) {
        const c = code[j];
        if (c === '(') depth++;
        else if (c === ')') depth--;
        else if (c === ',' && depth === 1) comma = true;
      }
      if (depth || comma) continue;
      const inner = code.slice(head.lastIndex, j - 1);
      if (!inner.trim()) continue;
      out += code.slice(i, match.index) + '((float' + match[1] + ')(' + splatConstructors(inner) + '))';
      i = j;
      head.lastIndex = j;
    }
    return out + code.slice(i);
  }

  function materialTextureSource(count) {
    const samples = [];
    for (let slot = 0; slot < count; slot++) {
      const texture = 'gMaterialMap' + slot;
      samples.push('if (slot == ' + slot + ') { ' +
        'if (((uint)gMaterialOptions.y & bit) != 0) return ' + texture + '.SampleGrad(gRepeat, uv, dx, dy); ' +
        'if (((uint)gMaterialOptions.z & bit) != 0) return ' + texture + '.SampleGrad(gMirror, uv, dx, dy); ' +
        'return ' + texture + '.SampleGrad(gClamp, uv, dx, dy); }');
    }
    return 'float4 ntMaterialSample(int slot, float2 uv) {\n' +
      'uint bit = 1u << slot;\nif (((uint)gMaterialOptions.x & bit) != 0) uv.y = 1.0 - uv.y;\n' +
      'float2 dx = ddx(uv), dy = ddy(uv);\n' + samples.join('\n') +
      '\nreturn float4(1.0, 1.0, 1.0, 1.0);\n}\n';
  }


  // Only replace albedo when the fragment actually assigns a palette to it.
  // A uniform used elsewhere (e.g. in sky reflection) must not tint the base.
  function diffusePalette(fragment, uniforms) {
    const assignments = [...fragment.matchAll(/\bdiffuseColor\.rgb\s*=\s*([^;]+);/g)];
    for (const [, expression] of assignments) {
      const name = /^([A-Za-z_]\w*)(?:\s*$|\s*\*)/.exec(expression)?.[1];
      if (uniforms.has(name)) return [[uniforms.get(name), 1]];
      const local = name && new RegExp(`\\bvec3\\s+${name}\\s*=\\s*(mix\\([^;]+)\\s*;`).exec(fragment)?.[1];
      const mix = /^mix\s*\(\s*([A-Za-z_]\w*)\s*,\s*([A-Za-z_]\w*)\s*,\s*(.+)\)\s*$/.exec(local || expression);
      if (!mix || !uniforms.has(mix[1]) || !uniforms.has(mix[2])) continue;
      const constant = /^[+\-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+\-]?\d+)?$/.test(mix[3].trim());
      const t = constant ? Number(mix[3]) : 0.35;
      if (Number.isFinite(t)) return [[uniforms.get(mix[1]), 1 - t], [uniforms.get(mix[2]), t]];
    }
    return null;
  }

  // A subset of onBeforeCompile can mix reflected sky into outgoingLight
  // using a Schlick-style view angle. Keep the uniform live across day/night.
  function outgoingReflection(fragment, uniforms) {
    const number = '([0-9]*\\.?[0-9]+)';
    const mix = new RegExp(`\\boutgoingLight\\s*=\\s*mix\\(\\s*outgoingLight\\s*,\\s*([A-Za-z_]\\w*)\\s*(?:\\*\\(\\s*${number}\\s*\\+\\s*${number}\\s*\\*\\s*[A-Za-z_]\\w*\\s*\\))?\\s*,\\s*clamp\\(\\s*([A-Za-z_]\\w*)\\s*\\*\\s*${number}\\s*,\\s*0(?:\\.0*)?\\s*,\\s*${number}\\s*\\)\\s*\\)\\s*;`).exec(fragment);
    if (!mix || !uniforms.has(mix[1]) || Number(mix[5]) !== Number(mix[6])) return null;
    const fresnel = new RegExp(`\\bfloat\\s+${mix[4]}\\s*=\\s*${number}\\s*\\+\\s*${number}\\s*\\*\\s*pow\\(\\s*1(?:\\.0*)?\\s*-\\s*([A-Za-z_]\\w*)\\s*,\\s*${number}\\s*\\)\\s*;`).exec(fragment);
    if (!fresnel) return null;
    const view = new RegExp(`\\bfloat\\s+${fresnel[3]}\\s*=\\s*clamp\\(\\s*dot\\(\\s*(\\w+)\\s*,\\s*normal\\s*\\)\\s*,\\s*0(?:\\.0*)?\\s*,\\s*1(?:\\.0*)?\\s*\\)\\s*;`).exec(fragment)?.[1];
    if (!view || !new RegExp(`\\bvec3\\s+${view}\\s*=\\s*normalize\\(\\s*vViewPosition\\s*\\)\\s*;`).test(fragment)) return null;
    if (Number(mix[5]) > 1 || Number(fresnel[4]) <= 0) return null;
    const alpha = new RegExp(`\\bdiffuseColor\\.a\\s*=\\s*clamp\\(\\s*diffuseColor\\.a\\s*\\+\\s*${mix[4]}\\s*\\*\\s*${number}\\s*,\\s*0(?:\\.0*)?\\s*,\\s*1(?:\\.0*)?\\s*\\)\\s*;`).exec(fragment);
    return { uniform: uniforms.get(mix[1]), intensity: mix[2] === undefined ? 1 : Number(mix[2]) + 0.5 * Number(mix[3]),
      strength: Number(mix[5]), base: Number(fresnel[1]), amplitude: Number(fresnel[2]), power: Number(fresnel[4]), alphaGain: Number(alpha?.[1] ?? 0) };
  }

  function smoothRamp(lo, hi, value) {
    const t = Math.max(0, Math.min(1, (value - lo) / (hi - lo)));
    return t * t * (3 - 2 * t);
  }

  // Recognize a two-uniform palette mixed by an inverted scalar ramp.
  // Bake the palette into the existing masked vertex buffer. Other fragment
  // math (noise, reflections and animated wave normals) remains approximate.
  function attributeColorRamp(vertex, fragment, attribute, uniforms) {
    const ramp = new RegExp(`\\b([A-Za-z_]\\w*)\\s*=\\s*1(?:\\.0*)?\\s*-\\s*smoothstep\\(\\s*([+\\-\\d.eE]+)\\s*,\\s*([+\\-\\d.eE]+)\\s*,\\s*${attribute}\\s*\\)\\s*;`).exec(vertex);
    if (!ramp) return null;
    const [, varying, lower, upper] = ramp;
    const mix = new RegExp(`\\bvec3\\s+([A-Za-z_]\\w*)\\s*=\\s*mix\\(\\s*([A-Za-z_]\\w*)\\s*,\\s*([A-Za-z_]\\w*)\\s*,\\s*pow\\(\\s*${varying}\\s*,\\s*([+\\-\\d.eE]+)\\s*\\)\\s*\\*\\s*([+\\-\\d.eE]+)\\s*\\)\\s*;`).exec(fragment);
    if (!mix || !new RegExp(`\\bdiffuseColor\\.rgb\\s*=\\s*${mix[1]}\\b`).test(fragment)) return null;
    const lo = Number(lower), hi = Number(upper), power = Number(mix[4]), scale = Number(mix[5]);
    const from = uniforms.get(mix[2]), to = uniforms.get(mix[3]);
    if (!from || !to || ![lo, hi, power, scale].every(Number.isFinite) || lo >= hi || power <= 0 || scale < 0 || scale > 1) return null;
    return { lo, hi, power, scale, from, to };
  }

  function mixColors(target, weighted) {
    target.setRGB(0, 0, 0, THREE.LinearSRGBColorSpace);
    for (const [u, k] of weighted) { const c = u.value; target.r += c.r * k; target.g += c.g * k; target.b += c.b * k; }
    return target.clone();
  }

  return { NativeRenderer };
}

// Any BufferAttribute (interleaved, normalized, integer, itemSize 2..4) ->
// tightly packed Float32Array with 3 floats per vertex.
export function toFloat3(attribute) {
  const count = attribute.count;
  if (!attribute.isInterleavedBufferAttribute && attribute.itemSize === 3 && attribute.array instanceof Float32Array && !attribute.normalized) {
    return attribute.array.length === count * 3 ? attribute.array : attribute.array.subarray(0, count * 3);
  }
  const out = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    out[i * 3] = attribute.getX(i);
    out[i * 3 + 1] = attribute.itemSize > 1 ? attribute.getY(i) : 0;
    out[i * 3 + 2] = attribute.itemSize > 2 ? attribute.getZ(i) : 0;
  }
  return out;
}

export function toFloat4(attribute) {
  const count = attribute.count;
  if (!attribute.isInterleavedBufferAttribute && attribute.itemSize === 4 && attribute.array instanceof Float32Array && !attribute.normalized) {
    return attribute.array.length === count * 4 ? attribute.array : attribute.array.subarray(0, count * 4);
  }
  const out = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) { out[i * 4] = attribute.getX(i); out[i * 4 + 1] = attribute.getY(i); out[i * 4 + 2] = attribute.getZ(i); out[i * 4 + 3] = attribute.getW(i); }
  return out;
}
export function toFloat2(attribute) {
  const count = attribute.count;
  if (!attribute.isInterleavedBufferAttribute && attribute.itemSize === 2 && attribute.array instanceof Float32Array && !attribute.normalized) {
    return attribute.array.length === count * 2 ? attribute.array : attribute.array.subarray(0, count * 2);
  }
  const out = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) { out[i * 2] = attribute.getX(i); out[i * 2 + 1] = attribute.itemSize > 1 ? attribute.getY(i) : 0; }
  return out;
}
function rgba8(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof Uint8ClampedArray) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return Uint8Array.from(data);
}
// DataTexture pixels -> tightly packed RGBA8 (null = format not handled).
function dataTexturePixels(THREE, image, texture) {
  const n = image.width * image.height, src = image.data;
  const channels = texture.format === THREE.RGBAFormat ? 4 : texture.format === THREE.RGFormat ? 2 : texture.format === THREE.RedFormat ? 1 : 0;
  if (!channels || src.length < n * channels) return null;
  const isFloat = texture.type === THREE.FloatType || src instanceof Float32Array;
  const isHalf = texture.type === THREE.HalfFloatType;
  if (!isFloat && !isHalf && texture.type !== THREE.UnsignedByteType) return null;
  if (channels === 4 && !isFloat && !isHalf) return rgba8(src);
  const out = new Uint8Array(n * 4);
  const get = (i) => (isHalf ? THREE.DataUtils.fromHalfFloat(src[i]) * 255 : isFloat ? src[i] * 255 : src[i]);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 4; c++) {
      let v;
      if (c < channels) v = get(i * channels + c);
      else if (c === 3) v = 255;
      else v = channels === 1 ? get(i) : 0;
      out[i * 4 + c] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  }
  return out;
}

function computeNormals(THREE, position, index) {
  const temp = new THREE.BufferGeometry();
  temp.setAttribute('position', position);
  if (index) temp.setIndex(index);
  temp.computeVertexNormals();
  return toFloat3(temp.getAttribute('normal'));
}
