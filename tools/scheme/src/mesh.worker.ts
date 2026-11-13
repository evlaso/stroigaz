import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { creasedNormals, featureEdges } from './edges.ts';
import { MAX_FILE_BYTES, MAX_MESH_BYTES, MAX_TRIANGLES, meshFormat, TOO_LARGE } from './settings.ts';
import type { AssemblyNode, ImportMetrics, MemoryPerformance, Part, WorkerMessage } from './types.ts';

// Mesh formats without OpenCascade. Everything ends up in the same Part[] /
// AssemblyNode structure as the STEP tessellation, in STEP axes (Z up, mm):
// - STL: as is. Kompas / CAD exporters write the same Z-up axes as STEP.
// - OBJ: as is. The format has no up axis; CAD exporters keep native Z-up.
// - glTF / GLB: the spec is Y-up, metres. Rotate +90° about X, (x, y, z) →
//   (x, −z, y), a proper rotation (no mirror), and scale ×1000 to millimetres.

const send = (message: WorkerMessage, transfer: Transferable[] = []) => postMessage(message, { transfer });
const now = () => performance.now();
const GLTF_TO_STEP = new THREE.Matrix4().makeRotationX(Math.PI / 2).scale(new THREE.Vector3(1000, 1000, 1000));

function sequence(count: number): Uint32Array {
  const indices = new Uint32Array(count);
  for (let i = 0; i < count; i++) indices[i] = i;
  return indices;
}

function linearColor(material: THREE.Material | undefined): number[] | undefined {
  const color = (material as THREE.MeshStandardMaterial | undefined)?.color;
  // three keeps Color in the linear working space, as the viewer expects for XCAF colors.
  return color instanceof THREE.Color ? [color.r, color.g, color.b] : undefined;
}

/** Bakes the world transform into a non-indexed geometry with STEP-compatible arrays. */
function toPart(mesh: THREE.Mesh, name: string, keepColors: boolean): Part | undefined {
  let geometry = mesh.geometry as THREE.BufferGeometry;
  if (!geometry.getAttribute('position')) return undefined;
  const authoredNormals = !!geometry.getAttribute('normal');
  geometry = geometry.index ? geometry.toNonIndexed() : geometry.clone();
  for (const key of Object.keys(geometry.attributes)) {
    const attribute = geometry.getAttribute(key) as THREE.BufferAttribute;
    if (key !== 'position' && key !== 'normal') geometry.deleteAttribute(key);
    // KHR_mesh_quantization: unpack integer attributes before baking the transform.
    else if (!(attribute.array instanceof Float32Array) || attribute.normalized) {
      const values = new Float32Array(attribute.count * 3);
      for (let i = 0; i < attribute.count; i++) values.set([attribute.getX(i), attribute.getY(i), attribute.getZ(i)], i * 3);
      geometry.setAttribute(key, new THREE.BufferAttribute(values, 3));
    }
  }
  geometry.applyMatrix4(mesh.matrixWorld);
  const positions = (geometry.getAttribute('position') as THREE.BufferAttribute).array as Float32Array;
  const triangles = Math.floor(positions.length / 9);
  if (!triangles) return undefined;
  // Authored normals (glTF / OBJ vn) carry the modeller's hard/soft edges; otherwise creased.
  const normalAttribute = geometry.getAttribute('normal') as THREE.BufferAttribute | undefined;
  const normals = authoredNormals && normalAttribute ? normalAttribute.array as Float32Array : creasedNormals(positions);
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const faces: Part['faces'] = [];
  if (keepColors && Array.isArray(mesh.material)) {
    for (const group of geometry.groups) {
      faces.push({ first: group.start / 3, last: (group.start + group.count) / 3 - 1, color: linearColor(materials[group.materialIndex ?? 0]) ?? null });
    }
  }
  const trimmed = positions.length === triangles * 9 ? positions : positions.slice(0, triangles * 9);
  const indices = sequence(triangles * 3);
  const edges = featureEdges(trimmed, indices);
  return {
    name, positions: trimmed,
    normals: normals.length === triangles * 9 ? normals : normals.slice(0, triangles * 9),
    indices,
    color: keepColors ? linearColor(materials[0]) : undefined,
    faces, edges: edges.positions, edgeAngles: edges.angles,
  };
}

