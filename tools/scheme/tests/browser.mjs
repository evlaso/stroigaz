import { chromium } from 'playwright-core';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const local = path => fileURLToPath(new URL(path, import.meta.url));
const url = process.env.SCHEME_URL ?? 'http://localhost:8080/3d-gen/';
// Only read the selected STEP. Never execute or write anything in its directory.
const step = process.env.SCHEME_STEP ?? local('../../../node_modules/occt-import-js/test/testfiles/simple-basic-cube/cube.stp');
const out = resolve(process.env.TEST_OUTPUT ?? local('../test-results/'));
const presetPath = local('../examples/dosing.preset.json');
await mkdir(out, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome-stable',
  headless: true,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--enable-precise-memory-info'],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 1, acceptDownloads: true });
const page = await context.newPage();
const errors = [], logs = [], requests = [], responses = [];
page.on('pageerror', error => errors.push(String(error)));
page.on('crash', () => errors.push('PAGE CRASH'));
page.on('console', message => logs.push(`${message.type()}: ${message.text()}`));
context.on('request', request => requests.push({ url: request.url(), method: request.method() }));
context.on('response', response => responses.push({ url: response.url(), status: response.status(), type: response.headers()['content-type'] }));

async function rendered(action) {
  const previous = await page.getAttribute('body', 'data-rendered');
  await action();
  await page.waitForFunction(before => document.body.dataset.rendered !== before, previous);
}

/** RGBA of the PNG corner (straight alpha), the most opaque pixel and how many pixels are fully opaque. */
function pngAlpha(path) {
  return readFile(path).then(png => page.evaluate(async base64 => {
    const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(base64), c => c.charCodeAt(0))], { type: 'image/png' }), { premultiplyAlpha: 'none' });
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d'); ctx.drawImage(bitmap, 0, 0);
    const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
    let max = 0, opaque = 0;
    for (let i = 3; i < data.length; i += 4) { max = Math.max(max, data[i]); if (data[i] === 255) opaque++; }
    return { corner: Array.from(data.slice(0, 4)), max, opaque };
  }, png.toString('base64')));
}

/** Differing RGBA bytes of two PNG files. */
async function pngDiff(a, b) {
  const [x, y] = await Promise.all([readFile(a), readFile(b)]);
  return page.evaluate(async ([a, b]) => {
    const data = async base64 => {
      const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(base64), c => c.charCodeAt(0))], { type: 'image/png' }));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d'); ctx.drawImage(bitmap, 0, 0);
      return ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
    };
    const [p, q] = await Promise.all([data(a), data(b)]);
    if (p.length !== q.length) return Infinity;
    let count = 0;
    for (let i = 0; i < p.length; i++) if (p[i] !== q[i]) count++;
    return count;
  }, [x.toString('base64'), y.toString('base64')]);
}

async function layout(width) {
  await page.setViewportSize({ width, height: 1100 });
  const sizes = await page.evaluate(() => {
    const rect = selector => {
      const { x, y, width, height, bottom } = document.querySelector(selector).getBoundingClientRect();
      return { x, y, width, height, bottom };
    };
    return { viewport: innerWidth, document: document.documentElement.scrollWidth, canvas: rect('#viewport'), stage: rect('.scheme-stage'), settings: rect('.scheme-settings'), zone: rect('#drop-zone'), switch: rect('.scheme-switch') };
  });
  assert.ok(sizes.document <= width, `Горизонтальная прокрутка: ${JSON.stringify(sizes)}`);
  assert.ok(sizes.settings.bottom <= sizes.stage.y, 'Настройки должны быть над холстом');
  assert.ok(Math.abs(sizes.canvas.width + 2 - sizes.settings.width) <= 2, 'Холст должен занимать всю ширину колонки');
  assert.ok(Math.abs(sizes.canvas.height / sizes.canvas.width - 500 / 760) < 0.01, 'Холст должен сохранять 760 × 500');
  assert.ok(sizes.switch.y + sizes.switch.height <= sizes.zone.y && Math.abs(sizes.switch.x + sizes.switch.width - (sizes.zone.x + sizes.zone.width)) <= 2, `Переключатель режима должен стоять над холстом, по правому краю: ${JSON.stringify(sizes)}`);
  return sizes;
}

