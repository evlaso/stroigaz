import type { ExportStyle, Preset, Tessellation, ViewStyle } from './types.ts';

export const WIDTH = 760;
export const HEIGHT = 500;
export const PAD = 20;
export const AZIMUTH = 55 * Math.PI / 180;
export const ELEVATION = 31 * Math.PI / 180;
export const MAX_FILE_BYTES = 384 * 1024 ** 2;
export const MAX_TRIANGLES = 5_000_000;
export const MAX_MESH_BYTES = 512 * 1024 ** 2;
export const IMPORT_TIMEOUT_MS = 8 * 60 * 1000;
/** Largest canvas buffer on screen, px wide (a 4K-wide model target is ≈ 0.4 GiB of GPU memory). */
export const MAX_DISPLAY_WIDTH = 4096;
/** Zoom of the fitted frame: slider range and step. */
export const ZOOM = Object.freeze({ min: 0.5, max: 6, step: 0.05 });
/** The frame centre may move up to the edge of the fitted frame: every point of the model stays reachable. */
export const PAN_LIMIT = 0.5;
export const TOO_LARGE = 'Файл слишком большой для браузерной конвертации';

export const defaults: Preset = {
  version: 1,
  rotation: 0,
  mirrorX: false,
  view: { zoom: 1, panX: 0, panY: 0 },
  outline: {
    // Fraction of the frame width (≈ fitted model size): 0.002 ≈ 1.5 px at 760 × 500.
    depthThreshold: 0.002,
    // |n₁ − n₂| = 0.55 ≈ 32°, the crease angle of scripts/anatomy/step-outline.py.
    normalThreshold: 0.55,
    // IKEA-style weights: the outer contour twice as heavy as inner edges,
    // with a light gap where an outline passes in front of farther edges.
    silhouetteWidth: 2,
    edgeWidth: 1,
    haloGap: 1.5,
    lineColor: '#383e43',
    background: '#ffffff',
  },
  shading: {
    edges: true,
    occlusion: 1,
    occlusionRadius: 12,
  },
  export: { frame: 'model', transparent: true },
};

/** Model-mode edges: 0.75 px at 1×, dark and translucent, over the shading. */
export const MODEL_EDGE = Object.freeze({ width: 0.75, color: '#1b2024', opacity: 0.55 });
/** Path tracing stops at whichever comes first. */
export const TRACE_LIMIT = Object.freeze({ samples: 300, seconds: 60 });

/** Fixed STEP tolerances. Absolute mm avoids assembly-size-dependent variation on small parts. */
export const TESSELLATION: Readonly<Tessellation> = Object.freeze({ linearDeflection: 0.8, angularDeflection: 0.5 });