async function parse(file: File, buffer: ArrayBuffer, format: NonNullable<ReturnType<typeof meshFormat>>): Promise<Part[]> {
  if (format === 'stl') {
    const geometry = new STLLoader().parse(buffer);
    const positions = (geometry.getAttribute('position') as THREE.BufferAttribute).array as Float32Array;
    // STL facet normals are often zero or stale. Recompute from the winding, in place:
    // smooth across facets of a curved surface, hard across real edges (edges.ts).
    const fileNormals = geometry.getAttribute('normal') as THREE.BufferAttribute | undefined;
    if (!positions.length) return [];
    const normals = creasedNormals(positions, fileNormals?.array instanceof Float32Array ? fileNormals.array as Float32Array : undefined);
    const indices = sequence(positions.length / 3);
    const edges = featureEdges(positions, indices);
    return [{ name: file.name, positions, normals, indices, faces: [], edges: edges.positions, edgeAngles: edges.angles }];
  }
  let root: THREE.Object3D;
  let keepColors = false;
  if (format === 'obj') {
    root = new OBJLoader().parse(new TextDecoder().decode(buffer));
  } else {
    const loader = new GLTFLoader();
    // Textures are not needed for an outline; skip image decoding (no DOM in a worker).
    loader.register(() => ({ name: 'scheme-no-textures', loadTexture: () => Promise.resolve(null) }) as never);
    try {
      root = (await loader.parseAsync(buffer, '')).scene;
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      throw new Error(/fetch|load|url|uri/i.test(text)
        ? `glTF ссылается на внешние файлы или сжатие (Draco, Meshopt), которые здесь не поддерживаются. Сохраните модель как .glb. ${text}`
        : text);
    }
    root.applyMatrix4(GLTF_TO_STEP);
    keepColors = true;
  }
  root.updateMatrixWorld(true);
  const parts: Part[] = [];
  let index = 0;
  root.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    index++;
    const label = object.name || object.parent?.name || `${file.name} · ${index}`;
    const part = toPart(object, label, keepColors);
    if (part) parts.push(part);
  });
  return parts;
}

self.onmessage = async ({ data }: MessageEvent<{ file: File }>) => {
  const { file } = data;
  const metrics: ImportMetrics = {
    fileBytes: file.size, readMs: 0, conversionMs: 0, packingMs: 0,
    wasmPeakBytes: 0, workerJsPeakBytes: null, geometryBytes: 0, triangles: 0, vertices: 0, parts: 0,
  };
  const memory = () => {
    const used = (performance as MemoryPerformance).memory?.usedJSHeapSize;
    if (used) metrics.workerJsPeakBytes = Math.max(metrics.workerJsPeakBytes ?? 0, used);
  };
  try {
    const format = meshFormat(file.name);
    if (!format) throw new Error('Неизвестный формат сетки');
    if (file.size > MAX_FILE_BYTES) throw new Error(`${TOO_LARGE}: лимит входного файла 384 МиБ`);
    send({ type: 'status', phase: 'reading', text: 'Чтение файла', progress: undefined });
    const readStart = now();
    const buffer = await file.arrayBuffer();
    metrics.readMs = now() - readStart;
    memory();
    const label = format === 'stl' ? 'STL' : format === 'obj' ? 'OBJ' : 'glTF';
    send({ type: 'status', phase: 'tessellating', text: `Разбор ${label} · three.js`, progress: undefined });
    const parseStart = now();
    const parts = await parse(file, buffer, format);
    metrics.conversionMs = now() - parseStart;
    memory();
    send({ type: 'status', phase: 'packing', text: 'Подготовка сетки', progress: undefined });
    const packingStart = now();
    const transfer: Transferable[] = [];
    for (const p of parts) {
      metrics.geometryBytes += p.positions.byteLength + (p.normals?.byteLength ?? 0) + p.indices.byteLength
        + (p.edges?.byteLength ?? 0) + (p.edgeAngles?.byteLength ?? 0);
      metrics.triangles += p.indices.length / 3;
      metrics.vertices += p.positions.length / 3;
      transfer.push(p.positions.buffer, p.indices.buffer);
      if (p.normals && p.normals.buffer !== p.positions.buffer) transfer.push(p.normals.buffer);
      if (p.edges && p.edgeAngles) transfer.push(p.edges.buffer, p.edgeAngles.buffer);
    }
    if (!metrics.triangles) throw new Error('В файле нет треугольников. Проверьте, что сетка не пустая.');
    if (metrics.triangles > MAX_TRIANGLES || metrics.geometryBytes > MAX_MESH_BYTES) {
      throw new Error(`${TOO_LARGE}: сетка превышает 5 млн треугольников или 512 МиБ. Упростите её в CAD перед экспортом.`);
    }
    metrics.parts = parts.length;
    metrics.packingMs = now() - packingStart;
    const root: AssemblyNode = { name: file.name, meshes: parts.map((_, i) => i), children: [] };
    send({ type: 'log', text: `${label}: ${parts.length} мешей, ${metrics.triangles} треугольников, ${metrics.geometryBytes} байт геометрии` });
    send({ type: 'result', parts, root, metrics }, [...new Set(transfer)]);
  } catch (error) {
    memory();
    const detail = error instanceof Error ? error.message : String(error);
    const oom = /memory|alloc|array buffer|invalid array length|слишком большой/i.test(detail);
    send({ type: 'error', message: oom ? TOO_LARGE : 'Не удалось прочитать сетку', detail, metrics });
  }
};
