import { chromium } from 'playwright-core';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const cube = fileURLToPath(new URL('../../../node_modules/occt-import-js/test/testfiles/simple-basic-cube/cube.stp', import.meta.url));
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome-stable', headless: true,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.goto(process.env.SCHEME_URL ?? 'http://localhost:8080/3d-gen/');
  await page.waitForFunction(() => window.__outlineLab?.state === 'empty');
  // Optional real assembly: cancel while the first fragment is tessellating.
  if (process.env.SCHEME_STEP) {
    await page.locator('#step-input').setInputFiles(process.env.SCHEME_STEP);
    await page.waitForFunction(() => document.body.dataset.phase === 'tessellating', {}, { timeout: 60000 });
    await page.locator('#cancel').click();
    await page.waitForFunction(() => window.__outlineLab.state === 'cancelled');
  }
  await page.locator('#step-input').setInputFiles(cube);
  await page.waitForFunction(() => window.__outlineLab.state === 'ready');
  assert.equal(await page.evaluate(() => window.__outlineLab.metrics.triangles), 12);
  for (const mode of ['model', 'outline']) {
    const before = await page.getAttribute('body', 'data-rendered');
    await page.locator(`#${mode}-mode`).click();
    await page.waitForFunction(({ mode, before }) => document.body.dataset.mode === mode && document.body.dataset.rendered !== before, { mode, before });
    const pixels = await page.evaluate(async mode => {
      const image = await createImageBitmap(document.querySelector('#viewport'));
      const canvas = document.createElement('canvas'); canvas.width = 760; canvas.height = 500;
      const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0, 760, 500); image.close();
      const pixels = ctx.getImageData(0, 0, 760, 500).data;
      let foreground = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (mode === 'outline' ? pixels[i] < 150 && pixels[i + 1] < 150 && pixels[i + 2] < 150
          : 765 - pixels[i] - pixels[i + 1] - pixels[i + 2] > 20) foreground++;
      }
      return foreground;
    }, mode);
    assert.ok(pixels > 100, `${mode}: не пустая картинка`);
    if (mode === 'outline') assert.ok(pixels < 760 * 500 * .2, 'контур не сплошная заливка');
    // Studio render: no floor, no shadow catcher — the background stays clean.
    else assert.ok(pixels < 760 * 500 * .5, 'модель без заливки фона');
  }
  // The open button above the settings pushes the canvas below the fold at 1100 px.
  await page.locator('#viewport').evaluate(canvas => canvas.scrollIntoView({ block: 'center', behavior: 'instant' }));
  const box = await page.locator('#viewport').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2); await page.mouse.up();
  assert.equal(await page.evaluate(() => window.__outlineLab.preset.rotation), 20);
  // The canvas buffer is the on-screen size (CSS px × DPR), not 760 × 500 stretched.
  {
    const r = await page.evaluate(() => window.__outlineLab.render);
    assert.equal(r.width, Math.round(r.css * r.dpr));
    assert.equal(r.height, Math.round(r.width * 500 / 760));
  }
  // Zoom and pan: wheel to the cursor (the page does not scroll), Shift / middle button drag pans,
  // slider, «Вписать» and double click return to the fitted frame.
  {
    const view = () => page.evaluate(() => window.__outlineLab.preset.view);
    const scrollY = await page.evaluate(() => scrollY);
    await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.3);
    await page.mouse.wheel(0, -400);
    await page.waitForFunction(() => window.__outlineLab.preset.view.zoom > 1.2);
    assert.equal(await page.evaluate(() => scrollY), scrollY, 'колёсико над моделью не прокручивает страницу');
    const zoomed = await view();
    assert.ok(zoomed.panX > 0 && zoomed.panY < 0, `зум к курсору сдвигает кадр к нему: ${JSON.stringify(zoomed)}`);
    await page.keyboard.down('Shift'); await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.7 - 50, box.y + box.height * 0.3 + 30, { steps: 4 });
    await page.mouse.up(); await page.keyboard.up('Shift');
    const panned = await view();
    assert.equal(panned.zoom, zoomed.zoom);
    assert.ok(panned.panX > zoomed.panX && panned.panY < zoomed.panY, 'картинка идёт за курсором');
    assert.equal(await page.evaluate(() => window.__outlineLab.preset.rotation), 20, 'Shift + перетаскивание не вращает');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down({ button: 'middle' }); await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2, { steps: 4 }); await page.mouse.up({ button: 'middle' });
    assert.ok((await view()).panX < panned.panX, 'средняя кнопка сдвигает');
    await page.locator('#fit-view').click();
    assert.deepEqual(await view(), { zoom: 1, panX: 0, panY: 0 });
    await page.locator('#zoom').evaluate(input => { input.value = String(Math.log2(3)); input.dispatchEvent(new Event('input', { bubbles: true })); });
    assert.deepEqual(await view(), { zoom: 3, panX: 0, panY: 0 });
    assert.equal(await page.locator('#zoom-value').textContent(), '3.00×');
    // Clicking «Вписать» scrolled the page to the controls: back to the canvas.
    await page.locator('#viewport').evaluate(canvas => canvas.scrollIntoView({ block: 'center', behavior: 'instant' }));
    const canvasBox = await page.locator('#viewport').boundingBox();
    await page.mouse.dblclick(canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height / 2);
    assert.deepEqual(await view(), { zoom: 1, panX: 0, panY: 0 });
  }
  // Studio shading controls (model mode); the outline ignores them.
  for (const [id, key, value] of [['occlusion', 'occlusion', '0.5'], ['occlusion-radius', 'occlusionRadius', '20']]) {
    await page.locator(`#${id}`).evaluate((input, value) => { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); }, value);
    assert.equal(await page.evaluate(key => window.__outlineLab.preset.shading[key], key), Number(value));
  }
  assert.equal(await page.locator('#model-edges').isChecked(), true);
  await page.locator('#model-edges').uncheck();
  assert.equal(await page.evaluate(() => window.__outlineLab.preset.shading.edges), false);
  await page.locator('#model-edges').check();
  // Path tracing: a few samples on the cube (software GL is slow), stop, then any rotation drops it.
  // «Трассировка» is the third mode: selecting it starts tracing, a click on the active segment stops it.
  await page.locator('#model-mode').click();
  assert.equal(await page.locator('#trace').count(), 0);
  await page.locator('#trace-mode').click();
  await page.waitForFunction(() => window.__outlineLab.mode === 'trace' && window.__outlineLab.trace?.samples >= 1, {}, { timeout: 180_000 });
  assert.equal(await page.locator('#trace-mode').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('#trace-mode').getAttribute('data-running'), 'true');
  await page.locator('#trace-mode').click();
  await page.waitForFunction(() => window.__outlineLab.trace && !window.__outlineLab.trace.running && window.__outlineLab.trace.phase === 'done', {}, { timeout: 120_000 });
  assert.equal(await page.evaluate(() => window.__outlineLab.trace.stopped), 'user');
  assert.match(await page.locator('#status').textContent(), /Трассировка готова/);
  // A finished result stays across a mode change; a running trace stops when the mode is left.
  await page.locator('#outline-mode').click();
  await page.locator('#trace-mode').click();
  assert.equal(await page.evaluate(() => window.__outlineLab.trace.phase), 'done');
  await page.locator('#rotate-45').click();
  await page.waitForFunction(() => window.__outlineLab.trace === null);
  await page.locator('#trace-mode').click();
  await page.waitForFunction(() => window.__outlineLab.trace?.running);
  await page.locator('#model-mode').click();
  await page.waitForFunction(() => window.__outlineLab.mode === 'model' && !window.__outlineLab.trace?.running, {}, { timeout: 120_000 });
  await page.locator('#rotate-45').click();
  await page.waitForFunction(() => window.__outlineLab.trace === null);
  await page.locator('#rotation').evaluate(input => { input.value = '20'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  for (const [id, key, value] of [['depth', 'depthThreshold', '0.004'], ['normal', 'normalThreshold', '0.45'], ['silhouette', 'silhouetteWidth', '2.5'], ['edge-width', 'edgeWidth', '0.75'], ['gap', 'haloGap', '0.5'], ['ink', 'lineColor', '#225533'], ['paper', 'background', '#f5f6f7']]) {
    await page.locator(`#${id}`).evaluate((input, value) => { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); }, value);
    assert.equal(await page.evaluate(key => window.__outlineLab.preset.outline[key], key), Number.isNaN(Number(value)) ? value : Number(value));
  }
  // Tessellation controls are gone; STEP tolerances are fixed constants.
  assert.equal(await page.locator('#linear, #angular, #reconvert').count(), 0);
  assert.match(await page.locator('#log').textContent(), /"linearDeflection":0.8,"angularDeflection":0.5/);
  // A legacy preset with tolerances imports without error; they are ignored and not exported back.
  const legacy = { version: 1, rotation: 90, mirrorX: false, outline: { depthThreshold: 0.003, normalThreshold: 0.4, lineWidth: 1.2, lineColor: '#112233', background: '#ffffff' },
    tessellation: { linearDeflection: 2, angularDeflection: 1 } };
  await page.locator('#preset-input').setInputFiles({ name: 'legacy.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(legacy)) });
  await page.waitForFunction(() => window.__outlineLab.preset.rotation === 90);
  await page.locator('#notice').filter({ hasText: 'Пресет импортирован' }).waitFor();
  const imported = await page.evaluate(() => window.__outlineLab.preset);
  assert.ok(!('tessellation' in imported));
  assert.equal(imported.outline.lineColor, '#112233');
  const presetEvent = page.waitForEvent('download');
  await page.locator('#save-preset').click();
  const exported = JSON.parse(await readFile(await (await presetEvent).path(), 'utf8'));
  // Old single `lineWidth` → inner edges; the silhouette is twice as heavy, the halo gets its default.
  const { lineWidth, ...legacyOutline } = legacy.outline;
  // Presets without `shading` get the studio defaults; export writes the block.
  // Presets before zoom get the fitted frame, before the export switch — the whole model, no background.
  assert.deepEqual(exported, { version: 1, rotation: 90, mirrorX: false, view: { zoom: 1, panX: 0, panY: 0 },
    outline: { ...legacyOutline, silhouetteWidth: lineWidth * 2, edgeWidth: lineWidth, haloGap: 1.5 },
    shading: { edges: true, occlusion: 1, occlusionRadius: 12 }, export: { frame: 'model', transparent: true } });
  // Drag and drop a local cube, without copying any CAD input into the repository.
  const data = await page.evaluateHandle(base64 => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([Uint8Array.from(atob(base64), char => char.charCodeAt(0))], 'dropped.stp'));
    return transfer;
  }, (await readFile(cube)).toString('base64'));
  await page.locator('#drop-zone').dispatchEvent('drop', { dataTransfer: data });
  await page.waitForFunction(() => window.__outlineLab.state === 'ready' && window.__outlineLab.metrics.fileName === 'dropped.stp');
  await page.locator('#preset-input').setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{"version":999}') });
  await page.locator('#notice').filter({ hasText: 'Неизвестная версия' }).waitFor();
  await page.locator('#step-input').setInputFiles({ name: 'bad.step', mimeType: 'application/octet-stream', buffer: Buffer.from('NOT A STEP') });
  await page.waitForFunction(() => window.__outlineLab.state === 'error');
  assert.match(await page.locator('#status').textContent(), /Не удалось/);
  // HiDPI: the buffer follows devicePixelRatio (here emulated 2).
  {
    const hidpi = await browser.newPage({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 2 });
    await hidpi.goto(process.env.SCHEME_URL ?? 'http://localhost:8080/3d-gen/');
    await hidpi.waitForFunction(() => window.__outlineLab?.state === 'empty' && window.__outlineLab.render.width > 1500);
    const r = await hidpi.evaluate(() => window.__outlineLab.render);
    assert.equal(r.width, Math.round(r.css * 2));
    await hidpi.close();
  }
  assert.deepEqual(errors, []);
  console.log('SMOKE OK: буфер холста = CSS × DPR (1 и 2), масштаб колёсиком к курсору без прокрутки страницы, сдвиг Shift и средней кнопкой, ползунок, «Вписать», двойной клик, отмена/повторный импорт, пиксели модели/контура, мышь, ползунки (силуэт, рёбра, зазор, затенение), трассировка и её сброс, цвета, старый пресет, экспорт пресета, drop, ошибки STEP/JSON');
} finally { await browser.close(); }
