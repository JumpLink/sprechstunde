import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// `npm run web:dev` talks to a running `npm run admin`. The admin server accepts a loopback Host
// and a same-origin Origin, and the dev server's `localhost:5173` is both.
const ADMIN = 'http://127.0.0.1:8091';

export default defineConfig({
  plugins: [tailwindcss(), svelte()],
  resolve: { alias: { $lib: fileURLToPath(new URL('./src/lib', import.meta.url)) } },
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
    // The admin server sends a CSP without inline scripts; the polyfill would be one.
    modulePreload: { polyfill: false },
  },
  server: { proxy: { '/api': ADMIN, '/locale': ADMIN } },
});
