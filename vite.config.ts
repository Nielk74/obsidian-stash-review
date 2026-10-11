import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: 'preview',
  server: {
    host: '127.0.0.1', port: 4173, strictPort: true,
    fs: { allow: [fileURLToPath(new URL('.', import.meta.url))] }
  },
  build: { outDir: '../dist-preview', emptyOutDir: true }
});