let result;
try {
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__outlineLab?.state === 'empty');
  assert.equal(await page.locator('h1').textContent(), 'Генератор моделей');
  assert.match(await page.locator('meta[name="robots"]').getAttribute('content'), /noindex/);
  await page.locator('#preset-input').setInputFiles(presetPath);
  await page.waitForFunction(() => window.__outlineLab.preset.rotation === 350);
  const started = Date.now();
  await page.locator('#step-input').setInputFiles(step);
  await page.waitForFunction(() => ['ready', 'error'].includes(window.__outlineLab?.state), {}, { timeout: 9 * 60_000 });
  result = await page.evaluate(() => window.__outlineLab);
  result.wallMs = Date.now() - started;
  assert.equal(result.state, 'ready', await page.locator('#status-detail').textContent());
  assert.ok(result.metrics.triangles > 0, 'Пустая тесселяция — не успех');
  result.desktop = await layout(1440);
  await rendered(() => page.locator('#model-mode').click());
  await page.screenshot({ path: `${out}/scheme-model-1440.png`, fullPage: true });
  await page.locator('#viewport').screenshot({ path: `${out}/scheme-model-canvas.png` });
  {
    const downloadEvent = page.waitForEvent('download');
    await page.locator('[data-scale="2"]').click();
    const download = await downloadEvent;
    await download.saveAs(`${out}/scheme-model-2x.png`);
    const png = await readFile(`${out}/scheme-model-2x.png`);
    assert.equal(png.readUInt32BE(16), 1520);
    assert.match(download.suggestedFilename(), /\.model\.2x\.png$/);
    // «Прозрачный фон» on by default: the corner is empty, the model is opaque.
    const alpha = await pngAlpha(`${out}/scheme-model-2x.png`);
    assert.equal(alpha.corner[3], 0, `модель: угол PNG прозрачный ${JSON.stringify(alpha)}`);
    assert.equal(alpha.max, 255, 'модель: пиксель на модели непрозрачный');
    assert.ok(alpha.opaque > 1000, `модель: непрозрачная модель ${alpha.opaque}`);
  }
  // Path tracing: a few samples, stop, export the traced image (lazy chunk + BVH worker, same origin).
  await page.locator('#trace-mode').click();
  await page.waitForFunction(() => window.__outlineLab.trace?.samples >= 2, {}, { timeout: 5 * 60_000 });
  await page.locator('#trace-mode').click();
  await page.waitForFunction(() => window.__outlineLab.trace?.phase === 'done' && !window.__outlineLab.trace.running, {}, { timeout: 120_000 });
  result.trace = await page.evaluate(() => window.__outlineLab.trace);
  await page.locator('#viewport').screenshot({ path: `${out}/scheme-traced-canvas.png` });
  {
    const downloadEvent = page.waitForEvent('download');
    await page.locator('[data-scale="1"]').click();
    const download = await downloadEvent;
    await download.saveAs(`${out}/scheme-traced-1x.png`);
    const png = await readFile(`${out}/scheme-traced-1x.png`);
    assert.equal(png.readUInt32BE(16), 760);
    assert.match(download.suggestedFilename(), /\.traced\.1x\.png$/);
  }
  await rendered(() => page.locator('#outline-mode').click());
  await page.screenshot({ path: `${out}/scheme-outline-1440.png`, fullPage: true });
  await page.locator('#viewport').screenshot({ path: `${out}/scheme-outline-canvas.png` });
  for (const scale of [1, 2, 4]) {
    const downloadEvent = page.waitForEvent('download');
    await page.locator(`[data-scale="${scale}"]`).click();
    const download = await downloadEvent;
    const pngPath = `${out}/scheme-outline-${scale}x.png`;
    await download.saveAs(pngPath);
    const png = await readFile(pngPath);
    assert.equal(png.readUInt32BE(16), 760 * scale);
    assert.equal(png.readUInt32BE(20), 500 * scale);
    if (scale === 2) {
      const alpha = await pngAlpha(pngPath);
      assert.equal(alpha.corner[3], 0, `контур: угол PNG прозрачный ${JSON.stringify(alpha)}`);
      assert.equal(alpha.max, 255, 'контур: пиксель линии непрозрачный');
    }
  }
  // «Упрощение»: off by default; the slider writes outline.simplify, and back at 0 the outline
  // is the same PNG as before, byte for byte.
  {
    const setSimplify = value => rendered(() => page.locator('#simplify').evaluate((input, value) => { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); }, value));
    const export1x = async name => {
      const downloadEvent = page.waitForEvent('download');
      await page.locator('[data-scale="1"]').click();
      await (await downloadEvent).saveAs(`${out}/${name}`);
      return `${out}/${name}`;
    };
    assert.equal(await page.evaluate(() => window.__outlineLab.preset.outline.simplify), 0);
    assert.equal(await page.locator('#simplify-value').textContent(), 'нет');
    await setSimplify('1.5');
    assert.equal(await page.evaluate(() => window.__outlineLab.preset.outline.simplify), 1.5);
    assert.equal(await page.locator('#simplify-value').textContent(), '1.50 px');
    assert.equal((await readFile(await export1x('scheme-outline-simplify-1x.png'))).readUInt32BE(16), 760);
    await setSimplify('0');
    assert.equal(await pngDiff(`${out}/scheme-outline-1x.png`, await export1x('scheme-outline-simplify-off-1x.png')), 0, '«Упрощение» 0 — контур как без него');
    // «Внутри»: off by default. The cube has only the outer contour (every silhouette touches the
    // background around it), so even with «Внутри» the PNG is the same, byte for byte; back at 0 too.
    const setInner = value => rendered(() => page.locator('#inner-width').evaluate((input, value) => { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); }, value));
    assert.equal(await page.evaluate(() => window.__outlineLab.preset.outline.innerWidth), 0);
    assert.equal(await page.locator('#inner-width-value').textContent(), 'как силуэт');
    await setInner('0.75');
    assert.equal(await page.evaluate(() => window.__outlineLab.preset.outline.innerWidth), 0.75);
    assert.equal(await page.locator('#inner-width-value').textContent(), '0.75 px');
    assert.equal(await pngDiff(`${out}/scheme-outline-1x.png`, await export1x('scheme-outline-inner-1x.png')), 0, 'у куба только внешний контур');
    await setInner('0');
    assert.equal(await pngDiff(`${out}/scheme-outline-1x.png`, await export1x('scheme-outline-inner-off-1x.png')), 0, '«Внутри» 0 — контур как без него');
  }
  // Without «Прозрачный фон» the PNG has the «Фон» colour (white, opaque); the screen is the same either way.
  for (const mode of ['model', 'outline']) {
    await rendered(() => page.locator(`#${mode}-mode`).click());
    assert.equal(await page.locator('#transparent').isChecked(), true);
    await page.locator('#transparent').uncheck();
    const downloadEvent = page.waitForEvent('download');
    await page.locator('[data-scale="1"]').click();
    const download = await downloadEvent;
    const pngPath = `${out}/scheme-${mode}-opaque-1x.png`;
    await download.saveAs(pngPath);
    assert.match(download.suggestedFilename(), new RegExp(`\\.${mode}\\.1x\\.png$`));
    assert.deepEqual((await pngAlpha(pngPath)).corner, [255, 255, 255, 255], `${mode}: без прозрачности угол белый`);
    await page.locator('#transparent').check();
  }
  const presetEvent = page.waitForEvent('download');
  await page.locator('#save-preset').click();
  await (await presetEvent).saveAs(`${out}/exported.preset.json`);
  // The example predates «Упрощение» and «Внутри»: the export adds them, switched off.
  const example = JSON.parse(await readFile(presetPath, 'utf8'));
  assert.deepEqual(JSON.parse(await readFile(`${out}/exported.preset.json`, 'utf8')), { ...example, outline: { ...example.outline, simplify: 0, innerWidth: 0 } });
  await rendered(() => page.locator('#rotate-45').click());
  assert.equal(await page.evaluate(() => window.__outlineLab.preset.rotation), 35);
  await rendered(() => page.locator('#mirror').uncheck());
  assert.equal(await page.evaluate(() => window.__outlineLab.preset.mirrorX), false);
  await page.locator('#preset-input').setInputFiles(`${out}/exported.preset.json`);
  await page.waitForFunction(() => window.__outlineLab.preset.rotation === 350 && window.__outlineLab.preset.mirrorX);
  // Zoom: the canvas buffer is the on-screen size; the PNG is still 760 × 500 × N of the same frame.
  {
    const r = await page.evaluate(() => window.__outlineLab.render);
    assert.equal(r.width, Math.round(r.css * r.dpr));
    await page.locator('#viewport').scrollIntoViewIfNeeded();
    const box = await page.locator('#viewport').boundingBox();
    await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.6);
    await rendered(() => page.mouse.wheel(0, -500));
    const view = await page.evaluate(() => window.__outlineLab.preset.view);
    assert.ok(view.zoom > 1.5, JSON.stringify(view));
    await page.locator('#viewport').screenshot({ path: `${out}/scheme-outline-zoom-canvas.png` });
    const downloadEvent = page.waitForEvent('download');
    await page.locator('[data-scale="2"]').click();
    const download = await downloadEvent;
    await download.saveAs(`${out}/scheme-outline-zoom-2x.png`);
    assert.equal((await readFile(`${out}/scheme-outline-zoom-2x.png`)).readUInt32BE(16), 1520);
    const presetEvent = page.waitForEvent('download');
    await page.locator('#save-preset').click();
    await (await presetEvent).saveAs(`${out}/zoomed.preset.json`);
    assert.deepEqual(JSON.parse(await readFile(`${out}/zoomed.preset.json`, 'utf8')).view, view);
    await rendered(() => page.locator('#fit-view').click());
    assert.deepEqual(await page.evaluate(() => window.__outlineLab.preset.view), { zoom: 1, panX: 0, panY: 0 });
  }
  // Export frame: «Вся модель» at 3× zoom equals the unzoomed PNG pixel for pixel, «Как на экране»
  // differs; the screen keeps its 3× view, and tracing at 3× traces the whole model.
  {
    const save = async name => {
      const path = `${out}/${name}`;
      await rendered(async () => {
        const downloadEvent = page.waitForEvent('download');
        await page.locator('[data-scale="1"]').click();
        await (await downloadEvent).saveAs(path);
      });
      return (await readFile(path)).toString('base64');
    };
    // Differing RGBA bytes of two PNGs (or of a PNG and the canvas when `b` is null).
    const diff = (a, b) => page.evaluate(async ([a, b]) => {
      const image = async source => typeof source === 'string'
        ? createImageBitmap(new Blob([Uint8Array.from(atob(source), c => c.charCodeAt(0))], { type: 'image/png' }))
        : createImageBitmap(document.querySelector('#viewport'));
      const data = async source => {
        const bitmap = await image(source);
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const ctx = canvas.getContext('2d'); ctx.drawImage(bitmap, 0, 0);
        return ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
      };
      const [x, y] = await Promise.all([data(a), data(b)]);
      if (x.length !== y.length) return Infinity;
      let count = 0;
      for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) count++;
      return count;
    }, [a, b]);
    const setZoom = zoom => rendered(() => page.locator('#zoom').evaluate((input, zoom) => { input.value = String(Math.log2(zoom)); input.dispatchEvent(new Event('input', { bubbles: true })); }, zoom));
    assert.equal(await page.evaluate(() => window.__outlineLab.preset.export.frame), 'model');
    for (const mode of ['outline', 'model']) {
      await rendered(() => page.locator(`#${mode}-mode`).click());
      const fitted = await save(`frame-${mode}-fit.png`);
      await setZoom(3);
      const before = await page.evaluate(() => { const c = document.createElement('canvas'); const v = document.querySelector('#viewport'); c.width = v.width; c.height = v.height; c.getContext('2d').drawImage(v, 0, 0); return c.toDataURL('image/png').split(',')[1]; });
      const whole = await save(`frame-${mode}-zoom-model.png`);
      assert.equal(await diff(whole, fitted), 0, `${mode}: «Вся модель» при 3× совпадает с экспортом без зума`);
      assert.equal(await diff(before, null), 0, `${mode}: после экспорта на холсте прежний вид`);
      assert.equal(await page.evaluate(() => window.__outlineLab.preset.view.zoom), 3);
      await page.locator('#export-screen').click();
      assert.equal(await page.getAttribute('#export-screen', 'aria-pressed'), 'true');
      const zoomed = await save(`frame-${mode}-zoom-screen.png`);
      assert.ok(await diff(zoomed, fitted) > 1000, `${mode}: «Как на экране» при 3× отличается`);
      await page.locator('#export-model').click();
      await rendered(() => page.locator('#fit-view').click());
    }
    const presetEvent = page.waitForEvent('download');
    await page.locator('#save-preset').click();
    assert.deepEqual(JSON.parse(await readFile(await (await presetEvent).path(), 'utf8')).export, { frame: 'model', transparent: true });
    // Tracing at 3× with «Вся модель»: the fitted frame is traced (and shown), the view stays 3×.
    await setZoom(3);
    await page.locator('#trace-mode').click();
    await page.waitForFunction(() => window.__outlineLab.trace?.samples >= 1, {}, { timeout: 5 * 60_000 });
    assert.equal(await page.evaluate(() => window.__outlineLab.trace.framed), true);
    assert.match(await page.locator('#status-meta').textContent(), /вся модель/);
    await page.locator('#trace-mode').click();
    await page.waitForFunction(() => window.__outlineLab.trace?.phase === 'done', {}, { timeout: 120_000 });
    await page.locator('#viewport').screenshot({ path: `${out}/scheme-traced-whole-at-3x.png` });
    assert.equal(await page.evaluate(() => window.__outlineLab.preset.view.zoom), 3);
    await rendered(() => page.locator('#fit-view').click());
    assert.equal(await page.evaluate(() => window.__outlineLab.trace), null);
  }
  result.tablet = await layout(1099);
  result.mobile = await layout(390);
  await page.locator('#notice').waitFor({ state: 'hidden' });
  // Return to the top after Playwright has scrolled to the export controls.
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: `${out}/scheme-390.png`, fullPage: true });
  const origin = new URL(url).origin;
  assert.ok(requests.every(request => request.method === 'GET'), 'Не должно быть загрузки файла на сервер');
  assert.ok(requests.every(request => new URL(request.url).origin === origin), 'Не должно быть внешних запросов');
  const assets = responses.filter(response => /(?:worker-.*\.js|\.wasm)$/.test(response.url));
  assert.ok(assets.some(response => response.url.endsWith('.wasm')), 'WASM должен реально загрузиться');
  assert.ok(assets.some(response => /import\.worker-/.test(response.url)), 'Управляющий worker должен загрузиться');
  assert.ok(assets.some(response => /step\.worker-/.test(response.url)), 'Дочерний worker должен загрузиться');
  assert.ok(assets.some(response => /generateMeshBVH\.worker-/.test(response.url)), 'Worker BVH трассировки должен загрузиться');
  assert.ok(responses.some(response => /WebGLPathTracer-.*\.js$/.test(response.url) && response.status === 200), 'Модуль трассировки грузится отдельным чанком');
  // /3d-gen/ → /assets/scheme/, /stroigaz/3d-gen/ → /stroigaz/assets/scheme/.
  const prefix = new URL(url).pathname.replace(/[^/]+\/$/, 'assets/scheme/');
  assert.ok(assets.every(response => new URL(response.url).pathname.startsWith(prefix) && response.status === 200), 'Пути worker/WASM должны сохранять префикс');
  assert.ok(assets.filter(response => response.url.endsWith('.wasm')).every(response => response.type === 'application/wasm'));
  assert.deepEqual(errors, []);
  assert.deepEqual(responses.filter(response => response.status >= 400), []);
  const uniqueAssets = [...new Map(assets.map(asset => [asset.url, asset])).values()];
  console.log(JSON.stringify({ url, state: result.state, triangles: result.metrics.triangles,
    totalSeconds: result.metrics.totalMs / 1000, horizontalOverflow: result.mobile.document > 390,
    screenshots: out, assets: uniqueAssets }, null, 2));
} catch (error) {
  errors.push(String(error));
  await page.screenshot({ path: `${out}/error.png`, fullPage: true }).catch(() => {});
  throw error;
} finally {
  await writeFile(`${out}/console.log`, logs.join('\n'));
  await writeFile(`${out}/browser-check.json`, JSON.stringify({ url, step, browser: browser.version(), result, errors, requests, responses }, null, 2));
  await browser.close();
}
