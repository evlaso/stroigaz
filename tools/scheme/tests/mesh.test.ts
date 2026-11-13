import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseName, isStep, meshFormat } from '../src/settings.ts';

test('форматы: STEP через OpenCascade, сетки через three.js', () => {
  assert.ok(isStep('a.STP') && isStep('b.step'));
  assert.equal(meshFormat('kns.STL'), 'stl');
  assert.equal(meshFormat('a.obj'), 'obj');
  assert.equal(meshFormat('a.glb'), 'gltf');
  assert.equal(meshFormat('a.gltf'), 'gltf');
  assert.equal(meshFormat('a.step'), undefined);
  assert.equal(meshFormat('a.stl.zip'), undefined);
});

test('имя экспорта: срезается любое расширение', () => {
  assert.equal(baseName('КНС.stl'), 'КНС');
  assert.equal(baseName('model.v2.glb'), 'model.v2');
  assert.equal(baseName('dosing.STEP'), 'dosing');
  assert.equal(baseName('model'), 'model');
});
