import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALWAYS, creasedNormals, featureEdges, SMOOTH_ANGLE, triangleFaces, weld } from '../src/edges.ts';
import { creaseAngle, defaults } from '../src/settings.ts';

// Unit cube as a triangle soup (12 triangles, outward winding), like an STL.
const quads = [
  [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]], [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]],
  [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]], [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]],
  [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]], [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]],
];
const cube = new Float32Array(quads.flatMap(([a, b, c, d]) => [a, b, c, a, c, d].flat()));
const soup = (positions: Float32Array) => Uint32Array.from({ length: positions.length / 3 }, (_, i) => i);
const segments = (edges: { angles: Float32Array }, min: number) => [...edges.angles].filter(a => a >= min).length;

test('сварка вершин: одинаковые координаты, −0 и +0 — одна вершина', () => {
  const { ids, count } = weld(new Float32Array([0, 0, 0, -0, 0, 0, 1, 0, 0, 0, -0, -0]));
  assert.equal(count, 2);
  assert.deepEqual([...ids], [0, 0, 1, 0]);
});

test('рёбра сетки: 12 рёбер куба по 90°, диагонали граней не рисуются', () => {
  const edges = featureEdges(cube, soup(cube));
  assert.equal(edges.positions.length, edges.angles.length * 6);
  assert.equal(segments(edges, 89), 12);
  assert.ok([...edges.angles].every(a => Math.abs(a - 90) < 1e-3));
});

test('рёбра сетки: открытая кромка рисуется всегда, пологий излом — по порогу', () => {
  // Two triangles folded by 10° along x = 1: one fold edge + 4 open edges.
  const z = Math.tan(10 * Math.PI / 180);
  const p = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, /* */ 1, 0, 0, 2, 0, z, 1, 1, 0]);
  const edges = featureEdges(p, soup(p));
  assert.equal(segments(edges, ALWAYS), 4);
  const fold = [...edges.angles].filter(a => a < ALWAYS);
  assert.equal(fold.length, 1);
  assert.ok(Math.abs(fold[0] - 10) < 0.01);
  // The default threshold (≈32°) does not draw it.
  assert.ok(fold[0] < creaseAngle(defaults.outline.normalThreshold));
});

test('рёбра STEP: только границы BREP-граней, без диагоналей и швов внутри грани', () => {
  // The cube as one indexed mesh, two triangles per BREP face.
  const faces = quads.map((_, i) => ({ first: i * 2, last: i * 2 + 1 }));
  const edges = featureEdges(cube, soup(cube), triangleFaces(12, faces));
  assert.equal(edges.angles.length, 12);
  assert.ok([...edges.angles].every(a => a === ALWAYS));
  // One BREP face for the whole cube: a fully closed face has no CAD edges at all.
  const one = featureEdges(cube, soup(cube), triangleFaces(12, [{ first: 0, last: 11 }]));
  assert.equal(one.angles.length, 0);
});

test('нормали с изломом: гладкие на фасетах цилиндра, резкие на ребре куба', () => {
  const n = creasedNormals(cube);
  assert.ok(n.every(Number.isFinite));
  // Cube corners keep their face normal (90° > SMOOTH_ANGLE).
  for (let v = 0; v < 6; v++) assert.deepEqual([...n.slice(v * 3, v * 3 + 3)].map(Math.round), [0, 0, -1]);
  // A 24-sided prism side (15° between facets < SMOOTH_ANGLE): shared vertices get one radial normal.
  assert.ok(15 < SMOOTH_ANGLE);
  const sides = 24, p: number[] = [];
  for (let i = 0; i < sides; i++) {
    // Exact same coordinates for a shared vertex: angle of (i + 1) % sides, not 2π.
    const a = (i / sides) * 2 * Math.PI, b = (((i + 1) % sides) / sides) * 2 * Math.PI;
    const A = [Math.cos(a), Math.sin(a)], B = [Math.cos(b), Math.sin(b)];
    p.push(A[0], A[1], 0, B[0], B[1], 0, B[0], B[1], 1, A[0], A[1], 0, B[0], B[1], 1, A[0], A[1], 1);
  }
  const prism = new Float32Array(p);
  const pn = creasedNormals(prism);
  for (let v = 0; v < prism.length / 3; v++) {
    const radial = Math.hypot(prism[v * 3], prism[v * 3 + 1]);
    const dot = (pn[v * 3] * prism[v * 3] + pn[v * 3 + 1] * prism[v * 3 + 1]) / radial;
    assert.ok(dot > 0.9999, `вершина ${v}: нормаль радиальная`);
  }
  // Degenerate triangles never yield NaN / zero normals.
  const degenerate = creasedNormals(new Float32Array(9));
  assert.ok(degenerate.every(Number.isFinite));
  assert.ok(Math.hypot(degenerate[0], degenerate[1], degenerate[2]) > 0.99);
});

test('порог нормалей ↔ угол излома', () => {
  assert.ok(Math.abs(creaseAngle(0.32) - 18.4) < 0.1);
  assert.ok(Math.abs(creaseAngle(defaults.outline.normalThreshold) - 32) < 0.5);
  assert.equal(creaseAngle(5), 180);
});
