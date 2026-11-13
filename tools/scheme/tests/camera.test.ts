import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Viewer } from '../src/viewer.ts';
import { defaults, WIDTH, HEIGHT, PAD, projectStep } from '../src/settings.ts';

test('настоящая three.js камера + Rz/Mx/отражение Y совпадают с проекцией конвейера', () => {
  // Fit does not need WebGL: exercise the actual Viewer.fit method, not a copy.
  const v = Object.create(Viewer.prototype) as Viewer & { positions: Float32Array[] };
  Object.assign(v, { positions: [new Float32Array([-20, -50, -70, 20, 50, 70, 2, -7, 9])], model: new THREE.Group(), camera: new THREE.OrthographicCamera() });
  v.camera.up.set(0, 0, 1);
  for (const rotation of [0, 45, 350]) for (const mirrorX of [false, true]) {
    const preset = { ...defaults, rotation, mirrorX };
    v.fit(preset);
    const points = [[-20, -50, -70], [20, 50, 70], [2, -7, 9]];
    const expected = points.map(p => projectStep(p[0], p[1], p[2], rotation, mirrorX));
    const xs = expected.map(p => p[0]), ys = expected.map(p => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const scale = Math.min((WIDTH - PAD * 2) / (x1 - x0), (HEIGHT - PAD * 2) / (y1 - y0));
    points.forEach((p, i) => {
      const actual = new THREE.Vector3(...p).applyMatrix4(v.model.matrixWorld);
      actual.y *= -1;
      actual.project(v.camera);
      const x = (actual.x + 1) * WIDTH / 2, y = (1 - actual.y) * HEIGHT / 2;
      assert.ok(Math.abs(x - (WIDTH / 2 + (expected[i][0] - (x0 + x1) / 2) * scale)) < 1e-5);
      assert.ok(Math.abs(y - (HEIGHT / 2 + (expected[i][1] - (y0 + y1) / 2) * scale)) < 1e-5);
      assert.ok(actual.z >= -1 && actual.z <= 1, 'внутри depth clipping');
    });
  }
});

test('масштаб и сдвиг: тот же кадр 760 × 500, точки удаляются от точки зума в zoom раз', () => {
  const v = Object.create(Viewer.prototype) as Viewer & { positions: Float32Array[] };
  Object.assign(v, { positions: [new Float32Array([-20, -50, -70, 20, 50, 70, 2, -7, 9])], model: new THREE.Group(), camera: new THREE.OrthographicCamera() });
  v.camera.up.set(0, 0, 1);
  const screen = (p: number[]) => {
    const a = new THREE.Vector3(...p).applyMatrix4(v.model.matrixWorld);
    a.y *= -1; a.project(v.camera);
    return [(a.x + 1) * WIDTH / 2, (1 - a.y) * HEIGHT / 2, a.z];
  };
  const points = [[-20, -50, -70], [20, 50, 70], [2, -7, 9]];
  v.fit({ ...defaults, rotation: 30 });
  const fitted = points.map(screen);
  const near = v.camera.near, far = v.camera.far;
  const view = { zoom: 3, panX: 0.1, panY: -0.05 };
  v.fit({ ...defaults, rotation: 30, view });
  assert.equal(v.camera.near, near); assert.equal(v.camera.far, far);
  points.map(screen).forEach((p, i) => {
    // Центр кадра смещён на pan (в долях вписанного кадра), всё растянуто в zoom раз вокруг него.
    const cx = WIDTH / 2 + view.panX * WIDTH, cy = HEIGHT / 2 + view.panY * HEIGHT;
    assert.ok(Math.abs(p[0] - (WIDTH / 2 + (fitted[i][0] - cx) * view.zoom)) < 1e-6);
    assert.ok(Math.abs(p[1] - (HEIGHT / 2 + (fitted[i][1] - cy) * view.zoom)) < 1e-6);
    assert.ok(Math.abs(p[2] - fitted[i][2]) < 1e-9, 'глубина не зависит от зума');
  });
  // Возврат к 1× — ровно прежний кадр.
  v.fit({ ...defaults, rotation: 30 });
  points.map(screen).forEach((p, i) => p.forEach((n, k) => assert.ok(Math.abs(n - fitted[i][k]) < 1e-9)));
});
