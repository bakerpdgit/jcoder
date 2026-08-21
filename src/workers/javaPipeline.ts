/**
 * Compile-and-run, shared by the worker and the UI-thread fallback.
 *
 * Java takes two compilations to reach the browser, and both can fail with
 * diagnostics the student needs to see:
 *
 *   .java  --javac-->  .class  --TeaVM-->  .wasm  --load-->  running
 *
 * Everything host-specific arrives through `RunCallbacks`, so the worker can
 * block on `Atomics.wait` for input while the UI thread answers from a queue,
 * without either of them owning a second copy of this sequence.
 */
import type { CompilerDiagnostic, RunnerPhase } from '../types'
import { STDOUT_FLUSH_THRESHOLD } from '../constants'
import {
  END_OF_INPUT, END_OF_LINE, REQUEST_CHAR, SUPPORT_SOURCE_PATH,
  buildCompilationUnits, chooseMainClass, toVfsPath,
} from '../utils/javaSupport'
import { describeError, type Toolchain } from './bootRuntime'
import type { TeaVMCompilerDiagnostic, TeaVMImports } from './teavmRuntime'

export interface RunRequest {
  sources: Array<{ path: string; text: string }>
  args: string[]
  mainClass: string | null
}

export interface RunCallbacks {
  onStatus(phase: RunnerPhase, detail?: string): void
  onDiagnostics(diagnostics: CompilerDiagnostic[]): void
  onMainClasses(classes: string[], selected: string | null): void
  writeStdout(text: string): void
  writeStderr(text: string): void
  /**
   * One line of input, or null at end of input.
   *
   * Called synchronously from inside WebAssembly, so in the worker this blocks
   * the thread until the UI answers. Stdout has already been flushed, so a
   * prompt written with `System.out.print` is on screen before the caret is.
   */
  readLine(): string | null
  onExit(code: number): void
  verbose: boolean
}

/**
 * Buffers the program's console output.
 *
 * TeaVM hands over one UTF-16 code unit at a time, so forwarding each one
 * straight to the UI would post a message per character. Flush on newline, on a
 * full buffer, and whenever the program is about to block on input.
 */
export class ConsoleSink {
  private buffer = ''

  constructor(private readonly emit: (text: string) => void) {}

  putChar(charCode: number): void {
    this.buffer += String.fromCharCode(charCode)
    if (charCode === 10 || this.buffer.length >= STDOUT_FLUSH_THRESHOLD) this.flush()
  }

  flush(): void {
    if (this.buffer.length === 0) return
    const text = this.buffer
    this.buffer = ''
    this.emit(text)
  }
}

/**
 * The host half of the input bridge described in `utils/javaSupport`.
 *
 * The injected `Scanner` writes `REQUEST_CHAR` to `System.err` to ask for a
 * line, and then reads that line back one character at a time from the clock.
 * Between requests the clock is the real one, so `System.currentTimeMillis()`
 * in student code is unaffected.
 */
export class InputBridge {
  private state: 'idle' | 'line' | 'eof' = 'idle'
  private pending = ''
  private position = 0

  constructor(private readonly readLine: () => string | null) {}

  /**
   * Offers a character written to stderr. Returns true when it was the request
   * marker — which this call has now answered, having blocked for as long as
   * the user took to type — and the caller must not print it.
   */
  interceptStderr(charCode: number): boolean {
    if (charCode !== REQUEST_CHAR) return false
    const line = this.readLine()
    if (line === null) {
      this.state = 'eof'
    } else {
      this.pending = line
      this.position = 0
      this.state = 'line'
    }
    return true
  }

  /** The clock, standing in as the data channel while a line is being read. */
  currentTimeMillis(realClock: () => number): number {
    if (this.state === 'eof') {
      this.state = 'idle'
      return END_OF_INPUT
    }
    if (this.state === 'line') {
      if (this.position < this.pending.length) return this.pending.charCodeAt(this.position++)
      this.state = 'idle'
      return END_OF_LINE
    }
    return realClock()
  }
}

function mapSeverity(severity: string): CompilerDiagnostic['severity'] {
  if (severity === 'error') return 'error'
  if (severity === 'warning') return 'warning'
  return 'info'
}

/**
 * Turns a compiler diagnostic into the shape the editor and Problems tab use.
 *
 * A diagnostic against jcoder's own injected `Scanner.java` is not something a
 * student can act on or even open, so it is re-pointed at the whole
 * compilation and labelled — hiding it would turn a jcoder bug into a
 * compilation that fails for no visible reason.
 */
function toDiagnostic(raw: TeaVMCompilerDiagnostic): CompilerDiagnostic {
  const isInjected = raw.fileName === SUPPORT_SOURCE_PATH
  const line = raw.lineNumber > 0 ? raw.lineNumber : 1
  const column = raw.columnNumber && raw.columnNumber > 0 ? raw.columnNumber : 1
  return {
    id: raw.type === 'teavm' ? 'teavm' : 'javac',
    severity: mapSeverity(raw.severity),
    message: isInjected
      ? `[jcoder] internal error in the built-in Scanner: ${raw.message}`
      : raw.message,
    file: isInjected || !raw.fileName ? null : toVfsPath(raw.fileName),
    line: isInjected ? 1 : line,
    column: isInjected ? 1 : column,
    endLine: isInjected ? 1 : line,
    endColumn: isInjected ? 1 : column + 1,
  }
}

