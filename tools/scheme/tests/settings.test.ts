import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { clampView, defaults, degrees, exportFrame, PAN_LIMIT, panBy, parsePreset, projectStep, TESSELLATION, ZOOM, zoomAt } from '../src/settings.ts';

test('поворот — целые градусы с переходом через 360', () => {
  assert.equal(degrees(350 + 45), 35);
  assert.equal(degrees(-10), 350);
  assert.equal(degrees(2.6), 3);
});

test('пресет дозирования: зеркало до поворота, фронт +Y влево-вниз', () => {
  const p = parsePreset(JSON.parse(readFileSync(new URL('../examples/dosing.preset.json', import.meta.url), 'utf8')));
  assert.equal(p.rotation, 350); assert.equal(p.mirrorX, true);
  const front = projectStep(0, 1, 0, p.rotation, p.mirrorX);
  assert.ok(front[0] < 0 && front[1] > 0);
  const side = projectStep(-1, 0, 0, p.rotation, p.mirrorX);
  assert.ok(side[0] > 0 && side[1] > 0);
  const actual = projectStep(2, 3, 4, 90, true);
  const expected = projectStep(-3, -2, 4, 0, false);
  actual.forEach((n, i) => assert.ok(Math.abs(n - expected[i]) < 1e-12));
});

test('камера 55° / 31°, STEP Z направлена вверх на экране', () => {
  const [x, y] = projectStep(16, -23, 42, 0, false);
  const a = 55 * Math.PI / 180, e = 31 * Math.PI / 180;
  assert.equal(x, 16 * Math.sin(a) + 23 * Math.cos(a));
  assert.equal(y, (16 * Math.cos(a) - 23 * Math.sin(a)) * Math.sin(e) - 42 * Math.cos(e));
  assert.ok(projectStep(0, 0, 1, 0, false)[1] < 0);
});

test('JSON-пресет валидируется, не сливается в объекты приложения', () => {
  assert.deepEqual(parsePreset(structuredClone(defaults)), defaults);
  assert.throws(() => parsePreset({ ...defaults, version: 2 }));
  assert.throws(() => parsePreset({ ...defaults, rotation: Infinity }));
  assert.throws(() => parsePreset({ ...defaults, mirrorX: 'yes' }));
  assert.throws(() => parsePreset({ ...defaults, outline: { ...defaults.outline, lineColor: 'red' } }));
  assert.throws(() => parsePreset({ ...defaults, outline: { ...defaults.outline, silhouetteWidth: 12 } }));
  assert.throws(() => parsePreset({ ...defaults, outline: { ...defaults.outline, edgeWidth: 0 } }));
  assert.throws(() => parsePreset({ ...defaults, outline: { ...defaults.outline, haloGap: -1 } }));
  assert.throws(() => parsePreset({ ...defaults, outline: undefined }));
});

test('допуски STEP зашиты и не входят в пресет; старые пресеты с допусками читаются', () => {
  assert.deepEqual({ ...TESSELLATION }, { linearDeflection: 0.8, angularDeflection: 0.5 });
  assert.ok(!('tessellation' in defaults));
  const legacy = { ...structuredClone(defaults), tessellation: { linearDeflection: 0, angularDeflection: 99 } };
  const parsed = parsePreset(legacy);
  assert.deepEqual(parsed, defaults);
  assert.ok(!JSON.stringify(parsed).includes('tessellation'));
});

test('два веса линии: силуэт вдвое толще рёбер, зазор по умолчанию', () => {
  assert.equal(defaults.outline.silhouetteWidth, defaults.outline.edgeWidth * 2);
  assert.ok(defaults.outline.haloGap > 0);
  assert.ok(!('lineWidth' in defaults.outline));
  // Пресет без зазора (только толщины) получает зазор по умолчанию; 0 выключает его.
  const { haloGap: _, ...noGap } = defaults.outline;
  assert.equal(parsePreset({ ...defaults, outline: noGap }).outline.haloGap, defaults.outline.haloGap);
  assert.equal(parsePreset({ ...defaults, outline: { ...defaults.outline, haloGap: 0 } }).outline.haloGap, 0);
});

test('старый пресет с lineWidth: рёбра = lineWidth, силуэт = ×2, поле не экспортируется', () => {
  const { silhouetteWidth: _s, edgeWidth: _e, haloGap: _g, ...rest } = defaults.outline;
  const parsed = parsePreset({ ...defaults, outline: { ...rest, lineWidth: 1.2 } });
  assert.equal(parsed.outline.edgeWidth, 1.2);
  assert.equal(parsed.outline.silhouetteWidth, 2.4);
  assert.equal(parsed.outline.haloGap, defaults.outline.haloGap);
  assert.ok(!('lineWidth' in parsed.outline));
  assert.equal(parsePreset({ ...defaults, outline: { ...rest, lineWidth: 3 } }).outline.silhouetteWidth, 6);
  assert.throws(() => parsePreset({ ...defaults, outline: { ...rest, lineWidth: 12 } }));
});

