import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const local = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  root: local('./'),
  base: './',
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    outDir: local('../../src/assets/scheme/'),
    emptyOutDir: true,
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      input: local('./src/main.ts'),
      output: { entryFileNames: 'scheme.js' },
    },
  },
  plugins: [{
    name: 'dependency-licenses',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'THIRD_PARTY_LICENSES.txt', source: [
        readFileSync(local('./THIRD_PARTY_NOTICES.md'), 'utf8'),
        '--- three.js ---', readFileSync(local('../../node_modules/three/LICENSE'), 'utf8'),
        '--- occt-import-js ---', readFileSync(local('../../node_modules/occt-import-js/LICENSE.md'), 'utf8'),
        '--- three-gpu-pathtracer ---', readFileSync(local('../../node_modules/three-gpu-pathtracer/LICENSE'), 'utf8'),
        '--- three-mesh-bvh ---', readFileSync(local('../../node_modules/three-mesh-bvh/LICENSE'), 'utf8'),
      ].join('\n\n') });
    },
  }],
});
