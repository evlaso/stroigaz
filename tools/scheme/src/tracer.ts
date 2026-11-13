import type * as THREE from 'three';

// Progressive path tracing via three-gpu-pathtracer (WebGL 2, BVH from three-mesh-bvh built in
// a worker). The library is imported on the first «Трассировка» click: it is a separate chunk,
// the page and the raster view do not load it. Deep imports avoid the package index, which
// also pulls the xatlas UV unwrapper (WASM) that is not needed here.

interface PathTracer {
  readonly samples: number;
  readonly target: THREE.WebGLRenderTarget;
  readonly tiles: THREE.Vector2;
  readonly isCompiling: boolean;
  bounces: number;
  filterGlossyFactor: number;
  multipleImportanceSampling: boolean;
  renderDelay: number;
  minSamples: number;
  fadeDuration: number;
  renderToCanvas: boolean;
  rasterizeScene: boolean;
  dynamicLowRes: boolean;
  synchronizeRenderSize: boolean;
  setBVHWorker(worker: unknown): void;
  setSceneAsync(scene: THREE.Scene, camera: THREE.Camera, options?: { onProgress?: (fraction: number) => void }): Promise<unknown>;
  updateEnvironment(): void;
  updateLights(): void;
  renderSample(): void;
  reset(): void;
  dispose(): void;
}

export class Tracer {
  private constructor(private pt: PathTracer, private worker: { dispose(): void }) {}

  static async create(renderer: THREE.WebGLRenderer): Promise<Tracer> {
    const [{ WebGLPathTracer }, { GenerateMeshBVHWorker }] = await Promise.all([
      import('three-gpu-pathtracer/src/core/WebGLPathTracer.js'),
      import('three-mesh-bvh/src/workers/GenerateMeshBVHWorker.js'),
    ]);
    const pt = new WebGLPathTracer(renderer) as unknown as PathTracer;
    const worker = new GenerateMeshBVHWorker();
    pt.setBVHWorker(worker);
    // Our own loop and composite: no raster fallback, no fades, accumulate from sample 1.
    pt.renderToCanvas = false;
    pt.rasterizeScene = false;
    pt.dynamicLowRes = false;
    pt.renderDelay = 0;
    pt.minSamples = 1;
    pt.fadeDuration = 0;
    pt.synchronizeRenderSize = true;
    pt.multipleImportanceSampling = true;
    pt.bounces = 5;
    // Blurs glossy paths after rough bounces: fewer fireflies from the bright softboxes.
    pt.filterGlossyFactor = 0.5;
    return new Tracer(pt, worker);
  }

  get samples(): number { return this.pt.samples; }
  get target(): THREE.WebGLRenderTarget { return this.pt.target; }
  get compiling(): boolean { return this.pt.isCompiling; }

  /** Tiles per sample: fewer, longer GPU submissions vs. responsiveness. */
  setTiles(x: number, y: number): void { this.pt.tiles.set(x, y); }

  /**
   * Gathers the visible meshes (synchronously), then builds the BVH in a worker.
   * Environment and lights are read again in `prepare` once that is done.
   */
  async setScene(scene: THREE.Scene, camera: THREE.Camera, onProgress?: (fraction: number) => void): Promise<void> {
    await this.pt.setSceneAsync(scene, camera, { onProgress });
  }

  /** Re-reads environment and lights; `swap` / `restore` bracket the synchronous read. */
  prepare(swap: () => void, restore: () => void): void {
    swap();
    try { this.pt.updateEnvironment(); this.pt.updateLights(); }
    finally { restore(); }
    this.pt.reset();
  }

  sample(): void { this.pt.renderSample(); }

  dispose(): void { this.pt.dispose(); this.worker.dispose(); }
}
