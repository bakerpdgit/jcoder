/**
 * Self-hosted Monaco.
 *
 * @monaco-editor/react loads Monaco from a CDN by default. A school network
 * often blocks CDNs, and a cross-origin-isolated page (which this one must be,
 * for SharedArrayBuffer) will not load cross-origin scripts without CORP
 * headers. So Monaco is bundled instead.
 *
 * Only the pieces that are actually needed are imported: the core editor plus
 * *tokenizer-only* language contributions. The heavyweight language services
 * (TypeScript, HTML, CSS) are deliberately not imported — they would each pull
 * in a web worker worth megabytes, and this is a Java editor.
 */
import * as monaco from 'monaco-editor/esm/vs/editor/edcore.main'
import { loader } from '@monaco-editor/react'

// Syntax highlighting only — no worker, no IntelliSense.
import 'monaco-editor/esm/vs/basic-languages/java/java.contribution'
import 'monaco-editor/esm/vs/basic-languages/kotlin/kotlin.contribution'
import 'monaco-editor/esm/vs/basic-languages/xml/xml.contribution'
import 'monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution'
import 'monaco-editor/esm/vs/basic-languages/sql/sql.contribution'
import 'monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution'
import 'monaco-editor/esm/vs/basic-languages/html/html.contribution'
import 'monaco-editor/esm/vs/basic-languages/css/css.contribution'
import 'monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution'
import 'monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution'

import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'

let configured = false

export function setupMonaco(): void {
  if (configured) return
  configured = true

  // Every registered language here is tokenizer-only, so one generic worker
  // (used by the editor for diffing and tokenization off the main thread) is
  // all that is required.
  ;(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
    getWorker: () => new EditorWorker(),
  }

  loader.config({ monaco })
}

export { monaco }
