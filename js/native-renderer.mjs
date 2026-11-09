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
//     a 56-float record per visible draw.
// This module has no imports so it can be unit tested with any THREE + fake nt.

export const PASS_HEADER_FLOATS = 64;
export const LIGHT_FLOATS = 16;
export const DRAW_FLOATS = 56;
export const MAX_LIGHTS = 16;

export const LightType = { DIRECTIONAL: 3, POINT: 4, SPOT: 5, HEMISPHERE: 2 };
export const DrawFlags = {
  TRANSPARENT: 1, DOUBLE_SIDED: 2, BACK_SIDE: 4, VERTEX_COLORS: 8, UNLIT: 16,
  NO_DEPTH_WRITE: 32, NO_DEPTH_TEST: 64, LINES: 128, LINE_STRIP: 256,
  NORMAL_COLOR: 512, INSTANCE_COLORS: 1024, FLAT: 2048,
  MAP: 4096, MAP_REPEAT: 8192, MAP_MIRROR: 16384, FAR_DEPTH: 32768, NO_TONE_MAP: 65536, FOG: 131072, FRESNEL: 262144,
};
// nt.uploadTexture(id, bytes, width, height, flags): width 0 = encoded file bytes.
export const TextureFlags = { SRGB: 1, MIPMAPS: 2 };
// Pass header [48]: tone mapping curve (same numbers as THREE.*ToneMapping).
export const ToneMapping = { NONE: 0, LINEAR: 1, REINHARD: 2, CINEON: 3, ACES: 4, AGX: 6, NEUTRAL: 7 };
export const PassFlags = { CLEAR_COLOR: 1, CLEAR_DEPTH: 2 };

