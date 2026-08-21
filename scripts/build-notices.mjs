#!/usr/bin/env node
/**
 * Publishes the licence texts the About dialog links to.
 *
 * Both are *generated* into `public/` rather than committed, so they cannot
 * drift from their sources: one is this repository's own notices file, the
 * other ships inside the monaco-editor package. Runs from `predev` and
 * `prebuild`, so it is never a step anyone has to remember.
 */
import { copyFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PUBLIC = join(ROOT, 'public')

const MONACO_NOTICES = join(ROOT, 'node_modules', 'monaco-editor', 'ThirdPartyNotices.txt')

async function main() {
  // Markdown reads perfectly well as plain text, so it is served as-is rather
  // than run through a converter that would only add a dependency.
  const notices = await readFile(join(ROOT, 'THIRD-PARTY-NOTICES.md'), 'utf8')
  await writeFile(join(PUBLIC, 'third-party-notices.txt'), notices)

  if (existsSync(MONACO_NOTICES)) {
    await copyFile(MONACO_NOTICES, join(PUBLIC, 'monaco-third-party-notices.txt'))
  } else {
    // Not fatal: a missing node_modules should not stop a build that does not
    // need Monaco's notices to succeed, but the link would 404, so say so.
    console.warn('[notices] monaco-editor is not installed; skipping its notices')
  }
}

main().catch((error) => {
  console.error(`Could not publish the licence notices: ${error.message}`)
  process.exitCode = 1
})
