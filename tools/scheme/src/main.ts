import { Viewer } from './viewer.ts';
import { baseName, clampView, creaseAngle, defaults, degrees, exportFrame, IMPORT_TIMEOUT_MS, isStep, MAX_FILE_BYTES, meshFormat, panBy, parsePreset, TESSELLATION, TOO_LARGE, TRACE_LIMIT, ZOOM, zoomAt } from './settings.ts';
import type { TraceState } from './viewer.ts';
import type { ImportMetrics, MemoryPerformance, Preset, ViewStyle, WorkerMessage } from './types.ts';

// The interface is rendered by Eleventy in src/scheme.njk, using the site layout.
function el<T extends HTMLElement = HTMLElement>(id: string): T { return document.getElementById(id) as T; }
const input = (id: string) => el<HTMLInputElement>(id);
let viewer: Viewer;
try {
  viewer = new Viewer(el<HTMLCanvasElement>('viewport'));
} catch (error) {
  el('empty').textContent = 'Не удалось запустить WebGL 2. Включите аппаратное ускорение или попробуйте актуальный Chrome / Firefox.';
  el('status').textContent = 'WebGL недоступен';
  throw error;
}

let preset: Preset = structuredClone(defaults);
let file: File | undefined;
let worker: Worker | undefined;
let controller: AbortController | undefined;
let jobId = 0;
let started = 0;
let busy = false;
let timer: ReturnType<typeof setInterval> | undefined;
let watchdog: ReturnType<typeof setTimeout> | undefined;
let mainJsPeakBytes: number | null = null;
let lastMetrics: Record<string, unknown> = {};
let state = 'empty';
let renderRequested = false;

const mib = (n: number) => `${(n / 1024 ** 2).toFixed(1)} МиБ`;
const secs = (n: number) => `${(n / 1000).toLocaleString('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} с`;
const count = (n: number) => n.toLocaleString('ru-RU');
/** 1 деталь, 2 детали, 5 деталей. */
function plural(n: number, forms: [string, string, string]): string {
  const a = n % 100, b = n % 10;
  return `${count(n)} ${forms[a > 10 && a < 20 ? 2 : b === 1 ? 0 : b >= 2 && b <= 4 ? 1 : 2]}`;
}
/** One status line: bold phase, then caption details; `detail` is shown only for errors and before the first model. */
function setStatus(title: string, meta: string[] = [], detail = ''): void {
  el('status').textContent = title;
  el('status-meta').textContent = meta.filter(Boolean).map(part => ` · ${part}`).join('');
  el('status-detail').textContent = detail;
  el('status-detail').hidden = !detail;
}
let readyMeta: string[] = [];
/**
 * A translucent plate at the bottom of the canvas: the trace progress, or the part name after a
 * click. The full status lives in «Журнал и диагностика»; the plate keeps the model visible.
 */
let pickNote = false;
function stageNote(text = '', pick = false): void {
  el('stage-note').textContent = text;
  el('stage-note').hidden = !text;
  pickNote = pick && !!text;
}
function log(text: string): void {
  console.info(`[scheme] ${text}`);
  const lines = `${el('log').textContent}\n${new Date().toLocaleTimeString('ru-RU')} ${text}`.trim().split('\n');
  el('log').textContent = lines.slice(-200).join('\n');
}
function notice(text: string): void {
  el('notice').textContent = text;
  el('notice').hidden = false;
  setTimeout(() => { el('notice').hidden = true; }, 5000);
}
function setState(value: string): void { state = value; document.body.dataset.state = value; }
function syncControls(): void {
  input('rotation').value = String(preset.rotation);
  el('rotation-value').textContent = `${preset.rotation}°`;
  input('mirror').checked = preset.mirrorX;
  // Logarithmic slider: equal steps for 0.5→1 and 3→6.
  input('zoom').value = String(Math.log2(preset.view.zoom));
  el('zoom-value').textContent = `${preset.view.zoom.toFixed(2)}×`;
  const controls: [string, number, string][] = [
    ['depth', preset.outline.depthThreshold, preset.outline.depthThreshold.toFixed(4)],
    ['normal', preset.outline.normalThreshold, `${preset.outline.normalThreshold.toFixed(2)} · ${Math.round(creaseAngle(preset.outline.normalThreshold))}°`],
    ['silhouette', preset.outline.silhouetteWidth, `${preset.outline.silhouetteWidth.toFixed(2)} px`],
    ['edge-width', preset.outline.edgeWidth, `${preset.outline.edgeWidth.toFixed(2)} px`],
    ['gap', preset.outline.haloGap, preset.outline.haloGap ? `${preset.outline.haloGap.toFixed(2)} px` : 'нет'],
    ['occlusion', preset.shading.occlusion, preset.shading.occlusion ? preset.shading.occlusion.toFixed(2) : 'нет'],
    ['occlusion-radius', preset.shading.occlusionRadius, `${preset.shading.occlusionRadius} px`],
  ];
  for (const [id, value, label] of controls) { input(id).value = String(value); el(`${id}-value`).textContent = label; }
  input('ink').value = preset.outline.lineColor;
  input('paper').value = preset.outline.background;
  input('model-edges').checked = preset.shading.edges;
  input('transparent').checked = preset.export.transparent;
  el('export-model').setAttribute('aria-pressed', String(preset.export.frame === 'model'));
  el('export-screen').setAttribute('aria-pressed', String(preset.export.frame === 'screen'));
  document.querySelectorAll<HTMLInputElement>('.scheme-field input[type="range"]').forEach(rangeFill);
}
/** Filled part of a thin slider (WebKit has no ::-moz-range-progress). */
function rangeFill(range: HTMLInputElement): void {
  const min = Number(range.min), max = Number(range.max);
  range.style.setProperty('--scheme-fill', `${((Number(range.value) - min) / (max - min || 1)) * 100}%`);
}

