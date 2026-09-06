import { defineConfig } from 'vite';
import { crx } from '@crxjs/vite-plugin';
import { resolve } from 'path';
import { copyFileSync, mkdirSync, existsSync } from 'fs';
import manifest from './manifest.json';

// Plugin to copy ONNX Runtime WASM files into dist after build
function copyOnnxFiles() {
  return {
    name: 'copy-onnx-files',
    closeBundle() {
      const onnxDist = resolve(__dirname, 'node_modules/onnxruntime-web/dist');
      const outDir = resolve(__dirname, 'dist/onnx');
      if (!existsSync(outDir)) {
        mkdirSync(outDir, { recursive: true });
      }
      const files = [
        'ort-wasm-simd-threaded.jsep.mjs',
        'ort-wasm-simd-threaded.jsep.wasm',
        'ort-wasm-simd-threaded.mjs',
        'ort-wasm-simd-threaded.wasm',
      ];
      for (const file of files) {
        const src = resolve(onnxDist, file);
        const dest = resolve(outDir, file);
        if (existsSync(src)) {
          copyFileSync(src, dest);
          console.log(`[ONNX Copy] ${file} -> dist/onnx/`);
        }
      }
    },
  };
}

export default defineConfig({
  plugins: [
    crx({ manifest }),
    copyOnnxFiles(),
  ],
  resolve: {
    alias: {
      '@core': resolve(__dirname, 'src/core'),
      '@adapters': resolve(__dirname, 'src/adapters'),
      '@content': resolve(__dirname, 'src/content'),
      '@background': resolve(__dirname, 'src/background'),
      '@popup': resolve(__dirname, 'src/popup'),
      '@workers': resolve(__dirname, 'src/workers'),
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      input: {
        offscreen: resolve(__dirname, 'src/offscreen/offscreen.html'),
        options: resolve(__dirname, 'src/options/options.html'),
      },
    },
  },
  worker: {
    format: 'es',
  },
});
