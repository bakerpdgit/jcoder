export type Theme = 'dark' | 'light'

// ── Languages ──────────────────────────────────────────────────────────────

export type LanguageId = 'java'

export interface LanguageDef {
  id: LanguageId
  /** Human label. */
  label: string
  /** Monaco Editor language id. */
  monacoId: string
  /** Source file extension, including the dot. */
  extension: string
  /** File created when a filesystem has no sources yet. */
  defaultFileName: string
  /** Starter source for `defaultFileName`. */
  template: string
  /** Extra extensions also fed to the compiler. */
  alsoCompile?: string[]
}

// ── Virtual File System ────────────────────────────────────────────────────

export interface VFSFilesystem {
  id: string
  name: string
  createdAt: number
}

export interface VFSEntry {
  id: string
  fsId: string
  parentPath: string
  path: string
  name: string
  type: 'file' | 'folder'
  content?: ArrayBuffer
  mimeType?: string
  size?: number
  modifiedAt: number
}

export interface VFSFile {
  path: string
  content: ArrayBuffer
  mimeType: string
}

/** A filesystem mutation to mirror onto a connected local OS folder. */
export type LocalFolderSyncOp =
  | { kind: 'write'; path: string; content: ArrayBuffer }
  | { kind: 'mkdir'; path: string }
  | { kind: 'delete'; path: string }
  | { kind: 'rename'; path: string; newName: string }

// ── Compiler diagnostics ───────────────────────────────────────────────────

export type DiagnosticSeverity = 'error' | 'warning' | 'info'

export interface CompilerDiagnostic {
  id: string
  severity: DiagnosticSeverity
  message: string
  /** VFS path of the source file, or null for whole-compilation diagnostics. */
  file: string | null
  /** 1-based. */
  line: number
  column: number
  endLine: number
  endColumn: number
}

// ── Runner worker protocol ─────────────────────────────────────────────────

/** Sent from the UI to the runner worker. */
export type RunnerRequest =
  | {
      type: 'init'
      /** Absolute URL of the folder holding compiler.wasm (…/teavm/). */
      runtimeBaseUrl: string
      /** SharedArrayBuffer used for the blocking stdin bridge; null disables input. */
      sab: SharedArrayBuffer | null
      /**
       * Turn on verbose logging.
       *
       * Passed in rather than read from the URL inside the worker: a worker's
       * `location` is its own script URL, so the page's ?trace=1 is not visible
       * there.
       */
      verbose: boolean
    }
  | {
      type: 'run'
      sources: Array<{ path: string; text: string }>
      /**
       * The editor's files, as they stood when Run was pressed. The program
       * reads and writes these rather than a real disk.
       */
      files: Array<{ path: string; bytes: Uint8Array }>
      /** Passed to `main(String[] args)`. */
      args: string[]
      /**
       * Fully-qualified class whose `main` to invoke, or null to let the
       * compiler pick (see `chooseMainClass`).
       */
      mainClass: string | null
    }
  | { type: 'cancel' }

/** Sent from the runner worker back to the UI. */
export type RunnerEvent =
  | { type: 'status'; phase: RunnerPhase; detail?: string }
  | { type: 'ready' }
  | { type: 'stdout'; text: string }
  | { type: 'stderr'; text: string }
  | { type: 'diagnostics'; diagnostics: CompilerDiagnostic[] }
  | { type: 'input-request'; prompt: string }
  /** Entry points javac found, so the UI can offer a picker. */
  | { type: 'main-classes'; classes: string[]; selected: string | null }
  /**
   * What the program did to the filesystem, sent once it has finished so the
   * editor can catch up. `text: null` means the program deleted the file.
   */
  | {
      type: 'files-changed'
      changes: Array<{ path: string; bytes: Uint8Array | null }>
      createdFolders: string[]
    }
  | { type: 'exit'; code: number }
  | { type: 'fatal'; message: string }

export type RunnerPhase =
  | 'loading-runtime'
  | 'loading-classlib'
  | 'ready'
  /** javac: .java → .class */
  | 'compiling'
  /** TeaVM: .class → .wasm */
  | 'generating'
  | 'running'
  | 'idle'
  | 'error'