let exporting = false;
function updateButtons(): void {
  document.querySelectorAll<HTMLButtonElement>('[data-scale]').forEach(b => { b.disabled = !viewer.ready || busy || exporting; });
  const trace = el<HTMLButtonElement>('trace-mode');
  const supported = viewer.traceSupported;
  trace.disabled = !supported || !viewer.ready || busy || exporting;
  trace.dataset.running = String(!!viewer.trace?.running);
  trace.title = !supported ? 'Трассировка недоступна: браузер не поддерживает WebGL 2 с float-текстурами.'
    : viewer.trace?.running ? 'Идёт трассировка. Клик — остановить, результат останется.'
    : 'Трассировка лучей: мягкие тени и отражения, до 300 сэмплов или 60 с. PNG сохраняет результат; для PNG крупнее трассировка повторяется в нужном размере.';
}

// ── Path tracing ────────────────────────────────────────────────────────────
const TRACE_SCALE = 2;
function traceStatus(state: TraceState): void {
  // Stopped by leaving the mode: the status belongs to the other mode now.
  if (viewer.mode !== 'trace') { updateButtons(); return; }
  const time = secs(state.ms);
  if (state.phase === 'loading') setStatus('Трассировка', ['загрузка модуля']);
  else if (state.phase === 'building') setStatus('Трассировка', ['подготовка сцены']);
  // While zoomed in, «Вся модель» traces (and shows) the fitted frame, not the zoomed one.
  else if (state.running) setStatus('Трассировка', [state.framed ? 'вся модель' : '', `${count(state.samples)} из ${plural(TRACE_LIMIT.samples, ['сэмпла', 'сэмплов', 'сэмплов'])}`, time]);
  else setStatus('Трассировка готова', [state.framed ? 'вся модель' : '', plural(state.samples, ['сэмпл', 'сэмпла', 'сэмплов']), time, state.stopped === 'time' ? 'остановлена по времени' : '']);
  stageNote(`${el('status').textContent}${el('status-meta').textContent}`);
  updateButtons();
}
async function runTrace(scale: number): Promise<TraceState | undefined> {
  traceInterrupted = false;
  if (viewer.mode !== 'trace') showMode('trace');
  const started = performance.now();
  try {
    const state = await viewer.startTrace(preset, scale, traceStatus, TRACE_LIMIT, exportFrame(preset));
    if (state.phase === 'done') {
      log(`Трассировка ${760 * scale}×${500 * scale}: ${state.samples} сэмплов за ${secs(state.ms)}, всего ${secs(performance.now() - started)}`);
      Object.assign(lastMetrics, { trace: { scale, samples: state.samples, ms: Math.round(state.ms), totalMs: Math.round(performance.now() - started), stopped: state.stopped } });
    }
    return state;
  } catch (error) {
    log(`Ошибка трассировки: ${String(error)}`);
    setStatus('Трассировка не удалась', ['подробности в журнале']);
    stageNote(); notice('Трассировка не удалась. Подробности — в «Журнал и диагностика».');
    render();
    return undefined;
  } finally { updateButtons(); }
}
/** Any change of view or shading returns to the raster view. */
function untrace(): void {
  if (!viewer.trace) return;
  const running = viewer.trace.running;
  viewer.dropTrace();
  traceInterrupted = false;
  stageNote();
  // In the trace mode the raster view is shown until the segment is clicked again.
  setStatus('Модель готова', viewer.mode === 'trace' ? [...readyMeta, 'трассировка сброшена — клик по «Трассировка» пересчитает'] : readyMeta);
  if (running) notice('Трассировка остановлена');
  updateButtons();
}

