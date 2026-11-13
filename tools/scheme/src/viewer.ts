import * as THREE from 'three';
import { AZIMUTH, ELEVATION, WIDTH, HEIGHT, MAX_DISPLAY_WIDTH, PAD, TRACE_LIMIT } from './settings.ts';
import { Downsample, EDGE_LAYER, OutlinePass } from './outline-pass.ts';
import { ShadedPass, type ShadeOptions } from './shading-pass.ts';
import { createStudio } from './studio.ts';
import type { Tracer } from './tracer.ts';
import type { AssemblyNode, Part, Preset } from './types.ts';

/** Neutral light grey (linear) of parts without a colour; CAD colours are muted towards it. */
const BASE_GREY = 0.42;

export interface TraceState {
  phase: 'loading' | 'building' | 'tracing' | 'done';
  scale: number;
  samples: number;
  ms: number;
  running: boolean;
  /** Why tracing stopped: sample limit, time limit or the user. */
  stopped?: 'samples' | 'time' | 'user';
  /** The traced frame is not the one on screen (the whole model while zoomed in): the canvas shows the traced frame. */
  framed: boolean;
}

export class Viewer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.OrthographicCamera();
  readonly model = new THREE.Group();
  private coordinateSystem = new THREE.Group();
  private outline?: OutlinePass;
  /** On screen the outline is drawn at ≥ 4× into this target and area-averaged to the canvas. */
  private outlineImage?: THREE.WebGLRenderTarget;
  private downsample?: Downsample;
  /** Canvas buffer on screen, device px: the CSS size × devicePixelRatio, at most MAX_DISPLAY_WIDTH. */
  readonly display = { width: WIDTH * 2, height: HEIGHT * 2 };
  private edges?: THREE.LineSegments;
  private positions: Float32Array[] = [];
  private materials = new Map<string, THREE.MeshStandardMaterial>();
  private raycaster = new THREE.Raycaster();
  private span = 1;
  private unitsPerPixel = 1;
  /** Fitted frame of the current rotation: projected bbox centre and model units per 1× pixel. */
  private fitted?: { key: string; cx: number; cy: number; unitsPerPixel: number };
  private shaded?: ShadedPass;
  private studio = createStudio();
  private rig = new THREE.Group();
  private key: THREE.DirectionalLight;
  private fill: THREE.DirectionalLight;
  private tracer?: Tracer;
  private traceId = 0;
  private traceStop?: TraceState['stopped'];
  /** Camera of the traced frame; the screen camera keeps the zoomed view meanwhile. */
  private traceCamera?: THREE.OrthographicCamera;
  trace?: TraceState;
  /** «Трассировка» shows the shaded view, with the traced image once it has samples. */
  mode: 'model' | 'outline' | 'trace' = 'model';
  ready = false;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true, alpha: true, premultipliedAlpha: true });
    // An alpha canvas for the transparent PNG; the screen always draws opaque (alpha 1).
    this.renderer.setPixelRatio(1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // iso-kit has a left-handed screen projection relative to STEP. Reflect Y
    // only at the renderer boundary, plus reflect the camera position. STEP
    // transforms remain Rz(rotation) * Mx(mirror); normals/culling stay correct.
    this.coordinateSystem.scale.y = -1;
    this.coordinateSystem.add(this.model);
    this.scene.add(this.coordinateSystem);
    this.camera.up.set(0, 0, 1);
    // Studio rig (model mode only): environment without key / fill, the two as directional
    // lights of the same irradiance. No floor and no shadow catcher: the background stays
    // clean, the key shadows the model only onto itself.
    this.scene.environment = this.studio.raster;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    // Shadows depend on geometry and rotation only: re-rendered from fit(), not every frame.
    this.renderer.shadowMap.autoUpdate = false;
    this.key = new THREE.DirectionalLight(0xffffff, this.studio.key.irradiance);
    this.key.castShadow = true;
    this.key.shadow.mapSize.setScalar(this.renderer.capabilities.maxTextureSize >= 8192 ? 4096 : 2048);
    // PCF over a few texels: a soft edge without the light bleeding of variance maps.
    this.key.shadow.radius = 2.5;
    this.fill = new THREE.DirectionalLight(0xffffff, this.studio.fill.irradiance);
    this.rig.add(this.key, this.key.target, this.fill, this.fill.target);
    this.rig.visible = false;
    this.scene.add(this.rig);
  }

  clear(): void {
    this.dropTrace();
    this.tracer?.dispose();
    this.tracer = undefined;
    this.model.traverse(o => { if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) o.geometry.dispose(); });
    (this.edges?.material as THREE.Material | undefined)?.dispose();
    this.model.clear();
    this.edges = undefined;
    this.materials.forEach(m => m.dispose());
    this.materials.clear();
    this.positions = [];
    this.fitted = undefined;
    this.ready = false;
    this.renderer.renderLists.dispose();
  }

  private material(rgb?: number[]): THREE.MeshStandardMaterial {
    const key = rgb?.join(',') ?? 'default';
    let material = this.materials.get(key);
    if (!material) {
      // XCAF Quantity_Color channels are linear RGB, not hex / sRGB. The render is for form,
      // not colour: CAD colours are kept but desaturated and pulled towards the light grey.
      const color = new THREE.Color().setRGB(BASE_GREY, BASE_GREY, BASE_GREY, THREE.LinearSRGBColorSpace);
      if (rgb) {
        const luma = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
        const muted = rgb.map(c => (c + luma) / 2);
        color.setRGB(...(muted.map(c => c * 0.55 + BASE_GREY * 0.45) as [number, number, number]), THREE.LinearSRGBColorSpace);
      }
      // A little metal and medium roughness: highlights follow the curvature of shells and pipes.
      material = new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.2, side: THREE.DoubleSide });
      this.materials.set(key, material);
    }
    return material;
  }

  async assemble(parts: Part[], root: AssemblyNode, progress: (fraction: number) => void, signal: AbortSignal): Promise<void> {
    this.clear();
    const meshes: THREE.Mesh[] = [];
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (const part of parts) {
      const p = part.positions;
      for (let i = 0; i < p.length; i += 3) for (let axis = 0; axis < 3; axis++) {
        min[axis] = Math.min(min[axis], p[i + axis]);
        max[axis] = Math.max(max[axis], p[i + axis]);
      }
    }
    const center = min.map((v, i) => (v + max[i]) / 2);
    for (let index = 0; index < parts.length; index++) {
      signal.throwIfAborted();
      const part = parts[index];
      for (let i = 0; i < part.positions.length; i += 3) {
        part.positions[i] -= center[0]; part.positions[i + 1] -= center[1]; part.positions[i + 2] -= center[2];
      }
      this.positions.push(part.positions);
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(part.positions, 3));
      geometry.setIndex(new THREE.BufferAttribute(part.indices, 1));
      if (part.normals?.length) geometry.setAttribute('normal', new THREE.BufferAttribute(part.normals, 3));
      else geometry.computeVertexNormals();
      // Merge adjacent BREP face groups with the same color, not one draw call per face.
      const materials: THREE.MeshStandardMaterial[] = [];
      const materialIndex = new Map<THREE.Material, number>();
      const addGroup = (start: number, count: number, rgb?: number[]) => {
        if (count <= 0) return;
        const material = this.material(rgb ?? part.color);
        let m = materialIndex.get(material);
        if (m === undefined) { m = materials.length; materials.push(material); materialIndex.set(material, m); }
        const last = geometry.groups.at(-1);
        if (last && last.materialIndex === m && last.start + last.count === start) last.count += count;
        else geometry.addGroup(start, count, m);
      };
      let cursor = 0;
      for (const face of part.faces) {
        const start = face.first * 3, count = (face.last - face.first + 1) * 3;
        if (start > cursor) addGroup(cursor, start - cursor);
        addGroup(start, count, face.color ?? undefined);
        cursor = Math.max(cursor, start + Math.max(0, count));
      }
      if (cursor < part.indices.length) addGroup(cursor, part.indices.length - cursor);
      const mesh = new THREE.Mesh(geometry, materials.length ? materials : this.material(part.color));
      mesh.name = part.name || `Деталь ${index + 1}`;
      // Part id for the outline G-buffer (8-bit alpha, 0 = empty): a boundary between
      // two ids is a silhouette even without a depth step. Sequential ids keep neighbours
      // in the assembly distinct; only parts 255 apart share one.
      mesh.userData.partId = index % 255 + 1;
      mesh.castShadow = mesh.receiveShadow = true;
      meshes.push(mesh);
      // Attach immediately so aborted partial assemblies are disposed by clear().
      this.model.add(mesh);
      if (index % 30 === 0) {
        progress(index / parts.length);
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      }
    }
    const attached = new Set<number>();
    const makeNode = (node: AssemblyNode): THREE.Group => {
      const group = new THREE.Group();
      group.name = node.name;
      for (const i of node.meshes) if (meshes[i] && !attached.has(i)) {
        if (!parts[i].name && node.name) meshes[i].name = node.name;
        group.add(meshes[i]); attached.add(i);
      }
      node.children.forEach(child => group.add(makeNode(child)));
      return group;
    };
    this.model.add(makeNode(root));
    // All feature edges in one draw call, centred like the parts. Only the outline pass renders this layer.
    const edgeCount = parts.reduce((sum, part) => sum + (part.edgeAngles?.length ?? 0), 0);
    if (edgeCount) {
      const positions = new Float32Array(edgeCount * 6), angles = new Float32Array(edgeCount * 2);
      let offset = 0;
      for (const part of parts) {
        if (!part.edges || !part.edgeAngles) continue;
        for (let i = 0; i < part.edges.length; i++) positions[offset * 6 + i] = part.edges[i] - center[i % 3];
        for (let i = 0; i < part.edgeAngles.length; i++) angles[(offset + i) * 2] = angles[(offset + i) * 2 + 1] = part.edgeAngles[i];
        offset += part.edgeAngles.length;
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geometry.setAttribute('angle', new THREE.BufferAttribute(angles, 1));
      this.edges = new THREE.LineSegments(geometry);
      this.edges.name = 'feature-edges';
      this.edges.layers.set(EDGE_LAYER);
      this.edges.frustumCulled = false;
      this.model.add(this.edges);
    }
    this.ready = true;
    progress(1);
  }

  /**
   * Camera of the 760 × 500 frame: the exact projected bbox fitted with a 20 px margin
   * (zoom 1), then zoomed and panned by `preset.view`. The projection over all vertices
   * and the shadow map depend on the rotation only: zoom and pan just move the camera.
   */
  fit(preset: Preset): void {
    if (!this.positions.length) return;
    const key = `${preset.rotation}|${preset.mirrorX}`;
    if (this.fitted?.key !== key) {
      const r = preset.rotation * Math.PI / 180;
      this.model.rotation.z = r;
      this.model.scale.x = preset.mirrorX ? -1 : 1;
      const c = Math.cos(r), s = Math.sin(r), mirror = preset.mirrorX ? -1 : 1;
      const sa = Math.sin(AZIMUTH), ca = Math.cos(AZIMUTH), se = Math.sin(ELEVATION), ce = Math.cos(ELEVATION);
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, d0 = Infinity, d1 = -Infinity;
      // Exact projected vertex bbox, not an inflated bbox of rotated world AABBs.
      for (const p of this.positions) for (let i = 0; i < p.length; i += 3) {
        const x = c * p[i] * mirror - s * p[i + 1], y = s * p[i] * mirror + c * p[i + 1], z = p[i + 2];
        const sx = x * sa - y * ca, sy = (x * ca + y * sa) * se - z * ce, depth = (x * ca + y * sa) * ce + z * se;
        x0 = Math.min(x0, sx); x1 = Math.max(x1, sx); y0 = Math.min(y0, sy); y1 = Math.max(y1, sy);
        d0 = Math.min(d0, depth); d1 = Math.max(d1, depth);
      }
      const unitsPerPixel = Math.max((x1 - x0) / (WIDTH - PAD * 2), (y1 - y0) / (HEIGHT - PAD * 2), 1e-6);
      // Depth span is deterministic across file units, with minimal empty near/far space.
      const span = Math.max(d1 - d0, x1 - x0, y1 - y0, 1);
      const distance = d1 + span;
      this.camera.position.set(ca * ce * distance, -sa * ce * distance, se * distance);
      this.camera.lookAt(0, 0, 0);
      this.camera.near = Math.max(0.001, distance - d1 - span * 0.1);
      this.camera.far = distance - d0 + span * 0.1;
      this.span = span;
      this.fitted = { key, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, unitsPerPixel };
      this.model.updateMatrixWorld(true);
      this.fitStudio();
    }
    const { cx, cy, unitsPerPixel: fitted } = this.fitted;
    const { zoom, panX, panY } = preset.view;
    const unitsPerPixel = fitted / zoom;
    // Pan in fractions of the fitted frame; screen y grows downwards, camera y upwards.
    const x = cx + panX * WIDTH * fitted, y = cy + panY * HEIGHT * fitted;
    this.camera.left = x - WIDTH * unitsPerPixel / 2;
    this.camera.right = x + WIDTH * unitsPerPixel / 2;
    this.camera.top = -y + HEIGHT * unitsPerPixel / 2;
    this.camera.bottom = -y - HEIGHT * unitsPerPixel / 2;
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
    this.unitsPerPixel = unitsPerPixel;
  }

  /** Key-light shadow frustum around the model, at any rotation. */
  private fitStudio(): void {
    // fit() is also exercised without WebGL (tests/camera.test.ts): no rig there.
    if (!this.key) return;
    // The model is centred on its bbox: a sphere of half the diagonal holds it at any rotation.
    let radius = 0;
    for (const p of this.positions) for (let i = 0; i < p.length; i += 3) radius = Math.max(radius, p[i] * p[i] + p[i + 1] * p[i + 1] + p[i + 2] * p[i + 2]);
    radius = Math.sqrt(radius) * 1.02;
    const shadow = this.key.shadow.camera;
    this.key.position.copy(this.studio.key.direction).multiplyScalar(radius * 3);
    this.fill.position.copy(this.studio.fill.direction).multiplyScalar(radius * 3);
    shadow.left = shadow.bottom = -radius;
    shadow.right = shadow.top = radius;
    shadow.near = radius;
    shadow.far = radius * 5;
    shadow.updateProjectionMatrix();
    // Three shadow texels along the normal: no acne grain on large curved shells (KNS) at grazing
    // light, still no visible peter-panning of fasteners.
    const texel = radius * 2 / this.key.shadow.mapSize.x;
    this.key.shadow.bias = -0.0005;
    this.key.shadow.normalBias = texel * 3;
    this.rig.updateMatrixWorld(true);
    this.renderer.shadowMap.needsUpdate = true;
  }

  private shadeOptions(preset: Preset, scale: number, transparent = false): ShadeOptions {
    return { shading: preset.shading, normalThreshold: preset.outline.normalThreshold, background: preset.outline.background, transparent, scale, unitsPerPixel: this.unitsPerPixel };
  }

  /**
   * Buffer size of the canvas on screen (device px). Returns true when it changed.
   * The frame keeps 760 : 500, so the composition is the same at any size.
   */
  setDisplay(width: number): boolean {
    const w = Math.max(64, Math.min(MAX_DISPLAY_WIDTH, Math.round(width)));
    const h = Math.round(w * HEIGHT / WIDTH);
    if (w === this.display.width && h === this.display.height) return false;
    this.display.width = w; this.display.height = h;
    return true;
  }

  /**
   * Draw the current frame. Without `exportScale` — for the screen, at the canvas buffer
   * size; with it — at 760 × 500 × exportScale for PNG (the outline as before: at 4× straight
   * into the canvas, the PNG downscales it). All widths and radii are in 1× frame pixels times
   * the scale, so the screen and every export show the same picture.
   */
  render(preset: Preset, exportScale?: number): void {
    const traced = this.mode === 'trace' && this.ready && this.trace && this.trace.phase !== 'loading' && this.trace.phase !== 'building';
    const screen = exportScale === undefined;
    // The «Фон» colour stays on screen; only the PNG goes without it.
    const transparent = !screen && preset.export.transparent;
    this.rig.visible = this.mode !== 'outline';
    if (!this.ready) {
      this.renderer.setSize(this.display.width, this.display.height, false);
      this.renderer.setRenderTarget(null);
      this.renderer.setClearColor(preset.outline.background, 1);
      this.renderer.clear();
    } else if (this.mode === 'outline') {
      // Lines are supersampled at least 4× (as the 1× PNG), then area-averaged to the screen.
      const scale = screen ? Math.max(4, this.display.width / WIDTH) : 4;
      const width = Math.round(WIDTH * scale), height = Math.round(HEIGHT * scale);
      this.outline ??= new OutlinePass(width, height);
      this.outline.setSize(width, height);
      if (!screen || width === this.display.width) {
        this.renderer.setSize(width, height, false);
        this.outline.render(this.renderer, this.scene, this.camera, preset.outline, scale, null, transparent);
      } else {
        this.outlineImage ??= new THREE.WebGLRenderTarget(width, height, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false });
        if (this.outlineImage.width !== width || this.outlineImage.height !== height) this.outlineImage.setSize(width, height);
        this.outline.render(this.renderer, this.scene, this.camera, preset.outline, scale, this.outlineImage);
        this.renderer.setSize(this.display.width, this.display.height, false);
        this.downsample ??= new Downsample();
        this.downsample.render(this.renderer, this.outlineImage, this.display.width, this.display.height);
      }
    } else {
      const width = traced ? WIDTH * this.trace!.scale : screen ? this.display.width : WIDTH * exportScale;
      const height = traced ? HEIGHT * this.trace!.scale : screen ? this.display.height : HEIGHT * exportScale;
      this.renderer.setSize(width, height, false);
      this.shaded ??= new ShadedPass();
      this.shaded.setSize(width, height);
      const options = this.shadeOptions(preset, width / WIDTH, transparent);
      // A traced image keeps the coverage and edge mask drawn when tracing started.
      if (traced) this.shaded.present(this.renderer, options, { texture: this.tracer!.target.texture });
      else {
        this.shaded.draw(this.renderer, this.scene, this.camera, options, true);
        this.shaded.present(this.renderer, options);
      }
    }
  }

  /**
   * Progressive path tracing of `frame` (by default the view on screen) at `scale`, until the
   * sample or time limit or stopTrace(). The image stays on the canvas (and in PNG export)
   * until dropTrace(); the screen camera is left as `preset` set it.
   */
  async startTrace(preset: Preset, scale: number, onProgress: (state: TraceState) => void,
    limit: { samples: number; seconds: number } = TRACE_LIMIT, frame: Preset = preset): Promise<TraceState> {
    if (!this.ready) throw new Error('Модель не загружена');
    this.dropTrace();
    const id = ++this.traceId;
    // Camera and pixel size of the traced frame, then the screen view back (synchronously).
    const framed = frame !== preset;
    if (framed) this.fit(frame);
    const camera = this.traceCamera = this.camera.clone();
    const options = this.shadeOptions(frame, scale);
    if (framed) this.fit(preset);
    const state: TraceState = this.trace = { phase: 'loading', scale, samples: 0, ms: 0, running: true, framed };
    const alive = () => id === this.traceId;
    onProgress(state);
    try {
      if (!this.tracer) {
        const { Tracer } = await import('./tracer.ts');
        const tracer = await Tracer.create(this.renderer);
        if (!alive()) { tracer.dispose(); return state; }
        this.tracer = tracer;
      }
      const tracer = this.tracer;
      state.phase = 'building'; onProgress(state);
      await tracer.setScene(this.scene, camera);
      if (!alive()) return state;
      // The path tracer sees the full studio (softboxes give soft self-shadows) and no directional
      // lights. A black background: camera rays that miss add nothing, so the traced radiance is
      // premultiplied by coverage and goes onto the page background in the composite.
      const background = this.scene.background;
      tracer.prepare(() => {
        this.scene.environment = this.studio.traced; this.key.visible = this.fill.visible = false;
        this.scene.background = new THREE.Color(0x000000);
      }, () => {
        this.scene.environment = this.studio.raster; this.key.visible = this.fill.visible = true;
        this.scene.background = background;
      });
      // Coverage and edges at the traced resolution.
      this.renderer.setSize(WIDTH * scale, HEIGHT * scale, false);
      this.shaded ??= new ShadedPass();
      this.shaded.setSize(WIDTH * scale, HEIGHT * scale);
      this.shaded.draw(this.renderer, this.scene, camera, options, false);
      // Software GL: a full sample takes seconds there; small tiles keep each submission short,
      // so the page and the stop button stay responsive.
      const software = this.softwareGL();
      tracer.setTiles(software ? 8 : 1, software ? 8 : 1);
      state.phase = 'tracing';
      this.traceStop = undefined;
      const started = performance.now();
      while (alive()) {
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        if (!alive()) break;
        state.ms = performance.now() - started;
        const stop = this.traceStop ?? (tracer.samples >= limit.samples ? 'samples' : state.ms >= limit.seconds * 1000 ? 'time' : undefined);
        if (stop) { state.stopped = stop; break; }
        this.renderer.setSize(WIDTH * scale, HEIGHT * scale, false);
        tracer.sample();
        state.samples = Math.floor(tracer.samples);
        if (this.mode === 'trace') this.render(preset);
        onProgress(state);
      }
      if (alive()) state.phase = 'done';
    } catch (error) {
      if (alive()) this.dropTrace();
      throw error;
    } finally {
      state.running = false;
      if (alive()) { onProgress(state); if (this.mode === 'trace') this.render(preset); }
    }
    return state;
  }

  /** SwiftShader / llvmpipe: Chrome masks RENDERER, the unmasked name needs the debug extension. */
  private softwareGL(): boolean {
    const gl = this.renderer.getContext();
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const name = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? '');
    return /swiftshader|llvmpipe|softpipe/i.test(name);
  }

  /** WebGL path tracing needs float render targets (WebGL 2 + EXT_color_buffer_float). */
  get traceSupported(): boolean {
    return this.renderer.capabilities.isWebGL2 && this.renderer.extensions.has('EXT_color_buffer_float');
  }

  /** Stop accumulating; the traced image stays. */
  stopTrace(): void { if (this.trace?.running) this.traceStop = 'user'; }

  /** Back to the raster view (any change of view or shading invalidates a traced image). */
  dropTrace(): void {
    if (!this.trace) return;
    this.traceId++;
    this.trace.running = false;
    this.trace = undefined;
    this.traceCamera = undefined;
  }

  /**
   * PNG of `frame` (by default the view on screen) at 760 × 500 × scale. Another frame is rendered
   * with its own camera, then the screen camera is restored; the caller redraws the screen.
   */
  async png(preset: Preset, scale: number, frame: Preset = preset): Promise<Blob> {
    if (frame !== preset) {
      this.fit(frame);
      try { this.render(frame, scale); } finally { this.fit(preset); }
    } else this.render(preset, scale);
    const canvas = document.createElement('canvas');
    canvas.width = WIDTH * scale; canvas.height = HEIGHT * scale;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Браузер не поддерживает Canvas 2D');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.renderer.domElement, 0, 0, canvas.width, canvas.height);
    return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Не удалось создать PNG')), 'image/png'));
  }

  pick(clientX: number, clientY: number): string | undefined {
    const rect = this.renderer.domElement.getBoundingClientRect();
    // A traced image of another frame is on the canvas: pick in that frame.
    const camera = this.mode === 'trace' && this.traceCamera ? this.traceCamera : this.camera;
    this.raycaster.setFromCamera(new THREE.Vector2((clientX - rect.left) / rect.width * 2 - 1, 1 - (clientY - rect.top) / rect.height * 2), camera);
    return this.raycaster.intersectObject(this.model, true)[0]?.object.name;
  }
}
