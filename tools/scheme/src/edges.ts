// Mesh feature edges and creased normals, computed once in a worker.
//
// The image-space outline only sees what survives the 4× G-buffer: a 5 mm
// sheet seam on a 7 m tank or a 20 mm bolt head is below one pixel of depth or
// normal change and comes out as noise or not at all. Feature edges are exact
// 3-D segments, drawn as lines with a depth test against the same G-buffer,
// so they stay solid regardless of model scale and resolution.
//
// STEP: every boundary between two BREP faces is a CAD edge (always drawn).
// Edges inside one BREP face — tessellation diagonals, periodic seams — never
// are. Meshes (STL / OBJ / glTF) have no CAD topology: an edge is drawn when
// the dihedral angle exceeds the crease threshold chosen in the UI; open and
// non-manifold edges always are.

/** Angle stored for edges drawn at any crease threshold (CAD, open, non-manifold). */
export const ALWAYS = 180;
/** Mesh edges flatter than this are never stored: they are below any useful slider value. */
export const MIN_STORED_ANGLE = 1;
/** Normals are averaged across mesh edges flatter than this (auto-smooth), kept hard above. */
export const SMOOTH_ANGLE = 40;
/** Vertices shared by more corners than this keep flat normals (avoids O(n²) on giant fans). */
const MAX_FAN = 512;

export interface FeatureEdges {
  /** Two xyz endpoints per segment. */
  positions: Float32Array<ArrayBuffer>;
  /** Dihedral angle in degrees per segment, ALWAYS for CAD / open / non-manifold edges. */
  angles: Float32Array<ArrayBuffer>;
}

/** Exact-position welding: id per vertex. −0 and +0 are the same coordinate. */
export function weld(positions: Float32Array<ArrayBufferLike>): { ids: Uint32Array; count: number } {
  const vertices = Math.floor(positions.length / 3);
  const bits = new Uint32Array(positions.buffer, positions.byteOffset, vertices * 3);
  const key = (i: number) => { const b = bits[i]; return b === 0x80000000 ? 0 : b; };
  let size = 1;
  while (size < vertices * 2) size <<= 1;
  const table = new Int32Array(size).fill(-1);
  const first = new Uint32Array(vertices);
  const ids = new Uint32Array(vertices);
  let count = 0;
  for (let v = 0; v < vertices; v++) {
    const x = key(v * 3), y = key(v * 3 + 1), z = key(v * 3 + 2);
    let h = Math.imul(x, 0x9e3779b1) ^ Math.imul(y ^ (y >>> 13), 0x85ebca77) ^ Math.imul(z ^ (z >>> 7), 0xc2b2ae3d);
    h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12;
    let slot = h & (size - 1);
    for (;;) {
      const u = table[slot];
      if (u < 0) { table[slot] = count; first[count] = v; ids[v] = count++; break; }
      const r = first[u] * 3;
      if (key(r) === x && key(r + 1) === y && key(r + 2) === z) { ids[v] = u; break; }
      slot = (slot + 1) & (size - 1);
    }
  }
  return { ids, count };
}

/** Unit face normals (zero for degenerate triangles). */
function faceNormals(positions: Float32Array<ArrayBufferLike>, indices: Uint32Array<ArrayBufferLike>): Float32Array {
  const triangles = Math.floor(indices.length / 3);
  const out = new Float32Array(triangles * 3);
  for (let t = 0; t < triangles; t++) {
    const a = indices[t * 3] * 3, b = indices[t * 3 + 1] * 3, c = indices[t * 3 + 2] * 3;
    const ax = positions[b] - positions[a], ay = positions[b + 1] - positions[a + 1], az = positions[b + 2] - positions[a + 2];
    const bx = positions[c] - positions[a], by = positions[c + 1] - positions[a + 1], bz = positions[c + 2] - positions[a + 2];
    const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    const length = Math.hypot(nx, ny, nz);
    if (length > 0) { out[t * 3] = nx / length; out[t * 3 + 1] = ny / length; out[t * 3 + 2] = nz / length; }
  }
  return out;
}

