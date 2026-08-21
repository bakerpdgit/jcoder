import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// SharedArrayBuffer (used for the blocking stdin bridge between the main thread
// and the TeaVM runner worker) requires Cross-Origin Isolation on every
// response. These must match `public/_headers` (Cloudflare Pages) and server.mjs.
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
  'Origin-Agent-Cluster': '?1',
}

const noCacheHtmlHeaders = {
  'Cache-Control': 'no-cache, no-store, must-revalidate',
  Pragma: 'no-cache',
  Expires: '0',
}

export default defineConfig({
  plugins: [react()],
  worker: {
    // The runner worker uses `import()` to load the TeaVM runtime loader, so it
    // must be an ES module worker (not the IIFE/importScripts style).
    format: 'es',
  },
  server: {
    port: 3000,
    headers: { ...isolationHeaders, ...noCacheHtmlHeaders },
  },
  preview: {
    port: 3000,
    headers: { ...isolationHeaders, ...noCacheHtmlHeaders },
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
  },
})
