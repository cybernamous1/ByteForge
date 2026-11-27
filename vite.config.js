import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    target: 'esnext',            // sql.js/Monaco/WebContainer builds rely on modern syntax
    chunkSizeWarningLimit: 6000  // Monaco is intentionally bundled locally (no CDN requests)
  },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@webcontainer/api'] },
  // WebContainers require cross-origin isolation in development as well
  server: {
    headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' }
  },
  preview: {
    headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' }
  }
});
