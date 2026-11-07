#!/usr/bin/env node
/**
 * Copies a locally built TeaVM toolchain into `public/teavm/`.
 *
 * The sibling of `fetch-runtime.mjs`: that one downloads the build the TeaVM
 * project publishes, this one takes the build you made yourself. Both end with
 * the same four files and a `manifest.json` saying where they came from.
 *
 * Building rather than downloading is not a preference — the artifacts at
 * teavm.org/playground have not been republished since June 2025, so every fix
 * since then (strict mode, `@Rename`, the annotation handling javac needs) is
 * only reachable this way. See README, "Building the toolchain from source".
 *
 *   node scripts/stage-runtime.mjs ../teavm-javac
 *   JCODER_TEAVM_BUILD=../teavm-javac node scripts/stage-runtime.mjs
 *
 * The manifest records the teavm-javac commit and the TeaVM version it pinned,
 * because `public/teavm/` is committed: without that, a deployment is four
 * opaque binaries nobody can place.
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(ROOT, 'public', 'teavm')

/** Where `./gradlew :compiler:build` leaves each file, relative to the checkout. */
const FILES = [
  { name: 'compiler.wasm', from: 'compiler/build/generated/teavm/wasm-gc', minBytes: 1_000_000 },
  { name: 'compiler.wasm-runtime.js', from: 'compiler/build/generated/teavm/wasm-gc', minBytes: 2_000 },
  { name: 'compile-classlib-teavm.bin', from: 'compiler/build/classlib', minBytes: 50_000 },
  { name: 'runtime-classlib-teavm.bin', from: 'compiler/build/classlib', minBytes: 500_000 },
]

function human(bytes) {
  return bytes >= 1_000_000
    ? `${(bytes / 1_000_000).toFixed(1)} MB`
    : `${Math.round(bytes / 1000)} kB`
}

/** The commit staged, so a deployed bundle can be traced back to a source tree. */
function describeCheckout(checkout) {
  try {
    const git = (...args) =>
      execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8' }).trim()
    return {
      commit: git('rev-parse', 'HEAD'),
      committedAt: git('log', '-1', '--format=%cI'),
      subject: git('log', '-1', '--format=%s'),
      dirty: git('status', '--porcelain').length > 0,
    }
  } catch {
    // A tarball rather than a clone is unusual but not an error.
    return null
  }
}

/** The TeaVM release teavm-javac compiled against, which is what fixes land in. */
async function teavmVersion(checkout) {
  try {
    const catalogue = await readFile(join(checkout, 'gradle', 'libs.versions.toml'), 'utf8')
    return catalogue.match(/^\s*teavm\s*=\s*"([^"]+)"/m)?.[1] ?? null
  } catch {
    return null
  }
}

async function stage(checkout, file) {
  const source = join(checkout, file.from, file.name)
  if (!existsSync(source)) {
    throw new Error(
      `${file.name} is not at ${source}.\n` +
      'Run `./gradlew :compiler:build` in the checkout first — and if the build\n' +
      'moved its output, update FILES in this script.',
    )
  }
  const bytes = await readFile(source)

  // A truncated or half-written artifact fails much later, as an unreadable
  // WebAssembly module, so it is worth catching here.
  if (bytes.length < file.minBytes) {
    throw new Error(
      `${file.name} is only ${bytes.length} bytes (expected at least ${file.minBytes}).`,
    )
  }
  if (file.name.endsWith('.wasm') && bytes.subarray(0, 4).toString('binary') !== '\0asm') {
    throw new Error(`${file.name} is not a WebAssembly module.`)
  }

  await copyFile(source, join(OUT_DIR, file.name))
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  console.log(`  ${file.name.padEnd(28)} ${human(bytes.length).padStart(8)}  sha256:${sha256.slice(0, 12)}`)
  return { name: file.name, bytes: bytes.length, sha256 }
}

async function main() {
  const given = process.argv[2] ?? process.env.JCODER_TEAVM_BUILD
  if (!given) {
    console.error('Usage: node scripts/stage-runtime.mjs <path-to-teavm-javac-checkout>')
    process.exitCode = 1
    return
  }
  const checkout = isAbsolute(given) ? given : resolve(process.cwd(), given)
  if (!existsSync(checkout)) throw new Error(`No such directory: ${checkout}`)

  console.log(`Staging the TeaVM toolchain from ${checkout}`)
  await mkdir(OUT_DIR, { recursive: true })

  const files = []
  for (const file of FILES) files.push(await stage(checkout, file))

  const source = describeCheckout(checkout)
  const teavm = await teavmVersion(checkout)
  await writeFile(
    join(OUT_DIR, 'manifest.json'),
    JSON.stringify({
      source: 'built from source',
      repository: 'https://github.com/konsoletyper/teavm-javac',
      teavmJavac: source,
      teavmVersion: teavm,
      stagedAt: new Date().toISOString(),
      files,
    }, null, 2) + '\n',
  )

  if (source?.dirty) {
    console.log('\nNote: the checkout had uncommitted changes, so this build is not reproducible.')
  }
  const total = files.reduce((sum, file) => sum + file.bytes, 0)
  console.log(`\nDone — ${human(total)} in public/teavm/. Run \`npm run dev\`.`)
}

main().catch((error) => {
  console.error(`\nCould not stage the TeaVM runtime: ${error.message}`)
  process.exitCode = 1
})
