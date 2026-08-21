#!/usr/bin/env node
/**
 * Downloads the TeaVM in-browser Java toolchain into `public/teavm/`.
 *
 * This is jcoder's equivalent of "build the runtime": the heavy lifting was
 * already done by the TeaVM project, which publishes javac + TeaVM compiled to
 * WebAssembly. We only vendor the files locally, which is not optional —
 * the page is cross-origin isolated (COOP/COEP), so it cannot pull these from
 * teavm.org at runtime. See README "Required headers".
 *
 * To build them yourself instead (JDK 21 + Gradle), see README
 * "Building the runtime from source".
 */
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(ROOT, 'public', 'teavm')

const BASE = process.env.JCODER_TEAVM_BASE ?? 'https://teavm.org/playground'

/**
 * The four files the runtime needs.
 *
 *  compiler.wasm              javac + TeaVM, themselves compiled to WebAssembly
 *  compiler.wasm-runtime.js   TeaVM's Wasm GC loader — used for the compiler
 *                             *and* for each program it generates
 *  compile-classlib-teavm.bin the class library javac resolves symbols against
 *  runtime-classlib-teavm.bin the class library TeaVM links generated code with
 */
const FILES = [
  { name: 'compiler.wasm', minBytes: 1_000_000 },
  { name: 'compiler.wasm-runtime.js', minBytes: 2_000 },
  { name: 'compile-classlib-teavm.bin', minBytes: 50_000 },
  { name: 'runtime-classlib-teavm.bin', minBytes: 500_000 },
]

function human(bytes) {
  return bytes >= 1_000_000
    ? `${(bytes / 1_000_000).toFixed(1)} MB`
    : `${Math.round(bytes / 1000)} kB`
}

async function download({ name, minBytes }) {
  const url = `${BASE}/${name}`
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} fetching ${url}`)
  }
  const bytes = Buffer.from(await response.arrayBuffer())

  // A proxy or captive portal that answers 200 with an HTML error page would
  // otherwise be discovered much later, as an unreadable WebAssembly module.
  if (bytes.length < minBytes) {
    throw new Error(
      `${name} is only ${bytes.length} bytes (expected at least ${minBytes}).\n` +
      'That usually means a proxy answered instead of the real server.',
    )
  }
  if (name.endsWith('.wasm') && bytes.subarray(0, 4).toString('binary') !== '\0asm') {
    throw new Error(`${name} is not a WebAssembly module — check ${BASE} in a browser.`)
  }

  await writeFile(join(OUT_DIR, name), bytes)
  const digest = createHash('sha256').update(bytes).digest('hex')
  console.log(`  ${name.padEnd(28)} ${human(bytes.length).padStart(8)}  sha256:${digest.slice(0, 12)}`)
  return { name, bytes: bytes.length, sha256: digest }
}

async function main() {
  console.log(`Fetching the TeaVM Java toolchain from ${BASE}`)
  await mkdir(OUT_DIR, { recursive: true })

  const results = []
  for (const file of FILES) results.push(await download(file))

  const total = results.reduce((sum, r) => sum + r.bytes, 0)

  // A manifest, so it is possible to tell which build of the toolchain a given
  // deployment is running without re-downloading it.
  await writeFile(
    join(OUT_DIR, 'manifest.json'),
    JSON.stringify({ source: BASE, fetchedAt: new Date().toISOString(), files: results }, null, 2) + '\n',
  )

  console.log(`\nDone — ${human(total)} in public/teavm/. Run \`npm run dev\`.`)
}

// A missing bundle is a normal state (it is not in git), so `npm run dev`
// still works; it is Run that reports the problem. Keep the message actionable.
main().catch((error) => {
  console.error(`\nCould not fetch the TeaVM runtime: ${error.message}`)
  if (existsSync(join(OUT_DIR, 'compiler.wasm'))) {
    console.error('An earlier copy is still in public/teavm/ and will keep working.')
  }
  process.exitCode = 1
})