/** Corner lists per welded vertex (CSR). */
function cornersByVertex(cornerIds: Uint32Array, count: number): { start: Uint32Array; corners: Uint32Array } {
  const start = new Uint32Array(count + 1);
  for (let c = 0; c < cornerIds.length; c++) start[cornerIds[c] + 1]++;
  for (let v = 0; v < count; v++) start[v + 1] += start[v];
  const fill = start.slice(0, count);
  const corners = new Uint32Array(cornerIds.length);
  for (let c = 0; c < cornerIds.length; c++) corners[fill[cornerIds[c]]++] = c;
  return { start, corners };
}

/** Per-triangle BREP face id, −1 where a part has no face table (meshes). */
export function triangleFaces(triangles: number, faces: { first: number; last: number }[]): Int32Array | undefined {
  if (!faces.length) return undefined;
  const out = new Int32Array(triangles).fill(-1);
  faces.forEach((face, id) => { for (let t = Math.max(0, face.first); t <= Math.min(triangles - 1, face.last); t++) out[t] = id; });
  return out;
}

/**
 * Feature edges of an (indexed or soup) triangle mesh. With `faceOf` (STEP),
 * only BREP face boundaries and free edges are returned; without it, every
 * mesh edge at least MIN_STORED_ANGLE sharp, plus open / non-manifold edges.
 */
export function featureEdges(positions: Float32Array<ArrayBufferLike>, indices: Uint32Array<ArrayBufferLike>, faceOf?: Int32Array): FeatureEdges {
  const { ids, count } = weld(positions);
  const triangles = Math.floor(indices.length / 3);
  const normals = faceNormals(positions, indices);
  // Bucket every triangle side by its lower welded vertex.
  const start = new Uint32Array(count + 1);
  for (let c = 0; c < triangles * 3; c++) {
    const a = ids[indices[c]], b = ids[indices[c - (c % 3) + ((c + 1) % 3)]];
    if (a !== b) start[Math.min(a, b) + 1]++;
  }
  for (let v = 0; v < count; v++) start[v + 1] += start[v];
  const fill = start.slice(0, count);
  const other = new Uint32Array(start[count]), face = new Uint32Array(start[count]);
  for (let c = 0; c < triangles * 3; c++) {
    const a = ids[indices[c]], b = ids[indices[c - (c % 3) + ((c + 1) % 3)]];
    if (a === b) continue;
    const slot = fill[Math.min(a, b)]++;
    other[slot] = Math.max(a, b); face[slot] = (c / 3) | 0;
  }
  const outPositions: number[] = [];
  const outAngles: number[] = [];
  const representative = new Uint32Array(count);
  for (let v = 0; v < ids.length; v++) representative[ids[v]] = v;
  const emit = (a: number, b: number, angle: number) => {
    const pa = representative[a] * 3, pb = representative[b] * 3;
    outPositions.push(positions[pa], positions[pa + 1], positions[pa + 2], positions[pb], positions[pb + 1], positions[pb + 2]);
    outAngles.push(angle);
  };
  const degenerate = (t: number) => normals[t * 3] === 0 && normals[t * 3 + 1] === 0 && normals[t * 3 + 2] === 0;
  for (let a = 0; a < count; a++) {
    const s = start[a], e = start[a + 1];
    // Insertion sort of the (small) bucket by the other vertex groups shared sides.
    for (let i = s + 1; i < e; i++) {
      const o = other[i], f = face[i];
      let j = i - 1;
      while (j >= s && other[j] > o) { other[j + 1] = other[j]; face[j + 1] = face[j]; j--; }
      other[j + 1] = o; face[j + 1] = f;
    }
    for (let i = s; i < e;) {
      let j = i + 1;
      while (j < e && other[j] === other[i]) j++;
      const n = j - i, f0 = face[i];
      if (n === 1) {
        if (!degenerate(f0)) emit(a, other[i], ALWAYS);
      } else if (n === 2) {
        const f1 = face[i + 1];
        if (faceOf) {
          if (faceOf[f0] !== faceOf[f1] || faceOf[f0] < 0) emit(a, other[i], ALWAYS);
        } else if (!degenerate(f0) && !degenerate(f1)) {
          const dot = normals[f0 * 3] * normals[f1 * 3] + normals[f0 * 3 + 1] * normals[f1 * 3 + 1] + normals[f0 * 3 + 2] * normals[f1 * 3 + 2];
          const angle = Math.acos(Math.max(-1, Math.min(1, dot))) * 180 / Math.PI;
          if (angle >= MIN_STORED_ANGLE) emit(a, other[i], angle);
        }
      } else {
        emit(a, other[i], ALWAYS);
      }
      i = j;
    }
  }
  return { positions: new Float32Array(outPositions), angles: new Float32Array(outAngles) };
}