function render(): void {
  if (renderRequested) return;
  renderRequested = true;
  requestAnimationFrame(() => {
    renderRequested = false;
    try {
      viewer.render(preset);
      document.body.dataset.mode = viewer.mode;
      document.body.dataset.rendered = String(performance.now());
    } catch (error) {
      log(`Ошибка рендера: ${String(error)}`);
      setStatus('Не удалось отрисовать модель', [], 'Не хватает ресурсов WebGL. Попробуйте модель поменьше.');
      notice('Не удалось отрисовать модель. Подробности — в «Журнал и диагностика».');
      setState('error');
    }
  });
}

function stop(): void {
  worker?.terminate(); worker = undefined;
  controller?.abort(); controller = undefined;
  clearInterval(timer); clearTimeout(watchdog);
  timer = undefined; watchdog = undefined;
  busy = false;
  el('cancel').hidden = true;
  el('busy-overlay').hidden = true;
  el('progress').hidden = true;
  updateButtons();
}

function showMetrics(metrics: Partial<ImportMetrics>, totalMs: number, error?: string): void {
  const mesh = !!file && !isStep(file.name);
  lastMetrics = { ...metrics, mainJsPeakBytes, totalMs, error: error ?? null, fileName: file?.name, format: file ? meshFormat(file.name) ?? 'step' : null };
  readyMeta = [secs(totalMs), ...(metrics.parts ? [plural(metrics.triangles ?? 0, ['треугольник', 'треугольника', 'треугольников']),
    plural(metrics.parts, ['деталь', 'детали', 'деталей'])] : [])];
  const memory = [
    mesh ? `геометрия ${metrics.geometryBytes ? mib(metrics.geometryBytes) : 'нет данных'} (вершины, нормали, индексы)`
      : `пик WASM ${metrics.wasmPeakBytes ? mib(metrics.wasmPeakBytes) : 'нет данных'} (выделенная память, не RSS)`,
    `пик JS главного потока ${mainJsPeakBytes ? mib(mainJsPeakBytes) : 'недоступен'} (выборочно, performance.memory)`,
  ];
  log(`Память: ${memory.join('; ')}`);
  log(JSON.stringify(lastMetrics, null, 2));
}