// `shaders`: { ShaderLib, UniformsUtils } from three.module.js (not in three.core.js).
export function createNativeRendererClasses(THREE, nt, host = globalThis.__ntHost, shaders = {}) {
  const warnOnce = (key, text) => (host && host.warnOnce ? host.warnOnce(key, text) : undefined);
  const unsupported = (feature, detail) => (host && host.unsupported ? host.unsupported(feature, detail) : undefined);

  const _projScreen = new THREE.Matrix4();
  const _frustum = new THREE.Frustum();
  const _vec = new THREE.Vector3();
  const _vec2 = new THREE.Vector3();
  const _color = new THREE.Color();
  const _srgb = { r: 0, g: 0, b: 0 };
  const _uvIdentity = new Float32Array(6);
  const _spriteScale = new THREE.Vector3();
  const _spriteQuat = new THREE.Quaternion();
  const _spriteTmp = new THREE.Matrix4();

  let nextGeometryId = 1;
  let nextInstanceId = 1;
  let nextTextureId = 1;
  const colorPatches = new Map();
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
      this._instances = new WeakMap();
      this._textures = new WeakMap();   // THREE.Source -> { id, version, ok }
      this._patches = new WeakMap();    // material -> what its shader patch does to colours
      this._maskedGeometries = new WeakMap(); // geometry -> cached RGBA attribute-mask variants
      this._packet = new Float32Array(PASS_HEADER_FLOATS + MAX_LIGHTS * LIGHT_FLOATS + 256 * DRAW_FLOATS);
      this._opaque = [];
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
      if (target) unsupported('Render targets (render-to-texture, post-processing)', 'those passes are skipped');
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
    _geometryRecord(geometry) {
      let record = this._geometries.get(geometry);
      const position = geometry.attributes.position;
      if (!position) return null;
      const normal = geometry.attributes.normal;
      const color = geometry.attributes.color;
      const uv = geometry.attributes.uv;
      const index = geometry.index;
      const key = `${position.version}:${normal ? normal.version : -1}:${color ? color.version : -1}:${uv ? uv.version : -1}:${index ? index.version : -1}:${position.count}:${index ? index.count : 0}`;
      if (record && record.key === key && record.position === position && record.normal === normal && record.index === index && record.color === color && record.uv === uv) return record;
      if (!record) {
        record = { id: nextGeometryId++, key: '', position: null, normal: null, color: null, uv: null, index: null, hasColors: false, hasUvs: false, vertexCount: 0, indexCount: 0 };
        this._geometries.set(geometry, record);
        this.info.memory.geometries++;
        const onDispose = () => {
          geometry.removeEventListener('dispose', onDispose);
          this._geometries.delete(geometry);
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
      nt.uploadGeometry(record.id, positions, normals, colors, indices, uvs);
      Object.assign(record, { key, position, normal, color, uv, index, hasColors: !!colors, hasUvs: !!uvs, vertexCount: position.count, indexCount: index ? index.count : 0 });
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
      const key = `${base.key}:${mask.version}:${ramp.lo}:${ramp.hi}:${preserveRgb}:${original ? original.version : -1}:${colorKey}`;
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
        record.matrixVersion = im.version;
        record.colorVersion = ic ? ic.version : -1;
        record.colorRef = ic;
        record.count = capacity;
      }
      return record;
    }

    // One native texture per image (THREE.Source), re-sent when needsUpdate.
    _textureRecord(texture) {
      if (!texture || !texture.isTexture || texture.isCubeTexture || texture.isCompressedTexture || texture.isData3DTexture || texture.isDataArrayTexture || texture.isRenderTargetTexture || texture.isVideoTexture) return null;
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
        if (nt.registerColorPatch && !m.transparent) {
          const stage = translateColorStage(shader);
          if (stage) {
            let id = colorPatches.get(stage.source);
            if (id === undefined && colorPatches.size < 16) {
              id = colorPatches.size + 1;
              if (!nt.registerColorPatch(id, stage.source)) id = 0;
              colorPatches.set(stage.source, id);
            }
            if (id) info.colorStage = { id, uniforms: stage.uniforms };
          }
        }
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
      if (this._renderTarget) return; // render-to-texture is not supported yet: skip, do not draw to screen

      if (scene.matrixWorldAutoUpdate !== false) scene.updateMatrixWorld();
      if (camera.parent === null && camera.matrixWorldAutoUpdate !== false) camera.updateMatrixWorld();
      if (this.info.autoReset) this.info.reset();
      this.info.render.frame++;

      if (scene.onBeforeRender) scene.onBeforeRender(this, scene, camera, this._renderTarget);
      _projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      _frustum.setFromProjectionMatrix(_projScreen, camera.coordinateSystem);

      const opaque = this._opaque, transparent = this._transparent, lights = this._lights;
      opaque.length = 0; transparent.length = 0; lights.length = 0;
      const ambient = [0, 0, 0];
      this._spriteCount = 0;
      this._collect(scene, camera, opaque, transparent, lights, ambient);

      if (this.sortObjects) {
        opaque.sort((a, b) => a.renderOrder - b.renderOrder || a.z - b.z);
        transparent.sort((a, b) => a.renderOrder - b.renderOrder || b.z - a.z);
      }

      // ---- pass header
      const drawCount = opaque.length + transparent.length;
      const lightCount = Math.min(lights.length, MAX_LIGHTS);
      if (lights.length > MAX_LIGHTS) warnOnce('too-many-lights', `Only the first ${MAX_LIGHTS} lights are used (scene has ${lights.length})`);
      const floats = PASS_HEADER_FLOATS + lightCount * LIGHT_FLOATS + drawCount * DRAW_FLOATS;
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
      p[45] = this._width; p[46] = this._height;
      p[47] = this.toneMappingExposure;
      const tm = this.toneMapping;
      p[48] = tm === THREE.LinearToneMapping ? ToneMapping.LINEAR : tm === THREE.ReinhardToneMapping ? ToneMapping.REINHARD
        : tm === THREE.CineonToneMapping ? ToneMapping.CINEON : tm === THREE.ACESFilmicToneMapping ? ToneMapping.ACES
          : tm === THREE.AgXToneMapping ? ToneMapping.AGX : tm === THREE.NeutralToneMapping ? ToneMapping.NEUTRAL : ToneMapping.NONE;
      if (tm === THREE.CustomToneMapping) unsupported('CustomToneMapping', 'no tone mapping is applied');
      const fog = scene.fog;
      if (fog?.isFog || fog?.isFogExp2) {
        fog.color.getRGB(_srgb, THREE.SRGBColorSpace);
        p[49] = _srgb.r; p[50] = _srgb.g; p[51] = _srgb.b;
        p[52] = fog.isFogExp2 ? 2 : 1;
        p[53] = fog.isFogExp2 ? fog.density : fog.near;
        p[54] = fog.far ?? 0;
      }

      let o = PASS_HEADER_FLOATS;
      for (let i = 0; i < lightCount; i++, o += LIGHT_FLOATS) writeLight(p, o, lights[i]);
      for (const d of opaque) { writeDraw(p, o, d); o += DRAW_FLOATS; }
      for (const d of transparent) { writeDraw(p, o, d); o += DRAW_FLOATS; }

      this.info.render.calls += drawCount;
      nt.submitPass(p, floats);
      if (scene.onAfterRender) scene.onAfterRender(this, scene, camera, this._renderTarget);
    }

    _collect(object, camera, opaque, transparent, lights, ambient) {
      if (object.visible === false) return;
      const layerVisible = object.layers.test(camera.layers);
      if (layerVisible) {
        if (object.isLight) this._addLight(object, lights, ambient);
        else if (object.isMesh || object.isLine) this._addMesh(object, camera, opaque, transparent);
        else if (object.isPoints) unsupported('THREE.Points', 'point clouds are not drawn yet');
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
      if (light.castShadow) unsupported('Shadow maps in webapps', 'lights work, shadows are not rendered yet');
      const rec = { type: 0, r: c.r * k, g: c.g * k, b: c.b * k, px: 0, py: 0, pz: 0, distance: 0, dx: 0, dy: -1, dz: 0, decay: 2, a: 0, b: 0, c: 0 };
      _vec.setFromMatrixPosition(light.matrixWorld);
      rec.px = _vec.x; rec.py = _vec.y; rec.pz = _vec.z;
      if (light.isHemisphereLight) {
        rec.type = LightType.HEMISPHERE;
        _vec2.copy(_vec).normalize();
        rec.dx = _vec2.x; rec.dy = _vec2.y; rec.dz = _vec2.z;
        const g = light.groundColor; rec.a = g.r * k; rec.b = g.g * k; rec.c = g.b * k;
      } else if (light.isDirectionalLight || light.isSpotLight) {
        _vec2.setFromMatrixPosition(light.target.matrixWorld).sub(_vec);
        if (_vec2.lengthSq() < 1e-12) _vec2.set(0, -1, 0);
        _vec2.normalize();
        rec.dx = _vec2.x; rec.dy = _vec2.y; rec.dz = _vec2.z;
        if (light.isDirectionalLight) rec.type = LightType.DIRECTIONAL;
        else {
          rec.type = LightType.SPOT; rec.distance = light.distance; rec.decay = light.decay;
          rec.a = Math.cos(light.angle); rec.b = Math.cos(light.angle * (1 - light.penumbra));
          if (light.map) unsupported('SpotLight.map');
        }
      } else if (light.isPointLight) {
        rec.type = LightType.POINT; rec.distance = light.distance; rec.decay = light.decay;
      } else return;
      lights.push(rec);
    }

    // THREE.Sprite: a camera-facing textured quad (SpriteMaterial is unlit).
    _addSprite(sprite, camera, opaque, transparent) {
      const m = sprite.material;
      if (!m || !m.visible) return;
      if (sprite.frustumCulled && !_frustum.intersectsSprite(sprite)) return;
      if (!this._spriteGeometry) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
        g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
        g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
        g.setIndex([0, 1, 2, 0, 2, 3]);
        this._spriteGeometry = g;
      }
      const record = this._geometryRecord(this._spriteGeometry);
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
    _spriteMatrix(i) {
      if (!this._spriteMatrices) this._spriteMatrices = [];
      return this._spriteMatrices[i] || (this._spriteMatrices[i] = new THREE.Matrix4());
    }

    _addMesh(mesh, camera, opaque, transparent) {
      const geometry = mesh.geometry;
      if (!geometry || !geometry.isBufferGeometry || !geometry.attributes.position) return;
      if (mesh.isInstancedMesh && mesh.count === 0) return;
      if (mesh.frustumCulled && !_frustum.intersectsObject(mesh)) return;
      if (mesh.isSkinnedMesh) unsupported('Skinned meshes (SkinnedMesh animation)', 'drawn in bind pose');
      if (geometry.morphAttributes && geometry.morphAttributes.position) unsupported('Morph targets', 'base shape is drawn');
      if (mesh.isBatchedMesh) { unsupported('BatchedMesh'); return; }
      const record = this._geometryRecord(geometry);
      if (!record) return;
      if (mesh.onBeforeRender !== THREE.Object3D.prototype.onBeforeRender) mesh.onBeforeRender(this, null, camera, geometry, mesh.material, null);
      const instances = mesh.isInstancedMesh ? this._instanceRecord(mesh) : null;
      _vec.setFromMatrixPosition(mesh.matrixWorld).applyMatrix4(_projScreen);
      const z = _vec.z;
      const total = record.indexCount || record.vertexCount;
      const range = geometry.drawRange;
      const base = { mesh, record, instances, z };
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
      let roughness = 1, metalness = 0, shininess = -1;
      let color = m.color || null, opacity = m.opacity ?? 1;
      let shaderMap = null, reflection = null, reflectionMask = false, colorStage = null;
      if (m.isMeshBasicMaterial || m.isLineBasicMaterial || m.isLineDashedMaterial) flags |= DrawFlags.UNLIT;
      else if (m.isSpriteMaterial) flags |= DrawFlags.UNLIT | DrawFlags.DOUBLE_SIDED;
      else if (m.isMeshNormalMaterial) flags |= DrawFlags.NORMAL_COLOR;
      else if (m.isMeshStandardMaterial) { roughness = m.roughness; metalness = m.metalness; }
      else if (m.isMeshPhongMaterial) { shininess = m.shininess; roughness = Math.sqrt(2 / (m.shininess + 2)); }
      else if (m.isMeshLambertMaterial || m.isMeshToonMaterial) { roughness = 1; }
      else if (m.isShadowMaterial) return;
      else if (m.isShaderMaterial || m.isRawShaderMaterial) {
        // Single directly sampled sampler2D with unmodified vUv can use the
        // native colour-map path. Complex UVs and multi-texture GLSL still need
        // full shader support; do not silently select an arbitrary uniform.
        const fragment = m.fragmentShader || '';
        const samplers = [...fragment.matchAll(/\b(?:texture2D|texture)\s*\(\s*([A-Za-z_]\w*)\s*,\s*vUv\s*\)/g)];
        if (samplers.length === 1 && m.uniforms && m.uniforms[samplers[0][1]]?.value?.isTexture &&
            /\bvarying\s+vec2\s+vUv\b/.test(fragment) &&
            /\bvUv\s*=\s*uv\s*;/.test(m.vertexShader || '')) {
          shaderMap = m.uniforms[samplers[0][1]].value;
          if (!m.lights) flags |= DrawFlags.UNLIT;
        }
        // Custom GLSL cannot run here: use its colour uniforms, unlit unless it uses lights.
        const shaderColors = m.uniforms ? Object.entries(m.uniforms).filter(([, u]) => u && u.value && u.value.isColor) : [];
        if (shaderColors.length) {
          color = mixColors(_color, colorWeights(shaderColors, m.fragmentShader || ''));
          if (!m.lights) flags |= DrawFlags.UNLIT;
          unsupported('ShaderMaterial / custom GLSL', 'drawn in the colour of its colour uniforms');
        } else unsupported('ShaderMaterial / custom GLSL', `drawn as a plain lit surface (${m.type})`);
        if (/gl_Position\.z\s*=\s*gl_Position\.w/.test(m.vertexShader || '')) flags |= DrawFlags.FAR_DEPTH;
        if (!/tonemapping_fragment/.test(m.fragmentShader || '')) flags |= DrawFlags.NO_TONE_MAP;
      }
      else if (m.isMeshMatcapMaterial) unsupported('MeshMatcapMaterial', 'drawn as lit colour');
      else if (m.isMeshDepthMaterial || m.isMeshDistanceMaterial) return;
      if (m.toneMapped === false) flags |= DrawFlags.NO_TONE_MAP;
      if (m.fog !== false && (!(m.isShaderMaterial || m.isRawShaderMaterial) ||
          (m.fog && /#include\s+<fog_fragment>/.test(m.fragmentShader)))) flags |= DrawFlags.FOG;
      if (m.normalMap || m.roughnessMap || m.metalnessMap || m.emissiveMap || m.aoMap || m.alphaMap || m.envMap || m.lightMap || m.bumpMap) {
        unsupported('Textures other than map (normalMap, envMap …)', 'only the colour map is drawn');
      }
      if (m.wireframe) unsupported('Wireframe materials', 'drawn solid');
      if (m.onBeforeCompile && m.onBeforeCompile.toString() !== THREE.Material.prototype.onBeforeCompile.toString()) {
        const patch = this._patchInfo(m);
        if (patch.hide) { unsupported('material.onBeforeCompile alpha masks', 'surfaces cut out by their own texture are not drawn'); return; }
        colorStage = patch.colorStage;
        if (!colorStage && patch.colors) {
          color = mixColors(_color, patch.colors);
          flags &= ~(DrawFlags.VERTEX_COLORS | DrawFlags.INSTANCE_COLORS);
          unsupported('material.onBeforeCompile shader patches', 'patched surfaces use the colours the patch mixes');
        } else if (!colorStage) unsupported('material.onBeforeCompile shader patches');
        if (patch.reflection) {
          flags |= DrawFlags.FRESNEL;
          reflection = patch.reflection;
        }
        if (patch.alpha !== null && m.transparent) opacity = patch.alpha * (m.opacity ?? 1);
        if (patch.alphaRamp && mesh.geometry) {
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
      if (m.blending === THREE.AdditiveBlending) unsupported('AdditiveBlending', 'drawn with normal alpha blending');
      // colour map
      let textureId = 0;
      const uvt = _uvIdentity;
      uvt[0] = 1; uvt[1] = 0; uvt[2] = 0; uvt[3] = 1; uvt[4] = 0; uvt[5] = 0;
      const colorMap = m.map || shaderMap;
      if (colorMap && base.record.hasUvs) {
        const tex = this._textureRecord(colorMap);
        if (tex) {
          const map = colorMap;
          textureId = tex.id;
          flags |= DrawFlags.MAP;
          if (map.wrapS === THREE.RepeatWrapping || map.wrapT === THREE.RepeatWrapping) flags |= DrawFlags.MAP_REPEAT;
          else if (map.wrapS === THREE.MirroredRepeatWrapping || map.wrapT === THREE.MirroredRepeatWrapping) flags |= DrawFlags.MAP_MIRROR;
          if (map.matrixAutoUpdate) map.updateMatrix();
          const e = map.matrix.elements;
          // u' = a u + c v + e ; v' = b u + d v + f  (D3D rows run top-down: flipY mirrors v)
          let a = e[0], b = e[1], c = e[3], d = e[4], tx = e[6], ty = e[7];
          if (map.flipY) { b = -b; d = -d; ty = 1 - ty; }
          uvt[0] = a; uvt[1] = b; uvt[2] = c; uvt[3] = d; uvt[4] = tx; uvt[5] = ty;
        }
      }
      const emissive = m.emissive || null;
      const ei = m.emissiveIntensity ?? 1;
      const draw = {
        geometryId: base.record.id, instanceId: base.instances ? base.instances.id : 0,
        instanceCount: base.instances ? mesh.count : 1, flags, start, count,
        roughness, metalness, shininess, textureId, alphaTest: m.alphaTest || 0,
        ua: uvt[0], ub: uvt[1], uc: uvt[2], ud: uvt[3], ue: uvt[4], uf: uvt[5],
        r: color && color.isColor ? color.r : 1, g: color && color.isColor ? color.g : 1, b: color && color.isColor ? color.b : 1,
        opacity, reflection, reflectionMask, colorStage,
        er: emissive ? emissive.r * ei : 0, eg: emissive ? emissive.g * ei : 0, eb: emissive ? emissive.b * ei : 0,
        matrix: mesh.matrixWorld.elements, z: base.z, renderOrder: mesh.renderOrder || 0,
      };
      if (globalThis.__ntDebugDraws) {
        const g = mesh.geometry, c = g.attributes.color;
        globalThis.__ntDebugDraws.push({
          mesh: mesh.name || mesh.type, material: m.type, matName: m.name || '', color: color && color.isColor ? color.getHexString() : null,
          vertexColors: !!m.vertexColors, colorAttr: c ? `${c.itemSize}/${c.array.constructor.name}/${c.normalized}` : null,
          map: !!colorMap, onBeforeCompile: m.onBeforeCompile && m.onBeforeCompile.toString() !== THREE.Material.prototype.onBeforeCompile.toString(),
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
    p[o + 12] = l.a; p[o + 13] = l.b; p[o + 14] = l.c; p[o + 15] = 0;
  }
  function writeDraw(p, o, d) {
    p[o] = d.geometryId; p[o + 1] = d.instanceId; p[o + 2] = d.instanceCount; p[o + 3] = d.flags;
    p[o + 4] = d.start; p[o + 5] = d.count; p[o + 6] = d.roughness; p[o + 7] = d.metalness;
    p[o + 8] = d.r; p[o + 9] = d.g; p[o + 10] = d.b; p[o + 11] = d.opacity;
    p[o + 12] = d.er; p[o + 13] = d.eg; p[o + 14] = d.eb; p[o + 15] = d.shininess;
    p.set(d.matrix, o + 16);
    p[o + 32] = d.textureId; p[o + 33] = d.alphaTest;
    p[o + 34] = d.ua; p[o + 35] = d.ub; p[o + 36] = d.uc; p[o + 37] = d.ud; p[o + 38] = d.ue; p[o + 39] = d.uf;
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
    for (let i = 0; i < 4; i++) {
      const value = d.colorStage?.uniforms[i]?.value;
      p[o + 49 + i] = Number.isFinite(value) ? value : 0;
    }
    p[o + 53] = p[o + 54] = p[o + 55] = 0;
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
  // Translate a pure colour stage with local position/normal, scalar uniforms
  // and small math helpers. Everything outside this stage stays in native HLSL.
  function translateColorStage(shader) {
    const clean = (source) => source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
    const fragment = clean(shader.fragmentShader);
    const vertex = clean(shader.vertexShader);
    let helpers = fragment.match(/#include <common>([^#]*)#include/)?.[1].trim();
    const body = fragment.match(/#include <color_fragment>([^#]*)#include/)?.[1].trim();
    if (helpers === undefined || !body || !/\bdiffuseColor\.rgb\s*=(?!=)/.test(body) || body.length + helpers.length > 12000) return null;
    const declarations = [], uniforms = [];
    let supported = true;
    helpers = helpers.replace(/\bvarying\s+vec3\s+(\w+)\s*;/g, (_, name) => {
      const init = new RegExp(`\\b${name}\\s*=\\s*(position|normalize\\(\\s*objectNormal\\s*\\))\\s*;`).exec(vertex);
      if (init) declarations.push(`float3 ${name} = ${init[1] === 'position' ? 'ntPosition' : 'ntNormal'};`);
      else supported = false;
      return '';
    }).replace(/\buniform\s+float\s+(\w+)\s*;/g, (_, name) => {
      if (uniforms.length >= 4 || !Number.isFinite(shader.uniforms[name]?.value)) supported = false;
      else {
        declarations.push(`float ${name} = gColorStage.${"xyzw"[uniforms.length]};`);
        uniforms.push(shader.uniforms[name]);
      }
      return '';
    }).trim();
    if (!supported || !declarations.length) return null;
    const type = '(?:float|vec[234])';
    const functions = new RegExp(`\\b${type}\\s+([A-Za-z_]\\w*)\\s*\\([^()]*\\)\\s*\\{[^{}]*\\}`, 'g');
    const names = [...helpers.matchAll(functions)].map((m) => m[1]);
    if (helpers.replace(functions, '').trim()) return null;
    const text = helpers + '\n' + body;
    if (/[^\w\s.,;(){}+*/%<>!=?:&|\-]/.test(text) || /[{}]/.test(body) ||
        /\b(?:for|while|do|if|switch|discard|register|static|uniform|varying|layout)\b/.test(text) ||
        /\breturn\b/.test(body) || /\bdiffuseColor\s*\.(?!rgb\b)[A-Za-z_]/.test(body)) return null;
    const calls = new Set(['vec2', 'vec3', 'vec4', 'float', 'abs', 'min', 'max', 'clamp', 'mix', 'smoothstep',
      'step', 'pow', 'sin', 'cos', 'floor', 'ceil', 'fract', 'dot', 'normalize', 'length', 'sqrt', 'exp', ...names]);
    for (const [, name] of text.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)) if (!calls.has(name) && name !== 'return') return null;
    const hlsl = (source) => source.replace(/\bvec([234])\b/g, 'float$1').replace(/\bmix\(/g, 'lerp(').replace(/\bfract\(/g, 'frac(');
    return { source: `${hlsl(helpers)}\nfloat3 nativeColorStage(float3 ntPosition, float3 ntNormal, float4 diffuseColor) {\n${declarations.join('\n')}\n${hlsl(body)}\nreturn diffuseColor.rgb;\n}`, uniforms };
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
