import initOcct from 'occt-import-js';
import wasmUrl from 'occt-import-js/dist/occt-import-js.wasm?url';
import { MAX_FILE_BYTES, TOO_LARGE } from './settings.ts';
import { featureEdges, triangleFaces } from './edges.ts';
import type { ImportMetrics, MemoryPerformance, Part, Tessellation, WorkerMessage } from './types.ts';

const send = (message: WorkerMessage, transfer: Transferable[] = []) => postMessage(message, { transfer });
const now = () => performance.now();

self.onmessage = async ({ data }: MessageEvent<{ file: File; tessellation: Tessellation }>) => {
  const { file, tessellation } = data;
  let occt: Awaited<ReturnType<typeof initOcct>> | undefined;
  let nativeError = '';
  const metrics: ImportMetrics = {
    fileBytes: file.size, readMs: 0, conversionMs: 0, packingMs: 0,
    wasmPeakBytes: 0, workerJsPeakBytes: null, geometryBytes: 0, triangles: 0, vertices: 0, parts: 0,
  };
  const memory = () => {
    metrics.wasmPeakBytes = Math.max(metrics.wasmPeakBytes, occt?.HEAPU8.byteLength ?? 0);
    const used = (performance as MemoryPerformance).memory?.usedJSHeapSize;
    if (used) metrics.workerJsPeakBytes = Math.max(metrics.workerJsPeakBytes ?? 0, used);
  };
  let conversionStarted = 0;
  try {
    if (file.size > MAX_FILE_BYTES) throw new Error(`${TOO_LARGE}: лимит входного файла 384 МиБ`);
    send({ type: 'status', phase: 'init', text: 'Загрузка OpenCascade / WebAssembly' });
    occt = await initOcct({
      locateFile: () => wasmUrl,
      print: text => send({ type: 'log', text }),
      printErr: text => { nativeError = text; send({ type: 'log', text }); },
      onAbort: reason => { nativeError = reason; memory(); },
    });
    send({ type: 'status', phase: 'reading', text: 'Чтение файла', progress: 0 });
    const readStart = now();
    const buffer = await new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.onprogress = e => send({ type: 'status', phase: 'reading', text: 'Чтение файла', progress: e.total ? e.loaded / e.total : 0 });
      reader.onerror = () => reject(new Error('Не удалось прочитать файл'));
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.readAsArrayBuffer(file);
    });
    metrics.readMs = now() - readStart;
    // ReadStepFile is one synchronous native call. No fabricated percentage.
    send({ type: 'status', phase: 'tessellating', text: 'Разбор STEP и тесселяция · OpenCascade', progress: undefined });
    conversionStarted = now();
    const result = occt.ReadStepFile(new Uint8Array(buffer), {
      linearUnit: 'millimeter', linearDeflectionType: 'absolute_value',
      linearDeflection: tessellation.linearDeflection, angularDeflection: tessellation.angularDeflection,
    });
    metrics.conversionMs = now() - conversionStarted;
    memory();
    if (!result.success || !result.meshes?.length) {
      throw new Error(nativeError || 'OpenCascade не нашёл твёрдых тел. Проверьте, что это корректный STEP-файл.');
    }
    const totalIndices = result.meshes.reduce((sum, mesh) => sum + mesh.index.array.length, 0);
    send({ type: 'log', text: `XCAF: ${result.meshes.length} мешей, ${totalIndices / 3} треугольников; WASM ${metrics.wasmPeakBytes} байт` });
    if (!totalIndices) {
      throw new Error(metrics.wasmPeakBytes >= 2_000_000_000
        ? `${TOO_LARGE}: OpenCascade исчерпал лимит WASM 2 ГиБ и вернул сборку без треугольников.`
        : 'OpenCascade вернул пустую тесселяцию: в STEP нет пригодных для отображения поверхностей.');
    }
    send({ type: 'status', phase: 'packing', text: 'Подготовка мешей и цветов XCAF', progress: 0 });
    const packingStart = now();
    const parts: Part[] = [];
    const transfer: Transferable[] = [];
    for (let i = 0; i < result.meshes.length; i++) {
      const mesh = result.meshes[i];
      const positions = new Float32Array(mesh.attributes.position.array);
      const normals = mesh.attributes.normal ? new Float32Array(mesh.attributes.normal.array) : undefined;
      const indices = new Uint32Array(mesh.index.array);
      metrics.geometryBytes += positions.byteLength + (normals?.byteLength ?? 0) + indices.byteLength;
      metrics.triangles += indices.length / 3;
      metrics.vertices += positions.length / 3;
      if (metrics.triangles > 5_000_000 || metrics.geometryBytes > 512 * 1024 ** 2) {
        throw new Error(`${TOO_LARGE}: меш превышает 5 млн треугольников или 512 МиБ. Используйте меньшую сборку.`);
      }
      // CAD edges: boundaries between BREP faces, never tessellation diagonals or periodic seams.
      const edges = featureEdges(positions, indices, triangleFaces(indices.length / 3, mesh.brep_faces));
      metrics.geometryBytes += edges.positions.byteLength + edges.angles.byteLength;
      parts.push({ name: mesh.name, positions, normals, indices, color: mesh.color, faces: mesh.brep_faces, edges: edges.positions, edgeAngles: edges.angles });
      transfer.push(positions.buffer, indices.buffer, edges.positions.buffer, edges.angles.buffer);
      if (normals) transfer.push(normals.buffer);
      // Drop the verbose JS number arrays as typed arrays are packed.
      mesh.attributes.position.array = [];
      if (mesh.attributes.normal) mesh.attributes.normal.array = [];
      mesh.index.array = [];
      if (i % 50 === 0) {
        memory();
        send({ type: 'status', phase: 'packing', text: 'Подготовка мешей и цветов XCAF', progress: i / result.meshes.length });
      }
    }
    metrics.parts = parts.length;
    metrics.packingMs = now() - packingStart;
    memory();
    send({ type: 'result', parts, root: result.root, metrics }, transfer);
  } catch (error) {
    memory();
    if (conversionStarted && !metrics.conversionMs) metrics.conversionMs = now() - conversionStarted;
    const detail = `${error instanceof Error ? error.message : String(error)}${nativeError ? ` · ${nativeError}` : ''}`;
    const oom = /memory|alloc|out of bounds|abort|too large|слишком большой|unreachable/i.test(detail);
    send({ type: 'error', message: oom ? TOO_LARGE : 'Не удалось конвертировать STEP', detail, metrics });
  }
};