async function openModel(nextFile: File): Promise<void> {
  const step = isStep(nextFile.name);
  if (!step && !meshFormat(nextFile.name)) { notice('Выберите файл STEP, STL, OBJ или GLB: .step, .stp, .stl, .obj, .glb, .gltf'); return; }
  if (viewer.mode === 'trace') showMode('model');
  if (nextFile.size > MAX_FILE_BYTES) {
    notice(`${TOO_LARGE}. Лимит входного файла — 384 МиБ.`);
    return;
  }
  const id = ++jobId;
  stop(); viewer.clear(); file = nextFile;
  controller = new AbortController();
  const signal = controller.signal;
  started = performance.now(); busy = true; mainJsPeakBytes = null;
  lastMetrics = {}; setState('loading');
  el('empty').hidden = true;
  el('busy-overlay').hidden = false;
  el('cancel').hidden = false;
  el('progress').hidden = false;
  el('progress').removeAttribute('value');
  el('busy-text').textContent = 'Подготовка';
  el('busy-time').textContent = '';
  stageNote();
  el('file-label').textContent = el('file-label').title = `${file.name} · ${mib(file.size)}`;
  readyMeta = [];
  setStatus('Подготовка');
  el('log').textContent = '';
  log(step ? `Открыт ${file.name}, ${file.size} байт; допуски ${JSON.stringify(TESSELLATION)}` : `Открыт ${file.name}, ${file.size} байт; сетка без тесселяции`);
  updateButtons(); render();
  const fail = (message: string, detail: string, metrics: Partial<ImportMetrics> = {}) => {
    if (id !== jobId) return;
    showMetrics(metrics, performance.now() - started, detail);
    stop(); viewer.clear(); setState('error'); render();
    el('empty').hidden = false;
    notice(`${message}. Подробности — в «Журнал и диагностика».`);
    const hint = message === TOO_LARGE ? 'Большим моделям нужно много памяти: откройте файл на компьютере или упростите модель.'
      : step ? 'Проверьте файл или разбейте сборку.' : 'Проверьте файл или упростите сетку при экспорте.';
    setStatus(message, [], `${detail} ${hint}`);
  };
  const tick = () => {
    if (busy) el('status-meta').textContent = el('busy-time').textContent = ` · ${secs(performance.now() - started)}`;
    const used = (performance as MemoryPerformance).memory?.usedJSHeapSize;
    if (used) mainJsPeakBytes = Math.max(mainJsPeakBytes ?? 0, used);
  };
  tick(); timer = setInterval(tick, 250);
  watchdog = setTimeout(() => fail(TOO_LARGE, 'Превышен безопасный лимит конвертации: 8 минут. Воркер остановлен.'), IMPORT_TIMEOUT_MS);
  try {
    // Literal URLs so Vite emits both workers; meshes never load OpenCascade / WASM.
    worker = step
      ? new Worker(new URL('./import.worker.ts', import.meta.url), { type: 'module' })
      : new Worker(new URL('./mesh.worker.ts', import.meta.url), { type: 'module' });
    worker.onerror = event => { event.preventDefault(); fail('Ошибка браузерной конвертации', event.message || 'Воркер аварийно завершился. Возможно, исчерпана память браузера.'); };
    worker.onmessageerror = () => fail('Ошибка браузерной конвертации', 'Не удалось передать меш из воркера. Возможно, недостаточно памяти.');
    worker.onmessage = async ({ data }: MessageEvent<WorkerMessage>) => {
      if (id !== jobId) return;
      if (data.type === 'log') { log(data.text); return; }
      if (data.type === 'status') {
        setStatus(data.text, [secs(performance.now() - started)]);
        el('busy-text').textContent = data.text;
        if (data.progress === undefined) el('progress').removeAttribute('value');
        else el<HTMLProgressElement>('progress').value = data.progress;
        document.body.dataset.phase = data.phase;
        return;
      }
      if (data.type === 'error') { fail(data.message, data.detail, data.metrics); return; }
      if (data.type === 'result') {
        // Free the entire OCCT heap / loader garbage before building the WebGL scene.
        worker?.terminate(); worker = undefined;
        document.body.dataset.phase = 'assembly';
        setStatus('Сборка сцены', [secs(performance.now() - started)]); el('busy-text').textContent = 'Сборка сцены';
        const assemblyStart = performance.now();
        try {
          await viewer.assemble(data.parts, data.root, fraction => { el<HTMLProgressElement>('progress').value = fraction; }, signal);
          if (id !== jobId || signal.aborted) return;
          viewer.fit(preset);
          const renderStart = performance.now();
          viewer.render(preset);
          tick();
          const totalMs = performance.now() - started;
          showMetrics(data.metrics, totalMs);
          Object.assign(lastMetrics, { assemblyMs: renderStart - assemblyStart, firstRenderMs: performance.now() - renderStart,
            namedParts: data.parts.filter(p => p.name).length, coloredParts: data.parts.filter(p => p.color).length,
            coloredFaces: data.parts.reduce((s, p) => s + p.faces.filter(f => f.color).length, 0) });
          log(`Сборка ${secs(renderStart - assemblyStart)}; первый рендер ${secs(performance.now() - renderStart)}`);
          stop(); setState('ready');
          setStatus('Модель готова', readyMeta);
          render();
        } catch (error) {
          if (id === jobId && !signal.aborted) fail('Не удалось собрать сцену', String(error), data.metrics);
        }
      }
    };
    worker.postMessage({ file, tessellation: { ...TESSELLATION } });
  } catch (error) { fail('Не удалось запустить Web Worker', String(error)); }
}

