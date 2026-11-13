import { MAX_FILE_BYTES, TOO_LARGE } from './settings.ts';
import { indexStep, planFragments, stepFragment } from './step-partition.ts';
import type { AssemblyNode, ImportMetrics, Part, Tessellation, WorkerMessage } from './types.ts';

function convert(file: File, tessellation: Tessellation, fragment: string): Promise<Extract<WorkerMessage, { type: 'result' }>> {
  return new Promise((resolve, reject) => {
    const child = new Worker(new URL('./step.worker.ts', import.meta.url), { type: 'module' });
    child.onerror = e => { child.terminate(); reject(new Error(e.message || 'Воркер OpenCascade аварийно завершился')); };
    child.onmessage = ({ data }: MessageEvent<WorkerMessage>) => {
      if (data.type === 'result') { child.terminate(); resolve(data); }
      else if (data.type === 'error') { child.terminate(); reject(Object.assign(new Error(`${data.detail}${fragment}`), { metrics: data.metrics })); }
      else if (data.type === 'status') postMessage({ ...data, text: `${data.text}${fragment}` });
      else postMessage(data);
    };
    child.postMessage({ file, tessellation });
  });
}

self.onmessage = async ({ data }: MessageEvent<{ file: File; tessellation: Tessellation }>) => {
  const { file, tessellation } = data;
  const parts: Part[] = [];
  const root: AssemblyNode = { name: file.name, meshes: [], children: [] };
  const metrics: ImportMetrics = { fileBytes: file.size, readMs: 0, conversionMs: 0, packingMs: 0, wasmPeakBytes: 0,
    workerJsPeakBytes: null, geometryBytes: 0, triangles: 0, vertices: 0, parts: 0 };
  const start = performance.now();
  try {
    if (file.size > MAX_FILE_BYTES) throw new Error(`${TOO_LARGE}: больше 384 МиБ`);
    let files = [file];
    if (file.size > 16 * 1024 ** 2) {
      postMessage({ type: 'status', phase: 'partitioning', text: 'Индексация STEP · подготовка фрагментов без потери BREP' });
      const index = indexStep(await file.text());
      postMessage({ type: 'log', text: `STEP: ${index.records.length - 1} ID, ${index.representations.length} BREP-представлений, ${index.omit.length} служебных wireframe-представлений` });
      if (index.representations.length) {
        files = [];
        const batches = planFragments(index);
        for (let i = 0; i < batches.length; i++) {
          const chunk = stepFragment(index, batches[i]);
          const fragment = new File([chunk.text], `fragment-${i + 1}.step`);
          files.push(fragment);
          postMessage({ type: 'status', phase: 'partitioning', text: `Подготовка BREP-фрагментов · ${files.length}/${batches.length}`, progress: (i + 1) / batches.length });
          postMessage({ type: 'log', text: `${fragment.name}: ${fragment.size} байт, ${chunk.entities} сущностей` });
        }
      }
    }
    metrics.readMs = performance.now() - start;
    for (let i = 0; i < files.length; i++) {
      postMessage({ type: 'log', text: `Конвертация фрагмента ${i + 1}/${files.length}: ${files[i].size} байт` });
      const result = await convert(files[i], tessellation, files.length > 1 ? ` · фрагмент ${i + 1}/${files.length}` : '');
      const m = result.metrics;
      for (const key of ['conversionMs', 'packingMs', 'geometryBytes', 'triangles', 'vertices', 'parts'] as const) metrics[key] += m[key];
      metrics.wasmPeakBytes = Math.max(metrics.wasmPeakBytes, m.wasmPeakBytes);
      if (m.workerJsPeakBytes) metrics.workerJsPeakBytes = Math.max(metrics.workerJsPeakBytes ?? 0, m.workerJsPeakBytes);
      const offset = parts.length;
      const remap = (node: AssemblyNode) => {
        node.meshes = node.meshes.filter(n => result.parts[n].indices.length > 0).map(n => n + offset);
        node.children.forEach(remap);
      };
      remap(result.root);
      parts.push(...result.parts);
      root.children.push(result.root);
      if (metrics.triangles > 5_000_000 || metrics.geometryBytes > 512 * 1024 ** 2) throw new Error(`${TOO_LARGE}: итоговый меш превышает безопасный лимит`);
    }
    // Discard the empty placeholder meshes used to retain assembly placements.
    const mapping = new Map<number, number>();
    const visible = parts.filter((p, i) => { if (!p.indices.length) return false; mapping.set(i, mapping.size); return true; });
    const clean = (node: AssemblyNode): void => {
      node.meshes = node.meshes.map(n => mapping.get(n)!);
      node.children.forEach(clean);
      node.children = node.children.filter(n => n.meshes.length || n.children.length);
    };
    clean(root);
    metrics.parts = visible.length;
    const transfer: Transferable[] = [];
    for (const p of visible) {
      transfer.push(p.positions.buffer, p.indices.buffer);
      if (p.normals) transfer.push(p.normals.buffer);
      if (p.edges && p.edgeAngles) transfer.push(p.edges.buffer, p.edgeAngles.buffer);
    }
    postMessage({ type: 'result', parts: visible, root, metrics }, { transfer });
  } catch (error) {
    const extra = (error as { metrics?: Partial<ImportMetrics> }).metrics;
    if (extra) {
      metrics.conversionMs += extra.conversionMs ?? 0;
      metrics.wasmPeakBytes = Math.max(metrics.wasmPeakBytes, extra.wasmPeakBytes ?? 0);
    }
    const detail = error instanceof Error ? error.message : String(error);
    const oom = /memory|alloc|out of bounds|abort|слишком большой|unreachable|2 ГиБ/i.test(detail);
    postMessage({ type: 'error', message: oom ? TOO_LARGE : 'Не удалось конвертировать STEP', detail, metrics });
  }
};
