// NativeThreeBridge NativeRenderer: drop-in replacement for THREE.WebGLRenderer.
//
// The engine exports this class as `WebGLRenderer` from the 'three' module, so
// an unchanged webapp calling `new THREE.WebGLRenderer({ canvas })` gets native
// DX12 rendering instead of WebGL. render(scene, camera) walks the real
// Three.js scene graph and sends the engine:
//   * geometry buffers once (again only when an attribute version changes),
//   * InstancedMesh matrices/colours only when they change,
//   * one compact Float32Array "pass" per render() call: camera, lights and
//     a 32-float record per visible draw.
// This module has no imports so it can be unit tested with any THREE + fake nt.

export const PASS_HEADER_FLOATS = 64;
export const LIGHT_FLOATS = 16;
export const DRAW_FLOATS = 32;
export const MAX_LIGHTS = 16;

export const LightType = { DIRECTIONAL: 3, POINT: 4, SPOT: 5, HEMISPHERE: 2 };
export const DrawFlags = {
  TRANSPARENT: 1, DOUBLE_SIDED: 2, BACK_SIDE: 4, VERTEX_COLORS: 8, UNLIT: 16,
  NO_DEPTH_WRITE: 32, NO_DEPTH_TEST: 64, LINES: 128, LINE_STRIP: 256,
  NORMAL_COLOR: 512, INSTANCE_COLORS: 1024, FLAT: 2048,
};
export const PassFlags = { CLEAR_COLOR: 1, CLEAR_DEPTH: 2 };

export function createNativeRendererClasses(THREE, nt, host = globalThis.__ntHost) {
  const warnOnce = (key, text) => (host && host.warnOnce ? host.warnOnce(key, text) : undefined);
  const unsupported = (feature, detail) => (host && host.unsupported ? host.unsupported(feature, detail) : undefined);

  const _projScreen = new THREE.Matrix4();
  const _frustum = new THREE.Frustum();
  const _vec = new THREE.Vector3();
  const _vec2 = new THREE.Vector3();
  const _color = new THREE.Color();
  const _srgb = { r: 0, g: 0, b: 0 };

  let nextGeometryId = 1;
  let nextInstanceId = 1;

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
      const index = geometry.index;
      const key = `${position.version}:${normal ? normal.version : -1}:${color ? color.version : -1}:${index ? index.version : -1}:${position.count}:${index ? index.count : 0}`;
      if (record && record.key === key && record.position === position && record.normal === normal && record.index === index && record.color === color) return record;
      if (!record) {
        record = { id: nextGeometryId++, key: '', position: null, normal: null, color: null, index: null, hasColors: false, vertexCount: 0, indexCount: 0 };
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
      const colors = color ? toFloat3(color) : null;
      let indices = null;
      if (index) indices = index.array instanceof Uint32Array ? index.array : Uint32Array.from(index.array);
      nt.uploadGeometry(record.id, positions, normals, colors, indices);
      Object.assign(record, { key, position, normal, color, index, hasColors: !!colors, vertexCount: position.count, indexCount: index ? index.count : 0 });
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

    // ---------------------------------------------------------------- render
    render(scene, camera) {
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
      p[47] = this.toneMapping === THREE.NoToneMapping ? 1 : this.toneMappingExposure;
      if (this.toneMapping !== THREE.NoToneMapping) unsupported('Tone mapping curves (ACES, AgX …)', 'only toneMappingExposure is applied');
      if (scene.fog) unsupported('Fog', 'scenes render without fog');

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
        else if (object.isSprite) unsupported('THREE.Sprite', 'sprites are not drawn yet');
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
      if (m.isMeshBasicMaterial || m.isLineBasicMaterial || m.isLineDashedMaterial) flags |= DrawFlags.UNLIT;
      else if (m.isMeshNormalMaterial) flags |= DrawFlags.NORMAL_COLOR;
      else if (m.isMeshStandardMaterial) { roughness = m.roughness; metalness = m.metalness; }
      else if (m.isMeshPhongMaterial) { shininess = m.shininess; roughness = Math.sqrt(2 / (m.shininess + 2)); }
      else if (m.isMeshLambertMaterial || m.isMeshToonMaterial) { roughness = 1; }
      else if (m.isShadowMaterial) return;
      else if (m.isShaderMaterial || m.isRawShaderMaterial) unsupported('ShaderMaterial / custom GLSL', `drawn as a plain lit surface (${m.type})`);
      else if (m.isMeshMatcapMaterial) unsupported('MeshMatcapMaterial', 'drawn as lit colour');
      else if (m.isMeshDepthMaterial || m.isMeshDistanceMaterial) return;
      if (m.map || m.normalMap || m.roughnessMap || m.metalnessMap || m.emissiveMap || m.aoMap || m.alphaMap || m.envMap || m.lightMap || m.bumpMap) {
        unsupported('Textures (map, normalMap, envMap …)', 'materials use their base colour (planned for v0.30)');
      }
      if (m.wireframe) unsupported('Wireframe materials', 'drawn solid');
      if (m.onBeforeCompile && m.onBeforeCompile.toString() !== THREE.Material.prototype.onBeforeCompile.toString()) unsupported('material.onBeforeCompile shader patches');
      if (m.clippingPlanes && m.clippingPlanes.length) unsupported('Clipping planes');
      if (m.blending === THREE.AdditiveBlending) unsupported('AdditiveBlending', 'drawn with normal alpha blending');
      const color = m.color || (m.uniforms && m.uniforms.color && m.uniforms.color.value) || null;
      const emissive = m.emissive || null;
      const ei = m.emissiveIntensity ?? 1;
      const draw = {
        geometryId: base.record.id, instanceId: base.instances ? base.instances.id : 0,
        instanceCount: base.instances ? mesh.count : 1, flags, start, count,
        roughness, metalness, shininess,
        r: color && color.isColor ? color.r : 1, g: color && color.isColor ? color.g : 1, b: color && color.isColor ? color.b : 1,
        opacity: m.opacity ?? 1,
        er: emissive ? emissive.r * ei : 0, eg: emissive ? emissive.g * ei : 0, eb: emissive ? emissive.b * ei : 0,
        matrix: mesh.matrixWorld.elements, z: base.z, renderOrder: mesh.renderOrder || 0,
      };
      if (globalThis.__ntDebugDraws) {
        const g = mesh.geometry, c = g.attributes.color;
        globalThis.__ntDebugDraws.push({
          mesh: mesh.name || mesh.type, material: m.type, matName: m.name || '', color: color && color.isColor ? color.getHexString() : null,
          vertexColors: !!m.vertexColors, colorAttr: c ? `${c.itemSize}/${c.array.constructor.name}/${c.normalized}` : null,
          map: !!m.map, onBeforeCompile: m.onBeforeCompile && m.onBeforeCompile.toString() !== THREE.Material.prototype.onBeforeCompile.toString(),
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

function computeNormals(THREE, position, index) {
  const temp = new THREE.BufferGeometry();
  temp.setAttribute('position', position);
  if (index) temp.setIndex(index);
  temp.computeVertexNormals();
  return toFloat3(temp.getAttribute('normal'));
}