function rotate(value: number): void { untrace(); preset.rotation = degrees(value); syncControls(); viewer.fit(preset); render(); }
input('rotation').oninput = () => rotate(Number(input('rotation').value));
input('mirror').onchange = () => { untrace(); preset.mirrorX = input('mirror').checked; viewer.fit(preset); render(); };
el('rotate-45').onclick = () => rotate(preset.rotation + 45);
for (const [id, key] of [['depth', 'depthThreshold'], ['normal', 'normalThreshold'], ['silhouette', 'silhouetteWidth'], ['edge-width', 'edgeWidth'], ['gap', 'haloGap']] as const) {
  // The crease threshold also filters the edges over the model.
  input(id).oninput = () => { if (key === 'normalThreshold') untrace(); preset.outline[key] = Number(input(id).value); syncControls(); render(); };
}
for (const [id, key] of [['occlusion', 'occlusion'], ['occlusion-radius', 'occlusionRadius']] as const) {
  input(id).oninput = () => { untrace(); preset.shading[key] = Number(input(id).value); syncControls(); render(); };
}
input('model-edges').onchange = () => { untrace(); preset.shading.edges = input('model-edges').checked; render(); };
input('ink').oninput = () => { preset.outline.lineColor = input('ink').value; render(); };
input('paper').oninput = () => { preset.outline.background = input('paper').value; render(); };
// PNG only: the screen keeps the background colour, nothing to redraw.
input('transparent').onchange = () => { preset.export.transparent = input('transparent').checked; };
type Mode = typeof viewer.mode;
/** Tracing was stopped by leaving the mode: it starts over on return. */
let traceInterrupted = false;
function showMode(mode: Mode): void {
  viewer.mode = mode;
  for (const m of ['model', 'outline', 'trace'] as const) el(`${m}-mode`).setAttribute('aria-pressed', String(m === mode));
  if (mode !== 'trace') stageNote();
  render();
}
/**
 * «Трассировка» starts tracing; a click on the active segment stops it (or starts it again when
 * the result was dropped). Leaving the mode stops it; a finished result is shown again on return
 * until the view or the settings change.
 */
function setMode(mode: Mode): void {
  if (mode === 'trace') {
    if (!viewer.ready || busy || !viewer.traceSupported) return;
    if (viewer.mode === 'trace' && viewer.trace?.running) { viewer.stopTrace(); return; }
    if (!viewer.trace || traceInterrupted || viewer.trace.phase !== 'done') { void runTrace(TRACE_SCALE); return; }
    showMode('trace');
    traceStatus(viewer.trace);
    return;
  }
  if (viewer.mode === mode) { render(); return; }
  if (viewer.mode === 'trace') {
    if (viewer.trace?.running) { traceInterrupted = true; viewer.stopTrace(); }
    if (viewer.trace || traceInterrupted) setStatus('Модель готова', readyMeta);
  }
  showMode(mode);
}
for (const mode of ['model', 'outline', 'trace'] as const) el(`${mode}-mode`).onclick = () => setMode(mode);
document.querySelector('.scheme-settings')?.addEventListener('input', e => { if (e.target instanceof HTMLInputElement && e.target.type === 'range') rangeFill(e.target); });
for (const frame of ['model', 'screen'] as const) el(`export-${frame}`).onclick = () => {
  if (preset.export.frame === frame) return;
  // Zoomed or panned, the two choices are different frames: a traced image no longer matches the export.
  const { zoom, panX, panY } = preset.view;
  if (zoom !== 1 || panX !== 0 || panY !== 0) untrace();
  preset.export.frame = frame; syncControls();
};

el('cancel').onclick = () => {
  ++jobId; stop(); viewer.clear(); render(); setState('cancelled');
  el('empty').hidden = false;
  setStatus('Загрузка отменена');
};

for (const id of ['open-file', 'open-empty']) el(id).onclick = () => input('step-input').click();
input('step-input').onchange = () => {
  const selected = input('step-input').files?.[0];
  input('step-input').value = '';
  if (selected) void openModel(selected);
};
const zone = el('drop-zone');
document.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('scheme-drag-over'); });
document.addEventListener('dragleave', e => { if (!e.relatedTarget) zone.classList.remove('scheme-drag-over'); });
document.addEventListener('drop', e => {
  e.preventDefault(); zone.classList.remove('scheme-drag-over');
  const dropped = e.dataTransfer?.files[0]; if (dropped) void openModel(dropped);
});

