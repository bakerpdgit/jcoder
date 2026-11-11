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
 * The stack deobfuscator is fetched from Maven at whatever TeaVM version the
 * checkout pins, so no second checkout is needed.
 *
 * The manifest records the teavm-javac commit and the TeaVM version it pinned,
 * because `public/teavm/` is committed: without that, a deployment is four
 * opaque binaries nobody can place.
 */
import { createHash } from 'node:crypto'
import { inflateRawSync } from 'node:zlib'
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

/**
 * The stack deobfuscator, taken from Maven at the version the checkout pins.
 *
 * Without it every frame of a student's stack trace comes back as
 * `java.lang.Throwable$FakeClass.fakeMethod(Throwable.java:10931)`, the number
 * being a wasm byte offset. It reads the debug info teavm-javac embeds in each
 * generated module, so it is what turns those into real class, method and line
 * names. It is a generic parser, not tied to one program.
 *
 * Matching the version matters: it reads a debug-info format that moves with
 * the compiler. Built from a TeaVM master checkout beside a released compiler
 * the two differ — measurably, the bytes are not the same.
 */
const DEOBFUSCATOR = { name: 'deobfuscator.wasm', minBytes: 10_000 }
const DEOBFUSCATOR_JAR = (version) => 'https://teavm.org/maven/repository/org/teavm'
  + `/teavm-wasm-gc-deobfuscator/${version}/teavm-wasm-gc-deobfuscator-${version}.jar`
/** Where the wasm sits inside that jar. */
const DEOBFUSCATOR_ENTRY = 'org/teavm/backend/wasm/deobfuscator.wasm'

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

/** Set when the deobfuscator came from a checkout rather than Maven. */
let teavmCheckout = null

/** Downloads the deobfuscator matching `version` into `public/teavm/`. */
async function stageDeobfuscator(version) {
  if (!version) {
    throw new Error('Could not read the TeaVM version from gradle/libs.versions.toml, '
      + 'so there is no way to tell which deobfuscator matches this build.')
  }
  // teavm-javac master tracks TeaVM master, and a SNAPSHOT is not on Maven —
  // so that case needs a teavm checkout, whose deobfuscator the build produces.
  if (version.endsWith('-SNAPSHOT')) {
    const given = process.argv[3] ?? process.env.JCODER_TEAVM_REPO
    if (!given) {
      throw new Error(`The checkout pins TeaVM ${version}, which is not on Maven. `
        + 'Pass a konsoletyper/teavm checkout as the second argument; its '
        + 'tools/deobfuscator-wasm-gc build output is used instead.')
    }
    const teavm = isAbsolute(given) ? given : resolve(process.cwd(), given)
    const staged = await stage(teavm, {
      ...DEOBFUSCATOR,
      from: 'tools/deobfuscator-wasm-gc/build/teavm/org/teavm/backend/wasm',
    })
    // A SNAPSHOT version string names nothing, so the commit is what makes the
    // bundle traceable. Recorded for the whole build, not just this file.
    teavmCheckout = describeCheckout(teavm)
    return { ...staged, from: 'teavm checkout' }
  }
  const url = DEOBFUSCATOR_JAR(version)
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} fetching ${url}`)
  }
  const bytes = extractFromJar(Buffer.from(await response.arrayBuffer()), DEOBFUSCATOR_ENTRY)
  if (bytes.length < DEOBFUSCATOR.minBytes) {
    throw new Error(`${DEOBFUSCATOR_ENTRY} is only ${bytes.length} bytes.`)
  }
  if (bytes.subarray(0, 4).toString('binary') !== String.fromCharCode(0) + 'asm') {
    throw new Error(`${DEOBFUSCATOR_ENTRY} is not a WebAssembly module.`)
  }
  await writeFile(join(OUT_DIR, DEOBFUSCATOR.name), bytes)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  console.log(`  ${DEOBFUSCATOR.name.padEnd(28)} ${human(bytes.length).padStart(8)}`
    + `  sha256:${sha256.slice(0, 12)}  (maven ${version})`)
  return { name: DEOBFUSCATOR.name, bytes: bytes.length, sha256, from: url }
}

/**
 * Pulls one entry out of a jar by walking its central directory.
 *
 * A jar is a zip; this is one file, so it is cheaper than taking on a zip
 * dependency for it.
 */
function extractFromJar(jar, entryName) {
  const end = jar.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  if (end < 0) throw new Error('Not a jar: no end-of-central-directory record.')
  let offset = jar.readUInt32LE(end + 16)
  const count = jar.readUInt16LE(end + 10)
  for (let i = 0; i < count; i++) {
    const nameLength = jar.readUInt16LE(offset + 28)
    const extraLength = jar.readUInt16LE(offset + 30)
    const commentLength = jar.readUInt16LE(offset + 32)
    const name = jar.subarray(offset + 46, offset + 46 + nameLength).toString('utf8')
    if (name === entryName) {
      const localOffset = jar.readUInt32LE(offset + 42)
      const method = jar.readUInt16LE(localOffset + 8)
      const start = localOffset + 30 + jar.readUInt16LE(localOffset + 26)
        + jar.readUInt16LE(localOffset + 28)
      const raw = jar.subarray(start, start + jar.readUInt32LE(offset + 20))
      return method === 0 ? Buffer.from(raw) : inflateRawSync(raw)
    }
    offset += 46 + nameLength + extraLength + commentLength
  }
  throw new Error(`${entryName} is not in the jar.`)
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
  files.push(await stageDeobfuscator(teavm))
  await writeFile(
    join(OUT_DIR, 'manifest.json'),
    JSON.stringify({
      source: 'built from source',
      repository: 'https://github.com/konsoletyper/teavm-javac',
      teavmJavac: source,
      teavmVersion: teavm,
      teavmCheckout,
      stagedAt: new Date().toISOString(),
      files,
    }, null, 2) + '\n',
  )

  if (teavm?.endsWith('-SNAPSHOT')) {
    console.log('')
    console.log(`Note: built against TeaVM ${teavm}, an unreleased snapshot.`)
    console.log('manifest.json records the commit it came from; see README.')
  }
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
