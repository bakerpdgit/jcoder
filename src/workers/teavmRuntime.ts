/**
 * Typings for the two pieces of the TeaVM toolchain jcoder drives:
 *
 *   - `compiler.wasm-runtime.js`, TeaVM's Wasm GC loader. It loads the compiler
 *     *and* every program the compiler produces.
 *   - the `Compiler` object exported by `compiler.wasm` (javac + TeaVM,
 *     themselves compiled to WebAssembly by the teavm-javac project).
 *
 * These describe someone else's JavaScript, so they are hand-written rather
 * than generated, and deliberately narrow: only the members jcoder calls.
 */

// ── The Wasm GC loader ─────────────────────────────────────────────────────

/**
 * The import object handed to `installImports`, after TeaVM has filled in its
 * own namespaces (`teavmConsole`, `teavmJso`, `teavmDate`, `teavmMath`, …) and
 * before the module is instantiated. Overwriting an entry replaces TeaVM's
 * default implementation of it.
 */
export interface TeaVMImports {
  /**
   * Where `System.out` and `System.err` end up. TeaVM passes one UTF-16 code
   * unit at a time; the default implementation buffers a line and forwards it
   * to `console.log`. jcoder replaces both so output reaches the console panel.
   */
  teavmConsole?: {
    putcharStdout(charCode: number): void
    putcharStderr(charCode: number): void
  }
  /**
   * Where `System.currentTimeMillis()` and `java.util.Date` get the time.
   * jcoder wraps `currentTimeMillis` because it doubles as the channel that
   * carries a line of input back into the program — see `javaPipeline`.
   */
  teavmDate?: {
    currentTimeMillis(): number
    [fn: string]: unknown
  }
  [namespace: string]: unknown
}

export interface TeaVMLoadOptions {
  installImports?(imports: TeaVMImports): void
  noAutoImports?: boolean
  stackDeobfuscator?: {
    enabled?: boolean
    /** URL of the companion deobfuscator module, when it is a separate file. */
    path?: string
    externalInfoPath?: string
    infoLocation?: 'auto' | 'embedded' | 'external'
  }
}

export interface TeaVMInstance {
  /** Everything the Java side marked `@JSExport`, plus `main` for an entry point. */
  exports: Record<string, unknown> & { main?(args: string[]): void }
  instance: WebAssembly.Instance
  module: WebAssembly.Module
}

/**
 * `src` is a URL — which lets the browser stream-compile — or the module bytes.
 * It is deliberately not `BufferSource`: the compiler hands back an `Int8Array`
 * whose backing buffer TypeScript types as `ArrayBufferLike`, which
 * `BufferSource` no longer accepts since it excludes `SharedArrayBuffer`.
 */
export type TeaVMLoad = (
  src: string | ArrayBufferView | ArrayBuffer,
  options?: TeaVMLoadOptions,
) => Promise<TeaVMInstance>

/** The shape of `compiler.wasm-runtime.js` as an ES module. */
export interface TeaVMRuntimeModule {
  load: TeaVMLoad
}

// ── The compiler ───────────────────────────────────────────────────────────

export interface TeaVMCompilerDiagnostic {
  /** Which of the two compilers produced it. */
  type: 'javac' | 'teavm'
  severity: 'error' | 'warning' | 'other'
  fileName: string | null
  lineNumber: number
  message: string
  /** javac only. */
  columnNumber?: number
}

export interface JavaCompiler {
  addSourceFile(name: string, content: string): void
  clearSourceFiles(): void
  clearInputClassFiles(): void
  clearOutputFiles(): void

  setSdk(content: Int8Array): void
  setTeaVMClasslib(content: Int8Array): void

  /** javac: sources → `.class`. False when there were errors. */
  compile(): boolean
  /** Classes with a `public static void main(String[])`, fully qualified. */
  detectMainClasses(): string[]
  /** TeaVM: `.class` → `.wasm`. False when there were severe problems. */
  generateWebAssembly(options: { outputName: string; mainClass: string }): boolean

  listWebAssemblyOutputFiles(): string[]
  getWebAssemblyOutputFile(name: string): Int8Array | null

  onDiagnostic(listener: (diagnostic: TeaVMCompilerDiagnostic) => void): { destroy(): void }
}

export interface CompilerLibrary {
  createCompiler(): JavaCompiler
}

/**
 * Narrows the untyped `exports` bag of the loaded compiler module, failing
 * loudly rather than letting `undefined is not a function` surface later from
 * somewhere unrelated.
 */
export function resolveCompilerLibrary(exports: Record<string, unknown>): CompilerLibrary {
  const create = exports.createCompiler
  if (typeof create !== 'function') {
    throw new Error(
      'compiler.wasm loaded but does not export createCompiler(). ' +
      'The bundle in public/teavm/ is probably from an incompatible build — ' +
      're-run `npm run fetch:runtime`.',
    )
  }
  return exports as unknown as CompilerLibrary
}