// ── Zoom and pan ────────────────────────────────────────────────────────────
const canvas = el<HTMLCanvasElement>('viewport');
function setView(view: ViewStyle): void {
  const next = clampView(view);
  if (next.zoom === preset.view.zoom && next.panX === preset.view.panX && next.panY === preset.view.panY) return;
  untrace(); preset.view = next; syncControls(); viewer.fit(preset); render();
}
function fitView(): void { setView(structuredClone(defaults.view)); }
/** Pointer position in the frame relative to its centre, fractions of width / height. */
function framePoint(clientX: number, clientY: number): [number, number] {
  const rect = canvas.getBoundingClientRect();
  return [(clientX - rect.left) / rect.width - 0.5, (clientY - rect.top) / rect.height - 0.5];
}
input('zoom').min = String(Math.log2(ZOOM.min));
input('zoom').max = String(Math.log2(ZOOM.max));
input('zoom').oninput = () => {
  // Round to the 0.05 step of the scale itself, zoom about the frame centre.
  const zoom = Math.round(2 ** Number(input('zoom').value) / ZOOM.step) * ZOOM.step;
  setView(zoomAt(preset.view, zoom));
};
el('fit-view').onclick = fitView;
canvas.addEventListener('wheel', e => {
  // The page scrolls as usual until there is a model to zoom.
  if (!viewer.ready || busy) return;
  e.preventDefault();
  const pixels = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
  // Trackpad pinch arrives as ctrl + wheel with small deltas.
  const factor = Math.exp(-pixels * (e.ctrlKey ? 0.01 : 0.0015));
  setView(zoomAt(preset.view, preset.view.zoom * factor, ...framePoint(e.clientX, e.clientY)));
}, { passive: false });
canvas.addEventListener('dblclick', e => { if (viewer.ready && !busy) { e.preventDefault(); fitView(); } });
canvas.addEventListener('contextmenu', e => { if (viewer.ready) e.preventDefault(); });

// Mouse: drag — rotation about Z; Shift + drag, middle or right button — pan.
// Touch: one finger rotates, two fingers pinch-zoom and pan.
type Gesture =
  | { kind: 'rotate'; x: number; rotation: number; moved: boolean }
  | { kind: 'pan'; x: number; y: number; view: ViewStyle }
  | { kind: 'pinch'; distance: number; mid: [number, number]; view: ViewStyle };
let gesture: Gesture | undefined;
const pointers = new Map<number, { x: number; y: number }>();
function pinchState(): { distance: number; mid: [number, number] } {
  const [a, b] = [...pointers.values()];
  return { distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), mid: framePoint((a.x + b.x) / 2, (a.y + b.y) / 2) };
}
canvas.onpointerdown = e => {
  if (!viewer.ready || busy) return;
  const panButton = e.pointerType === 'mouse' && (e.button === 1 || e.button === 2 || (e.button === 0 && e.shiftKey));
  if (e.pointerType === 'mouse' && e.button !== 0 && !panButton) return;
  if (e.button === 1) e.preventDefault(); // no autoscroll
  if (pickNote) stageNote();
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  canvas.setPointerCapture(e.pointerId);
  if (pointers.size === 2) gesture = { kind: 'pinch', ...pinchState(), view: preset.view };
  else if (pointers.size === 1) gesture = panButton ? { kind: 'pan', x: e.clientX, y: e.clientY, view: preset.view } : { kind: 'rotate', x: e.clientX, rotation: preset.rotation, moved: false };
  canvas.classList.toggle('scheme-panning', gesture?.kind !== 'rotate');
};
canvas.onpointermove = e => {
  const pointer = pointers.get(e.pointerId);
  if (!pointer || !gesture) return;
  pointer.x = e.clientX; pointer.y = e.clientY;
  const rect = canvas.getBoundingClientRect();
  if (gesture.kind === 'rotate') {
    if (Math.abs(e.clientX - gesture.x) > 3) gesture.moved = true;
    if (gesture.moved) rotate(gesture.rotation + (e.clientX - gesture.x) * 0.5);
  } else if (gesture.kind === 'pan') {
    setView(panBy(gesture.view, (e.clientX - gesture.x) / rect.width, (e.clientY - gesture.y) / rect.height));
  } else if (pointers.size === 2) {
    // Zoom about the starting midpoint, then follow the midpoint.
    const now = pinchState(), start = gesture;
    const zoomed = zoomAt(start.view, start.view.zoom * now.distance / start.distance, ...start.mid);
    setView(panBy(zoomed, now.mid[0] - start.mid[0], now.mid[1] - start.mid[1]));
  }
};
const release = (e: PointerEvent) => {
  if (!pointers.delete(e.pointerId)) return;
  if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
  // A click without a drag names the part under the pointer.
  if (e.type === 'pointerup' && gesture?.kind === 'rotate' && !gesture.moved) {
    const name = viewer.pick(e.clientX, e.clientY);
    if (name && viewer.mode !== 'trace') stageNote(name, true);
  }
  // After a pinch the remaining finger does nothing until it is lifted.
  gesture = undefined;
  canvas.classList.remove('scheme-panning');
};
canvas.onpointerup = release;
canvas.onpointercancel = release;

