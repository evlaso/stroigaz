// Deep imports used by tracer.ts (the package's own types cover only its index).
declare module 'three-gpu-pathtracer/src/core/WebGLPathTracer.js' {
  export class WebGLPathTracer {
    constructor(renderer: import('three').WebGLRenderer);
  }
}
declare module 'three-mesh-bvh/src/workers/GenerateMeshBVHWorker.js' {
  export class GenerateMeshBVHWorker {
    dispose(): void;
  }
}