test('блок shading: необязателен в старых пресетах, валидируется в новых', () => {
  const { shading: _, ...legacy } = structuredClone(defaults);
  assert.deepEqual(parsePreset(legacy).shading, defaults.shading);
  assert.equal(defaults.shading.edges, true);
  const custom = { ...structuredClone(defaults), shading: { edges: false, occlusion: 0.4, occlusionRadius: 20 } };
  assert.deepEqual(parsePreset(custom).shading, custom.shading);
  // Отдельные поля тоже необязательны.
  assert.deepEqual(parsePreset({ ...defaults, shading: { edges: false } }).shading, { ...defaults.shading, edges: false });
  assert.throws(() => parsePreset({ ...defaults, shading: { ...defaults.shading, edges: 'yes' } }));
  assert.throws(() => parsePreset({ ...defaults, shading: { ...defaults.shading, occlusion: 5 } }));
  assert.throws(() => parsePreset({ ...defaults, shading: { ...defaults.shading, occlusionRadius: 0 } }));
  assert.throws(() => parsePreset({ ...defaults, shading: 'studio' }));
});

test('блок view: необязателен, валидируется, зум к точке и сдвиг', () => {
  const { view: _, ...legacy } = structuredClone(defaults);
  assert.deepEqual(parsePreset(legacy).view, { zoom: 1, panX: 0, panY: 0 });
  assert.deepEqual(parsePreset({ ...defaults, view: { zoom: 3 } }).view, { zoom: 3, panX: 0, panY: 0 });
  const custom = { ...structuredClone(defaults), view: { zoom: 2.5, panX: -0.1, panY: 0.2 } };
  assert.deepEqual(parsePreset(custom).view, custom.view);
  assert.throws(() => parsePreset({ ...defaults, view: { zoom: 10 } }));
  assert.throws(() => parsePreset({ ...defaults, view: { zoom: 0.1 } }));
  assert.throws(() => parsePreset({ ...defaults, view: { panX: 2 } }));
  assert.throws(() => parsePreset({ ...defaults, view: 'fit' }));
  // Точка под курсором остаётся на месте: p = pan + u / zoom до и после.
  const start = { zoom: 1.5, panX: 0.05, panY: -0.02 };
  const u = 0.3, v = -0.2;
  const next = zoomAt(start, 4, u, v);
  assert.equal(next.zoom, 4);
  assert.ok(Math.abs((start.panX + u / start.zoom) - (next.panX + u / next.zoom)) < 1e-4);
  assert.ok(Math.abs((start.panY + v / start.zoom) - (next.panY + v / next.zoom)) < 1e-4);
  // Зум к центру не сдвигает кадр; пределы 0,5–6.
  assert.deepEqual(zoomAt(start, 2), { ...start, zoom: 2 });
  assert.equal(zoomAt(start, 100).zoom, ZOOM.max);
  assert.equal(zoomAt(start, 0.01).zoom, ZOOM.min);
  // Сдвиг: картинка идёт за курсором, на зуме медленнее; не дальше края вписанного кадра.
  assert.deepEqual(panBy({ zoom: 2, panX: 0, panY: 0 }, 0.2, -0.1), { zoom: 2, panX: -0.1, panY: 0.05 });
  assert.deepEqual(clampView({ zoom: 3, panX: 9, panY: -9 }), { zoom: 3, panX: PAN_LIMIT, panY: -PAN_LIMIT });
});

test('блок export: «Вся модель» по умолчанию, старые пресеты, кадр экспорта', () => {
  const { export: _, ...legacy } = structuredClone(defaults);
  // Прозрачный фон — по умолчанию; старые пресеты (без export или без transparent) — тоже.
  assert.deepEqual(parsePreset(legacy).export, { frame: 'model', transparent: true });
  assert.deepEqual(parsePreset({ ...defaults, export: {} }).export, { frame: 'model', transparent: true });
  assert.deepEqual(parsePreset({ ...defaults, export: { frame: 'screen' } }).export, { frame: 'screen', transparent: true });
  assert.deepEqual(parsePreset({ ...defaults, export: { frame: 'model', transparent: false } }).export, { frame: 'model', transparent: false });
  assert.throws(() => parsePreset({ ...defaults, export: { frame: 'model', transparent: 'yes' } }));
  assert.throws(() => parsePreset({ ...defaults, export: { frame: 'all' } }));
  assert.throws(() => parsePreset({ ...defaults, export: 'model' }));
  const zoomed = { ...structuredClone(defaults), view: { zoom: 3, panX: 0.1, panY: -0.2 } };
  // «Вся модель»: вписанный кадр, остальное без изменений; пресет на экране не меняется.
  assert.deepEqual(exportFrame(zoomed), { ...zoomed, view: { zoom: 1, panX: 0, panY: 0 } });
  assert.deepEqual(zoomed.view, { zoom: 3, panX: 0.1, panY: -0.2 });
  const screen = { ...zoomed, export: { frame: 'screen' as const, transparent: true } };
  assert.equal(exportFrame(screen), screen);
  assert.equal(exportFrame(defaults), defaults);
});
