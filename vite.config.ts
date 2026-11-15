import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
export default defineConfig(({ command }) => ({
  plugins: [react()],
  resolve: { alias: command === 'build' ? [{ find: /^\.\/lib\/demo$/, replacement: fileURLToPath(new URL('./src/lib/demo-disabled.ts', import.meta.url)) }] : [] },
  server: { proxy: { '/api': 'http://127.0.0.1:8787', '/sub': 'http://127.0.0.1:8787', '/telegram': 'http://127.0.0.1:8787' } },
  build: { manifest: true, rollupOptions: { output: { manualChunks(id) {
    if (id.includes('/node_modules/')) {
      if (/\/(react|react-dom|react-is|scheduler)\//.test(id)) return 'react';
    }
  } } } },
}));
