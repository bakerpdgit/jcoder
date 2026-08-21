// Minimal static server for the production build. Mirrors the Cross-Origin
// Isolation headers set in vite.config.ts and public/_headers so that
// SharedArrayBuffer (the blocking stdin bridge) works in `npm start` too.
import { createServer } from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve } from 'node:path'

const DIST = resolve(process.cwd(), 'dist')
const PORT = Number(process.env.PORT ?? 3000)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  // The licence notices the About dialog links to: served as text so the
  // browser shows them in the tab rather than downloading them.
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.bin': 'application/octet-stream',
  '.teadbg': 'application/octet-stream',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}

const ISOLATION = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
  'Origin-Agent-Cluster': '?1',
}

createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0])
  let filePath = join(DIST, normalize(urlPath).replace(/^(\.\.[/\\])+/, ''))
  if (!filePath.startsWith(DIST)) {
    res.writeHead(403).end('Forbidden')
    return
  }
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    // Only fall back to index.html for navigations. Serving the SPA shell in
    // place of a missing asset turns "the TeaVM bundle is not downloaded" into
    // a WebAssembly parse error somewhere far away, which is horrible to debug.
    if (extname(filePath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...ISOLATION })
      res.end(`Not found: ${urlPath}`)
      return
    }
    filePath = join(DIST, 'index.html')
  }
  const ext = extname(filePath).toLowerCase()
  const isHtml = ext === '.html'
  res.writeHead(200, {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    ...ISOLATION,
    ...(isHtml ? { 'Cache-Control': 'no-cache, no-store, must-revalidate' } : {}),
  })
  createReadStream(filePath).pipe(res)
}).listen(PORT, () => console.log(`jcoder serving dist/ on http://localhost:${PORT}`))
