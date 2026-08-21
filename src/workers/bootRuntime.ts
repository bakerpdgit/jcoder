/**
 * Boots the TeaVM Java toolchain and hands back something that can compile.
 *
 * Shared by both hosts so they cannot drift apart:
 *   - runner.worker.ts        — the default, where reading input can block
 *   - utils/mainThreadRuntime — the ?runtime=main fallback
 *
 * Everything host-specific (where output goes, how stdin blocks, how progress
 * is reported) arrives through callbacks or is applied later by the pipeline.
 */
import {
  resolveCompilerLibrary,
  type CompilerLibrary,
  type JavaCompiler,
  type TeaVMCompilerDiagnostic,
  type TeaVMLoad,
  type TeaVMRuntimeModule,
} from './teavmRuntime'

export interface BootCallbacks {
  /** Named boot step, for progress display and stall diagnosis. */
  onStep(name: string, detail?: string): void
  /** Turn on verbose logging. */
  verbose: boolean
}

/** One compilation's worth of compiler, plus the diagnostics it reported. */
export interface CompilerSession {
  compiler: JavaCompiler
  /** Filled by the listener registered in `createSession`. */
  diagnostics: TeaVMCompilerDiagnostic[]
}

/** Everything the compile-and-run pipeline needs. */
export interface Toolchain {
  /**
   * A compiler for exactly one run.
   *
   * A `Compiler` cannot be reused after `generateWebAssembly`: a later
   * `compile()` on the same instance overflows the stack, apparently because
   * the TeaVM pass leaves the instance holding a cached class source and a
   * great deal of retained state. Repeated `compile()` calls on their own are
   * fine — it is generating that spoils it — so the fix is simply to start
   * each run with a new one. That costs roughly 150ms, since the two class
   * libraries are already in memory and only have to be re-registered.
   */
  createSession(): CompilerSession
  /** TeaVM's loader, reused to instantiate each program the compiler emits. */
  load: TeaVMLoad
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function fetchBinary(url: string, label: string): Promise<Int8Array> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(
      `Could not load the ${label} (${response.status} ${response.statusText}) from ${url}.\n\n` +
      'The TeaVM runtime bundle has not been downloaded yet. From the repository root run:\n' +
      '    npm run fetch:runtime',
    )
  }
  return new Int8Array(await response.arrayBuffer())
}

function createSession(
  library: CompilerLibrary,
  sdk: Int8Array,
  classlib: Int8Array,
): CompilerSession {
  const compiler = library.createCompiler()
  compiler.setSdk(sdk)
  compiler.setTeaVMClasslib(classlib)

  const diagnostics: TeaVMCompilerDiagnostic[] = []
  compiler.onDiagnostic((diagnostic) => {
    // Copied field by field: the object is a live view onto Java memory and is
    // not valid once the call returns. (The registration the compiler hands
    // back cannot be used to unsubscribe — its `destroy` does not survive the
    // crossing into JavaScript — which is another reason each run gets its own
    // compiler rather than sharing one.)
    diagnostics.push({
      type: diagnostic.type,
      severity: diagnostic.severity,
      fileName: diagnostic.fileName,
      lineNumber: diagnostic.lineNumber,
      message: diagnostic.message,
      columnNumber: diagnostic.columnNumber,
    })
  })

  return { compiler, diagnostics }
}

export async function bootJavaToolchain(
  runtimeBaseUrl: string,
  callbacks: BootCallbacks,
): Promise<Toolchain> {
  const loaderUrl = `${runtimeBaseUrl}compiler.wasm-runtime.js`

  callbacks.onStep('import the TeaVM loader')
  let load: TeaVMLoad
  try {
    ;({ load } = (await import(/* @vite-ignore */ loaderUrl)) as TeaVMRuntimeModule)
  } catch (error) {
    throw new Error(
      `Could not load the TeaVM loader from ${loaderUrl}.\n\n` +
      'The TeaVM runtime bundle has not been downloaded yet. From the repository root run:\n' +
      '    npm run fetch:runtime\n\n' +
      `Underlying error: ${describeError(error)}`,
    )
  }

  // The compiler is fetched as a URL rather than a buffer so the browser can
  // stream-compile it — it is 4MB of WebAssembly and this is the slowest step.
  callbacks.onStep('load the Java compiler', 'compiler.wasm')
  const compilerModule = await load(`${runtimeBaseUrl}compiler.wasm`)
  const library = resolveCompilerLibrary(compilerModule.exports)

  // Two separate class libraries, and they are not interchangeable: javac
  // resolves symbols against one, TeaVM links generated code against the other.
  callbacks.onStep('load the class library', 'javac')
  const sdk = await fetchBinary(`${runtimeBaseUrl}compile-classlib-teavm.bin`, 'javac class library')

  callbacks.onStep('load the class library', 'TeaVM')
  const classlib = await fetchBinary(`${runtimeBaseUrl}runtime-classlib-teavm.bin`, 'TeaVM class library')

  // Prove the bundle actually works now, while the loading indicator is still
  // up, rather than letting a broken download surface as a failed first Run.
  callbacks.onStep('check the compiler')
  const probe = createSession(library, sdk, classlib)
  probe.compiler.addSourceFile('Probe.java', 'public class Probe { public static void main(String[] a) { } }')
  if (!probe.compiler.compile()) {
    throw new Error(
      'The Java compiler could not compile a trivial program, so the bundle in ' +
      'public/teavm/ is probably damaged. Re-run `npm run fetch:runtime`.\n' +
      probe.diagnostics.map(d => `  ${d.severity}: ${d.message}`).join('\n'),
    )
  }

  if (callbacks.verbose) console.log('[jcoder] toolchain ready')
  return { createSession: () => createSession(library, sdk, classlib), load }
}