function syntheticError(message: string): CompilerDiagnostic {
  return {
    id: 'jcoder',
    severity: 'error',
    message,
    file: null,
    line: 1,
    column: 1,
    endLine: 1,
    endColumn: 1,
  }
}

/**
 * javac running inside WebAssembly reports its own failures as a stack
 * overflow, so the raw message is never the useful part. The cause we know of
 * is an annotation that takes arguments, which this build cannot compile.
 */
function javacCrashMessage(error: unknown): string {
  const detail = describeError(error)
  if (/call stack|stack size|stack overflow/i.test(detail)) {
    return 'The Java compiler ran out of stack while compiling this program.\n\n' +
      'The usual cause is an annotation that takes arguments: this build of javac ' +
      'only handles marker annotations such as @Override and @FunctionalInterface. ' +
      'Try removing any annotation with brackets after it, and any @interface ' +
      'declaration of your own.'
  }
  return `The Java compiler failed unexpectedly: ${detail}`
}

export async function compileAndRun(
  toolchain: Toolchain,
  request: RunRequest,
  callbacks: RunCallbacks,
): Promise<void> {
  // A compiler is good for one run only; see Toolchain.createSession.
  const { compiler, diagnostics: collected } = toolchain.createSession()

  const publish = (extra: CompilerDiagnostic[] = []) =>
    callbacks.onDiagnostics([...collected.map(toDiagnostic), ...extra])

  // Every way out of this function has to clear the phase as well as report the
  // exit code, or a compilation that fails leaves the status line reading
  // "compiling…" for ever.
  const finish = (code: number) => {
    callbacks.onStatus('idle')
    callbacks.onExit(code)
  }

  // ── javac: .java → .class ────────────────────────────────────────────
  const units = buildCompilationUnits(request.sources)
  for (const unit of units) compiler.addSourceFile(unit.path, unit.text)

  callbacks.onStatus('compiling')
  let compiled: boolean
  try {
    compiled = compiler.compile()
  } catch (error) {
    publish([syntheticError(javacCrashMessage(error))])
    finish(1)
    return
  }
  if (!compiled) {
    publish()
    finish(1)
    return
  }

  // ── Pick an entry point ─────────────────────────────────────────────
  const candidates = compiler.detectMainClasses()
  const mainClass = chooseMainClass(candidates, request.mainClass)
  callbacks.onMainClasses(candidates, mainClass)

  if (!mainClass) {
    publish([syntheticError(
      'No main method was found. A program needs a class containing:\n' +
      '    public static void main(String[] args)',
    )])
    finish(1)
    return
  }

  // ── TeaVM: .class → .wasm ───────────────────────────────────────────
  callbacks.onStatus('generating', mainClass)
  let generated: boolean
  try {
    generated = compiler.generateWebAssembly({ outputName: 'app', mainClass })
  } catch (error) {
    publish([syntheticError(`WebAssembly generation failed: ${describeError(error)}`)])
    finish(1)
    return
  }
  publish()
  if (!generated) {
    finish(1)
    return
  }

  const wasm = compiler.getWebAssemblyOutputFile('app.wasm')
  if (!wasm) {
    const produced = compiler.listWebAssemblyOutputFiles().join(', ') || '(none)'
    publish([syntheticError(
      `The compiler reported success but produced no app.wasm. It emitted: ${produced}`,
    )])
    finish(1)
    return
  }
  if (callbacks.verbose) {
    console.log('[jcoder] generated', compiler.listWebAssemblyOutputFiles().join(', '))
  }

  // ── Run ─────────────────────────────────────────────────────────────
  await runGenerated(toolchain.load, wasm, request.args, callbacks)
}

async function runGenerated(
  load: Toolchain['load'],
  wasm: Int8Array,
  args: string[],
  callbacks: RunCallbacks,
): Promise<void> {
  const stdout = new ConsoleSink(callbacks.writeStdout)
  const stderr = new ConsoleSink(callbacks.writeStderr)

  const input = new InputBridge(() => {
    // The program is about to block, so anything it has printed — including a
    // prompt with no trailing newline — must be on screen first.
    stdout.flush()
    stderr.flush()
    return callbacks.readLine()
  })

  let exitCode = 0
  try {
    const program = await load(wasm, {
      installImports(imports: TeaVMImports) {
        // Replaces TeaVM's defaults, which line-buffer into console.log.
        imports.teavmConsole = {
          putcharStdout: (code: number) => stdout.putChar(code),
          putcharStderr: (code: number) => {
            if (input.interceptStderr(code)) return
            stderr.putChar(code)
          },
        }
        const date = imports.teavmDate as { currentTimeMillis?(): number } | undefined
        const realClock = date?.currentTimeMillis?.bind(date) ?? (() => Date.now())
        imports.teavmDate = {
          ...(date ?? {}),
          currentTimeMillis: () => input.currentTimeMillis(realClock),
        }
      },
    })

    callbacks.onStatus('running')
    const main = program.exports.main
    if (typeof main !== 'function') {
      throw new Error('The generated module has no main entry point.')
    }
    main(args)
  } catch (error) {
    stdout.flush()
    stderr.flush()
    // TeaVM surfaces an uncaught Java exception as a JavaScript Error whose
    // message is the Java one. Frames are not included: the generated module is
    // obfuscated, so a stack would name fake methods rather than the student's.
    callbacks.writeStderr(`Exception in thread "main" ${describeError(error)}\n`)
    exitCode = 1
  } finally {
    stdout.flush()
    stderr.flush()
  }

  callbacks.onStatus('idle')
  callbacks.onExit(exitCode)
}
