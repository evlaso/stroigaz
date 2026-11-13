import * as THREE from 'three';
import { AZIMUTH } from './settings.ts';

// Built-in neutral studio HDR for the «Модель» mode: computed here, nothing is downloaded.
//
// Light comes from a soft grey dome (bright zenith, darker lower hemisphere) and three softboxes
// placed relative to the fixed iso camera: a key at the upper left, a weak fill at the right
// and a long rim strip behind the model (highlights along cylinder edges and lids).
// The path tracer sees all softboxes in the environment, so the key casts a soft self-shadow.
// Rasterization cannot shadow an environment: there the key and the fill are cut out of the
// map and replaced by directional lights of the same irradiance (the key with a shadow map).

/** World axes as in STEP: Z up. The camera looks from azimuth −AZIMUTH (see Viewer.fit). */
const CAMERA_AZIMUTH = -AZIMUTH * 180 / Math.PI;

interface Softbox {
  azimuth: number;
  elevation: number;
  /** Half extents in tangent units (tan of the half angle), horizontal × vertical. */
  size: [number, number];
  radiance: number;
}

const KEY: Softbox = { azimuth: CAMERA_AZIMUTH - 55, elevation: 58, size: [0.16, 0.12], radiance: 52 };
const FILL: Softbox = { azimuth: CAMERA_AZIMUTH + 50, elevation: 18, size: [0.55, 0.32], radiance: 1.6 };
const RIM: Softbox = { azimuth: CAMERA_AZIMUTH + 180, elevation: 40, size: [1.1, 0.05], radiance: 4 };

export function direction(azimuth: number, elevation: number): THREE.Vector3 {
  const a = azimuth * Math.PI / 180, e = elevation * Math.PI / 180;
  return new THREE.Vector3(Math.cos(e) * Math.cos(a), Math.cos(e) * Math.sin(a), Math.sin(e));
}

function frame(box: Softbox) {
  const d = direction(box.azimuth, box.elevation);
  const u = new THREE.Vector3(0, 0, 1).cross(d).normalize();
  const v = d.clone().cross(u);
  return { d, u, v, box };
}

/** Soft-edged rectangle in gnomonic coordinates: 1 inside, 0 outside, smooth rim. */
function softbox(f: ReturnType<typeof frame>, x: number, y: number, z: number): number {
  const along = f.d.x * x + f.d.y * y + f.d.z * z;
  if (along <= 0) return 0;
  const s = Math.abs((f.u.x * x + f.u.y * y + f.u.z * z) / along) / f.box.size[0];
  const t = Math.abs((f.v.x * x + f.v.y * y + f.v.z * z) / along) / f.box.size[1];
  const edge = (q: number) => q <= 0.75 ? 1 : q >= 1 ? 0 : 0.5 + 0.5 * Math.cos((q - 0.75) / 0.25 * Math.PI);
  return edge(s) * edge(t);
}

function dome(z: number): number {
  // Zenith 0.6, horizon 0.36, nadir 0.12: neutral, no colour cast.
  if (z >= 0) return 0.36 + 0.24 * Math.pow(z, 0.7);
  return 0.12 + 0.24 * Math.pow(1 + z, 6);
}

export interface Studio {
  /** Everything, for the path tracer (scene.environment, equirect, linear, Z up). */
  traced: THREE.DataTexture;
  /** Without the key and the fill: rasterization adds them as directional lights. */
  raster: THREE.DataTexture;
  key: { direction: THREE.Vector3; irradiance: number };
  fill: { direction: THREE.Vector3; irradiance: number };
}

/**
 * Equirectangular maps in three.js convention (Y up in the lookup, as both the rasterizer
 * and three-gpu-pathtracer use): pixel (u, v) ↔ direction (cos θ cos φ, sin θ, cos θ sin φ).
 * The studio itself is defined with Z up, so it is evaluated at that same world direction.
 */
export function createStudio(width = 1024, height = 512): Studio {
  const key = frame(KEY), fill = frame(FILL), rim = frame(RIM);
  const traced = new Float32Array(width * height * 4), raster = new Float32Array(width * height * 4);
  let keyIrradiance = 0, fillIrradiance = 0;
  for (let j = 0; j < height; j++) {
    const theta = ((j + 0.5) / height - 0.5) * Math.PI;
    // Solid angle of one texel.
    const texel = Math.cos(theta) * (2 * Math.PI / width) * (Math.PI / height);
    for (let i = 0; i < width; i++) {
      const phi = ((i + 0.5) / width - 0.5) * 2 * Math.PI;
      const x = Math.cos(theta) * Math.cos(phi), y = Math.sin(theta), z = Math.cos(theta) * Math.sin(phi);
      const base = dome(z) + RIM.radiance * softbox(rim, x, y, z);
      const k = KEY.radiance * softbox(key, x, y, z), f = FILL.radiance * softbox(fill, x, y, z);
      keyIrradiance += k * texel * Math.max(0, key.d.x * x + key.d.y * y + key.d.z * z);
      fillIrradiance += f * texel * Math.max(0, fill.d.x * x + fill.d.y * y + fill.d.z * z);
      const o = (j * width + i) * 4;
      traced[o] = traced[o + 1] = traced[o + 2] = base + k + f; traced[o + 3] = 1;
      raster[o] = raster[o + 1] = raster[o + 2] = base; raster[o + 3] = 1;
    }
  }
  // Half float for the rasterizer (filterable everywhere, including SwiftShader); the path
  // tracer builds its own importance-sampling tables from the float data.
  const texture = (data: Float32Array, half: boolean) => {
    const t = half
      ? new THREE.DataTexture(Uint16Array.from(data, THREE.DataUtils.toHalfFloat), width, height, THREE.RGBAFormat, THREE.HalfFloatType)
      : new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.FloatType);
    t.mapping = THREE.EquirectangularReflectionMapping;
    t.colorSpace = THREE.LinearSRGBColorSpace;
    t.minFilter = t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = false;
    t.needsUpdate = true;
    return t;
  };
  return {
    traced: texture(traced, false), raster: texture(raster, true),
    key: { direction: key.d, irradiance: keyIrradiance },
    fill: { direction: fill.d, irradiance: fillIrradiance },
  };
}