/**
 * Creased (auto-smooth) normals for a triangle soup / indexed mesh: averaged
 * over the triangles around a welded vertex whose normal is within
 * SMOOTH_ANGLE, hard across sharper edges. Facets of a curved surface stop
 * producing image-space crease noise; real edges stay sharp. Writes one
 * normal per vertex, so it requires every vertex to be used by exactly one
 * corner (non-indexed soup, as produced by the mesh worker).
 */
export function creasedNormals<T extends Float32Array<ArrayBufferLike>>(positions: Float32Array<ArrayBufferLike>, target?: T): T | Float32Array<ArrayBuffer> {
  const vertices = Math.floor(positions.length / 3);
  const out = target ?? new Float32Array(positions.length);
  const indices = new Uint32Array(vertices - (vertices % 3));
  for (let i = 0; i < indices.length; i++) indices[i] = i;
  const normals = faceNormals(positions, indices);
  // Angle-weighted averaging: a quad split into two triangles counts as much as one triangle.
  const weights = new Float32Array(indices.length);
  for (let c = 0; c < indices.length; c++) {
    const t = c - (c % 3), o = c * 3, p = (t + ((c + 1) % 3)) * 3, q = (t + ((c + 2) % 3)) * 3;
    const ax = positions[p] - positions[o], ay = positions[p + 1] - positions[o + 1], az = positions[p + 2] - positions[o + 2];
    const bx = positions[q] - positions[o], by = positions[q + 1] - positions[o + 1], bz = positions[q + 2] - positions[o + 2];
    const la = Math.hypot(ax, ay, az), lb = Math.hypot(bx, by, bz);
    weights[c] = la > 0 && lb > 0 ? Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by + az * bz) / (la * lb)))) : 0;
  }
  const { ids, count } = weld(positions);
  const { start, corners } = cornersByVertex(ids.subarray(0, indices.length), count);
  const cos = Math.cos(SMOOTH_ANGLE * Math.PI / 180);
  for (let v = 0; v < count; v++) {
    const s = start[v], e = start[v + 1];
    for (let i = s; i < e; i++) {
      const c = corners[i], t = (c / 3) | 0;
      const nx = normals[t * 3], ny = normals[t * 3 + 1], nz = normals[t * 3 + 2];
      const flat = nx === 0 && ny === 0 && nz === 0;
      let sx = 0, sy = 0, sz = 0;
      if (e - s <= MAX_FAN || flat) {
        for (let k = s; k < e; k++) {
          const u = (corners[k] / 3) | 0, w = weights[corners[k]];
          const mx = normals[u * 3], my = normals[u * 3 + 1], mz = normals[u * 3 + 2];
          // A degenerate triangle takes the plain average of its neighbours instead of a zero normal.
          if (flat || nx * mx + ny * my + nz * mz >= cos) { sx += mx * w; sy += my * w; sz += mz * w; }
        }
      }
      let length = Math.hypot(sx, sy, sz);
      // An isolated degenerate triangle still needs a unit normal for the G-buffer.
      if (!(length > 0)) { sx = nx; sy = ny; sz = flat ? 1 : nz; length = Math.hypot(sx, sy, sz); }
      out[c * 3] = sx / length; out[c * 3 + 1] = sy / length; out[c * 3 + 2] = sz / length;
    }
  }
  for (let c = indices.length; c < vertices; c++) out.fill(0, c * 3, c * 3 + 3);
  return out;
}