// Render at the real size of the canvas on screen (CSS px × devicePixelRatio), not the 760 × 500
// frame stretched by CSS. Exports stay 760 × 500 × 1/2/4.
function measure(entry?: ResizeObserverEntry): void {
  // The exact device-pixel box when the browser reports it consistently (emulated DPR in
  // headless Chrome reports CSS px there), otherwise CSS width × devicePixelRatio.
  const estimate = canvas.getBoundingClientRect().width * devicePixelRatio;
  const box = entry?.devicePixelContentBoxSize?.[0]?.inlineSize;
  const width = box !== undefined && Math.abs(box - estimate) <= 2 ? box : estimate;
  if (width > 0 && viewer.setDisplay(width)) render();
}
const resize = new ResizeObserver(entries => measure(entries[0]));
try { resize.observe(canvas, { box: 'device-pixel-content-box' }); } catch { resize.observe(canvas); }
// Browsers without device-pixel-content-box (Safari) do not report a DPR change: listen for it.
(function watchRatio() {
  matchMedia(`(resolution: ${devicePixelRatio}dppx)`).addEventListener('change', () => { measure(); watchRatio(); }, { once: true });
})();
measure();

function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
el('save-preset').onclick = () => download(new Blob([JSON.stringify(preset, null, 2) + '\n'], { type: 'application/json' }), 'outline.preset.json');
el('load-preset').onclick = () => input('preset-input').click();
input('preset-input').onchange = async () => {
  const selected = input('preset-input').files?.[0]; input('preset-input').value = '';
  if (!selected) return;
  try {
    if (selected.size > 64 * 1024) throw new Error('Пресет больше 64 КиБ');
    preset = parsePreset(JSON.parse(await selected.text()));
    untrace(); syncControls(); viewer.fit(preset); render(); notice('Пресет импортирован.');
  } catch (error) { notice(`Не удалось импортировать пресет: ${String(error)}`); }
};
document.querySelectorAll<HTMLButtonElement>('[data-scale]').forEach(button => {
  button.onclick = async () => {
    if (!viewer.ready || busy) return;
    const scale = Number(button.dataset.scale);
    try {
      exporting = true; updateButtons();
      // A traced image is downscaled for a smaller PNG; a larger one is traced again at that size.
      // In the trace mode without a result (the view changed) the frame is traced first.
      if (viewer.mode === 'trace' && (!viewer.trace || viewer.trace.scale < scale)) {
        if (viewer.trace?.running) viewer.stopTrace();
        const state = await runTrace(Math.max(scale, TRACE_SCALE));
        if (!state || state.phase !== 'done') return;
      }
      const blob = await viewer.png(preset, scale, exportFrame(preset));
      const name = baseName(file?.name ?? 'model');
      download(blob, `${name}.${viewer.mode === 'trace' ? 'traced' : viewer.mode}.${scale}x.png`);
      render();
    } catch (error) { notice(`Ошибка экспорта: ${String(error)}`); }
    finally { exporting = false; updateButtons(); }
  };
});
canvas.addEventListener('webglcontextlost', e => {
  e.preventDefault(); ++jobId; stop(); setState('error'); stageNote();
  notice('Не хватает ресурсов WebGL. Перезагрузите страницу.');
  setStatus('Не хватает ресурсов WebGL', [], 'Графический контекст потерян. Перезагрузите страницу и попробуйте модель поменьше.');
});

// Read-only diagnostics for headless browser checks; no file/network access.
Object.defineProperty(window, '__outlineLab', { get: () => ({ state, metrics: lastMetrics, preset: structuredClone(preset), mode: viewer.mode,
  trace: viewer.trace ? { ...viewer.trace } : null,
  render: { width: canvas.width, height: canvas.height, calls: viewer.renderer.info.render.calls, display: { ...viewer.display },
    css: canvas.getBoundingClientRect().width, dpr: devicePixelRatio },
}) });
syncControls(); updateButtons(); render(); setState('empty');
