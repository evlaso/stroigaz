export interface Tessellation {
  linearDeflection: number;
  angularDeflection: number;
}

export interface OutlineStyle {
  depthThreshold: number;
  normalThreshold: number;
  /** Outer contour: silhouettes, occlusion contours, boundaries between parts. Px at 1×. */
  silhouetteWidth: number;
  /** Inner lines: model edges (BREP / mesh creases) and normal creases. Px at 1×. */
  edgeWidth: number;
  /** Halo: inner lines of farther geometry are erased this far beyond a silhouette stroke. Px at 1×, 0 = off. */
  haloGap: number;
  lineColor: string;
  background: string;
}

/** Studio look of the «Модель» mode (raster and path tracing). The outline mode ignores it. */
export interface ShadingStyle {
  /** Thin dark CAD edges over the shaded model («shaded with edges»). */
  edges: boolean;
  /** Ambient occlusion strength, 0 = off. */
  occlusion: number;
  /** Ambient occlusion radius, px at 1× (independent of export scale and model units). */
  occlusionRadius: number;
}

/**
 * Zoom and pan of the frame relative to the fitted view (zoom 1 = the model fitted into
 * 760 × 500 with a 20 px margin). The frame stays 760 × 500: thresholds, line widths and the
 * ambient occlusion radius are in pixels of this frame, so they keep their on-screen size
 * when zooming (in model units they shrink as 1 / zoom).
 */
export interface ViewStyle {
  /** Magnification of the fitted frame, 0.5–6. */
  zoom: number;
  /** Frame centre offset from the fitted centre, in fractions of the fitted frame width (right +). */
  panX: number;
  /** The same in fractions of the fitted frame height (down +). */
  panY: number;
}

/**
 * What PNG and path tracing render: `model` — the whole model fitted into 760 × 500
 * (zoom 1, no pan, same rotation and mirror) whatever the screen shows; `screen` — the
 * zoomed and panned frame on the canvas.
 */
export interface ExportStyle {
  frame: 'model' | 'screen';
  /**
   * PNG without the background: alpha = model coverage (lines in the outline mode). The
   * screen keeps the «Фон» colour; the export only.
   */
  transparent: boolean;
}

export interface Preset {
  version: 1;
  rotation: number;
  mirrorX: boolean;
  view: ViewStyle;
  outline: OutlineStyle;
  shading: ShadingStyle;
  export: ExportStyle;
}

export interface Part {
  name: string;
  positions: Float32Array;
  normals?: Float32Array;
  indices: Uint32Array;
  color?: number[];
  faces: { first: number; last: number; color?: number[] | null }[];
  /** Feature edges (edges.ts): two xyz endpoints per segment, same axes as positions. */
  edges?: Float32Array;
  /** Dihedral angle in degrees per edge segment; 180 = always drawn (CAD / open edge). */
  edgeAngles?: Float32Array;
}

export interface AssemblyNode {
  name: string;
  meshes: number[];
  children: AssemblyNode[];
}

export interface ImportMetrics {
  fileBytes: number;
  readMs: number;
  conversionMs: number;
  packingMs: number;
  wasmPeakBytes: number;
  workerJsPeakBytes: number | null;
  geometryBytes: number;
  triangles: number;
  vertices: number;
  parts: number;
}

export type WorkerMessage =
  | { type: 'status'; phase: 'init' | 'reading' | 'partitioning' | 'tessellating' | 'packing'; text: string; progress?: number }
  | { type: 'log'; text: string }
  | { type: 'error'; message: string; detail: string; metrics?: Partial<ImportMetrics> }
  | { type: 'result'; parts: Part[]; root: AssemblyNode; metrics: ImportMetrics };

export interface OcctResult {
  success: boolean;
  root: AssemblyNode;
  meshes: {
    name: string;
    color?: number[];
    brep_faces: Part['faces'];
    attributes: { position: { array: number[] }; normal?: { array: number[] } };
    index: { array: number[] };
  }[];
}

export type MemoryPerformance = Performance & {
  memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number };
};