export function degrees(value: number): number {
  return ((Math.round(value) % 360) + 360) % 360;
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

const round = (n: number, digits: number) => Math.round(n * 10 ** digits) / 10 ** digits || 0;

/**
 * The preset an export renders: with «Вся модель» the fitted frame (zoom 1, no pan) at the same
 * rotation, mirror and styles; otherwise the preset itself (the frame on screen).
 */
export function exportFrame(preset: Preset): Preset {
  const { zoom, panX, panY } = preset.view;
  if (preset.export.frame === 'screen' || (zoom === 1 && panX === 0 && panY === 0)) return preset;
  return { ...preset, view: { ...defaults.view } };
}

/** Zoom within the slider range, pan within the fitted frame; rounded for a tidy preset. */
export function clampView(view: ViewStyle): ViewStyle {
  return {
    zoom: round(clamp(view.zoom, ZOOM.min, ZOOM.max), 3),
    panX: round(clamp(view.panX, -PAN_LIMIT, PAN_LIMIT), 4),
    panY: round(clamp(view.panY, -PAN_LIMIT, PAN_LIMIT), 4),
  };
}

/**
 * Zoom to `zoom`, keeping the point under (u, v) in place. u, v — position in the frame
 * relative to its centre, in fractions of its width / height (−0.5…0.5); 0, 0 = the centre.
 */
export function zoomAt(view: ViewStyle, zoom: number, u = 0, v = 0): ViewStyle {
  const next = clamp(zoom, ZOOM.min, ZOOM.max);
  return clampView({ zoom: next, panX: view.panX + u / view.zoom - u / next, panY: view.panY + v / view.zoom - v / next });
}

/** Drag the picture by (du, dv) fractions of the frame width / height. */
export function panBy(view: ViewStyle, du: number, dv: number): ViewStyle {
  return clampView({ zoom: view.zoom, panX: view.panX - du / view.zoom, panY: view.panY - dv / view.zoom });
}

export function parsePreset(value: unknown): Preset {
  if (!value || typeof value !== 'object') throw new Error('Ожидался JSON-пресет');
  const v = value as Record<string, unknown>;
  if (v.version !== 1) throw new Error('Неизвестная версия пресета');
  const numeric = (n: unknown, min: number, max: number, label: string): number => {
    if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) {
      throw new Error(`Некорректное поле «${label}»`);
    }
    return n;
  };
  const color = (s: unknown): string => {
    if (typeof s !== 'string' || !/^#[0-9a-f]{6}$/i.test(s)) throw new Error('Некорректный цвет');
    return s;
  };
  const boolean = (b: unknown, label: string): boolean => {
    if (typeof b !== 'boolean') throw new Error(`Некорректное поле «${label}»`);
    return b;
  };
  if (typeof v.mirrorX !== 'boolean') throw new Error('Некорректное зеркало X');
  const o = v.outline as Record<string, unknown> | undefined;
  // Older presets may carry `tessellation`; tolerances are fixed now, so it is ignored.
  if (!o || typeof o !== 'object') throw new Error('В пресете нет настроек контура');
  // Older presets have one `lineWidth`: it becomes the edge width, the silhouette twice as heavy.
  // Presets before the studio render have no `shading`: defaults.
  const sh = v.shading as Record<string, unknown> | undefined;
  if (sh !== undefined && (!sh || typeof sh !== 'object')) throw new Error('Некорректный блок shading');
  const legacyWidth = o.silhouetteWidth === undefined && o.edgeWidth === undefined && o.lineWidth !== undefined
    ? numeric(o.lineWidth, 0.25, 3, 'толщина') : undefined;
  // Presets before zoom have no `view`: the fitted frame.
  const vw = v.view as Record<string, unknown> | undefined;
  if (vw !== undefined && (!vw || typeof vw !== 'object')) throw new Error('Некорректный блок view');
  // Presets before the export switch export the whole model.
  const ex = v.export as Record<string, unknown> | undefined;
  if (ex !== undefined && (!ex || typeof ex !== 'object')) throw new Error('Некорректный блок export');
  if (ex?.frame !== undefined && ex.frame !== 'model' && ex.frame !== 'screen') throw new Error('Некорректное поле «экспорт»');
  // Presets before the transparent export get the default: no background.
  return {
    version: 1,
    rotation: degrees(numeric(v.rotation, -36000, 36000, 'поворот')),
    mirrorX: v.mirrorX,
    view: {
      zoom: vw?.zoom === undefined ? defaults.view.zoom : numeric(vw.zoom, ZOOM.min, ZOOM.max, 'масштаб'),
      panX: vw?.panX === undefined ? defaults.view.panX : numeric(vw.panX, -PAN_LIMIT, PAN_LIMIT, 'сдвиг X'),
      panY: vw?.panY === undefined ? defaults.view.panY : numeric(vw.panY, -PAN_LIMIT, PAN_LIMIT, 'сдвиг Y'),
    },
    outline: {
      depthThreshold: numeric(o.depthThreshold, 0.0001, 0.03, 'порог глубины'),
      normalThreshold: numeric(o.normalThreshold, 0.02, 1.5, 'порог нормалей'),
      silhouetteWidth: legacyWidth === undefined ? numeric(o.silhouetteWidth, 0.25, 6, 'силуэт') : legacyWidth * 2,
      edgeWidth: legacyWidth ?? numeric(o.edgeWidth, 0.25, 3, 'рёбра'),
      haloGap: o.haloGap === undefined ? defaults.outline.haloGap : numeric(o.haloGap, 0, 3, 'зазор'),
      lineColor: color(o.lineColor),
      background: color(o.background),
    },
    shading: {
      edges: sh?.edges === undefined ? defaults.shading.edges : boolean(sh.edges, 'рёбра на модели'),
      occlusion: sh?.occlusion === undefined ? defaults.shading.occlusion : numeric(sh.occlusion, 0, 2, 'затенение'),
      occlusionRadius: sh?.occlusionRadius === undefined ? defaults.shading.occlusionRadius : numeric(sh.occlusionRadius, 2, 40, 'радиус затенения'),
    },
    export: {
      frame: (ex?.frame as ExportStyle['frame'] | undefined) ?? defaults.export.frame,
      transparent: ex?.transparent === undefined ? defaults.export.transparent : boolean(ex.transparent, 'прозрачный фон'),
    },
  };
}

/** Projection in original STEP axes, identical to iso-kit/line-scene. */
export function projectStep(x: number, y: number, z: number, rotation: number, mirrorX: boolean): [number, number] {
  const r = rotation * Math.PI / 180;
  const mx = mirrorX ? -x : x;
  const tx = Math.cos(r) * mx - Math.sin(r) * y;
  const ty = Math.sin(r) * mx + Math.cos(r) * y;
  return [
    tx * Math.sin(AZIMUTH) - ty * Math.cos(AZIMUTH),
    (tx * Math.cos(AZIMUTH) + ty * Math.sin(AZIMUTH)) * Math.sin(ELEVATION) - z * Math.cos(ELEVATION),
  ];
}

export type MeshFormat = 'stl' | 'obj' | 'gltf';

export function isStep(name: string): boolean { return /\.(step|stp)$/i.test(name); }

/** Mesh formats read by three.js loaders instead of OpenCascade. */
export function meshFormat(name: string): MeshFormat | undefined {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1].toLowerCase();
  return ext === 'stl' ? 'stl' : ext === 'obj' ? 'obj' : ext === 'glb' || ext === 'gltf' ? 'gltf' : undefined;
}

/** File name without its extension, for PNG export names. */
export function baseName(name: string): string { return name.replace(/\.[^./\\]+$/, '') || name; }

/** Crease angle in degrees for a normal-difference threshold |n₁ − n₂| of unit normals. */
export function creaseAngle(normalThreshold: number): number {
  return 2 * Math.asin(Math.min(1, normalThreshold / 2)) * 180 / Math.PI;
}
