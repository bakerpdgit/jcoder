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
  END_OF_INPUT, END_OF_LINE, ERROR_HELPER_PATH, REQUEST_CHAR, SUPPORT_SOURCE_PATH,
  checkUnsupportedApis, chooseMainClass, planCompilation, toVfsPath,
  type SourceProblem,
} from '../utils/javaSupport'
import { COMMAND_CHAR } from '../utils/javaFileSystem'
import { describeError, type Toolchain } from './bootRuntime'
import { FileBridge, type FileChange, type FileSnapshot } from './fileBridge'
import type { TeaVMCompilerDiagnostic, TeaVMImports } from './teavmRuntime'

export interface RunRequest {
  sources: Array<{ path: string; text: string }>
  args: string[]
  mainClass: string | null
  /**
   * The editor's text files, as they stood when Run was pressed. The program
   * reads and writes these; see `FileBridge`.
   */
  files: FileSnapshot[]
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
  /** Files the program created, changed or deleted, reported once it ends. */
  onFilesChanged(changes: FileChange[], createdFolders: string[]): void
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

  /** What the stderr stream is currently carrying. */
  private stderrMode: 'output' | 'command' | 'payload' = 'output'
  private command = ''
  private payload = ''
  private payloadLength = 0
  private payloadPath = ''
  private payloadIsBinary = false

  constructor(
    private readonly readLine: () => string | null,
    /** Absent when the program has no filesystem, as in the UI-thread host. */
    private readonly files?: FileBridge,
  ) {}

  /**
   * Offers a character written to stderr. Returns true when the character
   * belonged to the bridge rather than to the program's output.
   *
   * Three things arrive on this stream: ordinary `System.err` text, the
   * one-character request for a line of input, and filesystem commands — a
   * command character, then a line, then for a write the text itself, whose
   * length the command line gave so that it can contain anything.
   */
  interceptStderr(charCode: number): boolean {
    if (this.stderrMode === 'command') {
      if (charCode === 10) this.finishCommand()
      else this.command += String.fromCharCode(charCode)
      return true
    }
    if (this.stderrMode === 'payload') {
      this.payload += String.fromCharCode(charCode)
      if (this.payload.length >= this.payloadLength) {
        this.stderrMode = 'output'
        const content = this.payload
        this.payload = ''
        this.stage(this.payloadIsBinary
          ? this.files?.writeBytes(this.payloadPath, content) ?? null
          : this.files?.write(this.payloadPath, content) ?? null)
      }
      return true
    }
    if (charCode === COMMAND_CHAR) {
      this.stderrMode = 'command'
      this.command = ''
      return true
    }
    if (charCode !== REQUEST_CHAR) return false
    // A line of console input: this blocks for as long as the user takes.
    this.stage(this.readLine())
    return true
  }

  private finishCommand(): void {
    this.stderrMode = 'output'
    const command = this.command
    this.command = ''
    if (!this.files) {
      this.stage(null)
      return
    }
    // The two writes are the commands whose content follows the line that
    // announces it — as text for `W`, as one character per byte for `Y`.
    if (command.startsWith('W ') || command.startsWith('Y ')) {
      this.payloadIsBinary = command.startsWith('Y ')
      const rest = command.slice(2)
      const space = rest.indexOf(' ')
      this.payloadLength = Number.parseInt(rest.slice(0, space), 10)
      this.payloadPath = rest.slice(space + 1)
      this.payload = ''
      if (Number.isFinite(this.payloadLength) && this.payloadLength > 0) {
        this.stderrMode = 'payload'
      } else {
        this.stage(this.payloadIsBinary
          ? this.files.writeBytes(this.payloadPath, '')
          : this.files.write(this.payloadPath, ''))
      }
      return
    }
    this.stage(this.files.execute(command))
  }

  /** Queues a reply for the program to collect through the clock. */
  private stage(reply: string | null): void {
    if (reply === null) {
      this.state = 'eof'
      return
    }
    this.pending = reply
    this.position = 0
    this.state = 'line'
  }

  /** The clock, standing in as the data channel while a reply is being read. */
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
/**
 * Replaces a compiler message that cannot be acted on with one that can.
 *
 * Both cases here are the same underlying problem: the class library javac
 * reads and the one TeaVM links against do not agree, so the error names an
 * internal detail the student has never heard of.
 */
function explainDiagnostic(message: string): string {
  // TeaVM declares these with a `0` suffix and renames them while compiling, so
  // javac offers a name TeaVM will not link and TeaVM offers one javac cannot
  // see. `getMessage` is handled by rewriting it (see javaSupport); the rest
  // can only be explained.
  if (/cannot find symbol/.test(message)
      && /\b(?:getMessage|getLocalizedMessage|getCause|getClass)\b/.test(message)) {
    return `${message}\n\n` +
      'This method is missing from the class library used here. For an exception, ' +
      'use e.toString() — it gives the type followed by the message — or write the ' +
      'exception straight into a string, as in ("Error: " + e).'
  }
  // The @JSByRef failure a java.nio.file call produces, if one slipped past the
  // pre-flight check in checkUnsupportedApis.
  if (/@JSByRef/.test(message)) {
    return 'This program uses a part of the class library that cannot run in the ' +
      'browser — usually java.nio.file (Files, Path, Paths). Your program cannot ' +
      'see the files in the editor; put its data in the Inputs tab instead.'
  }
  return message
}

function toDiagnostic(raw: TeaVMCompilerDiagnostic): CompilerDiagnostic {
  const isInjected = raw.fileName === SUPPORT_SOURCE_PATH || raw.fileName === ERROR_HELPER_PATH
  const line = raw.lineNumber > 0 ? raw.lineNumber : 1
  const column = raw.columnNumber && raw.columnNumber > 0 ? raw.columnNumber : 1
  return {
    id: raw.type === 'teavm' ? 'teavm' : 'javac',
    severity: mapSeverity(raw.severity),
    message: isInjected
      ? `[jcoder] internal error in a built-in helper (${raw.fileName}): ${raw.message}`
      : explainDiagnostic(raw.message),
    file: isInjected || !raw.fileName ? null : toVfsPath(raw.fileName),
    line: isInjected ? 1 : line,
    column: isInjected ? 1 : column,
    endLine: isInjected ? 1 : line,
    endColumn: isInjected ? 1 : column + 1,
  }
}

/** A pre-flight finding, pointed at the student's own line. */
function toPreflightDiagnostic(problem: SourceProblem): CompilerDiagnostic {
  return {
    id: 'jcoder',
    severity: problem.severity,
    message: problem.message,
    file: problem.path,
    line: problem.line,
    column: problem.column,
    endLine: problem.line,
    endColumn: problem.column + 1,
  }
}

function syntheticWarning(message: string): CompilerDiagnostic {
  return { ...syntheticError(message), severity: 'warning' }
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
 * The errors WebAssembly raises by itself, and the Java exception each one
 * stands for.
 *
 * TeaVM's WasmGC backend leaves these to the machine rather than emitting a
 * check and throwing a Java object, so they arrive as a `RuntimeError` whose
 * message is written for a compiler engineer: "dereferencing a null pointer"
 * rather than `NullPointerException`. A student sees a stopped program and a
 * sentence that does not look like Java at all.
 *
 * Naming the exception it corresponds to, and saying plainly that it cannot be
 * caught here, turns the most confusing symptom in the environment into
 * something a student can act on. The raw text is kept on the last line so the
 * message is still searchable and nothing is hidden.
 */
const MACHINE_ERRORS: Array<{
  pattern: RegExp
  exception: string
  meaning: string
  advice: string
}> = [
  {
    pattern: /array element access out of bounds|out of bounds (?:array|memory) access/i,
    exception: 'java.lang.ArrayIndexOutOfBoundsException',
    meaning: 'an array was used with an index it does not have',
    advice: 'Compare the index with the array\'s length in an if before using it.',
  },
  {
    pattern: /dereferencing a null pointer|null (?:pointer|reference) (?:dereference|access)/i,
    exception: 'java.lang.NullPointerException',
    meaning: 'a method or field was used on something that was null',
    advice: 'Check the value against null in an if before using it.',
  },
  {
    pattern: /divide by zero|division by zero|integer divide by zero/i,
    exception: 'java.lang.ArithmeticException: / by zero',
    meaning: 'a whole number was divided by zero',
    advice: 'Check the divisor is not zero first. Dividing decimals by zero gives '
      + 'Infinity instead, exactly as it does in Java.',
  },
  {
    pattern: /divide result unrepresentable/i,
    exception: 'java.lang.ArithmeticException',
    meaning: 'a division overflowed: Integer.MIN_VALUE / -1 has no int answer',
    advice: 'Use long for the division, or handle that case separately.',
  },
  {
    pattern: /requested new array is too large|array (?:is )?too large/i,
    exception: 'java.lang.NegativeArraySizeException',
    meaning: 'an array was created with a negative or impossibly large size',
    advice: 'Check the size is zero or more before creating the array.',
  },
  {
    pattern: /maximum call stack size exceeded|call stack exhausted|stack overflow/i,
    exception: 'java.lang.StackOverflowError',
    meaning: 'a method called itself too many times',
    advice: 'Check the recursion has a base case that stops it.',
  },
]

/**
 * Renders whatever ended a run as the closest thing to Java's own output.
 *
 * An exception the program actually threw already carries a good message and is
 * passed through; only the machine-level errors above are rewritten.
 */
export function explainRuntimeError(error: unknown): string {
  const raw = describeError(error)
  const machine = MACHINE_ERRORS.find(candidate => candidate.pattern.test(raw))
  if (!machine) return `Exception in thread "main" ${raw}`
  return [
    `Exception in thread "main" ${machine.exception}`,
    `    ${machine.meaning}`,
    '    This kind of error cannot be caught here — it stops the program even',
    `    inside a try/catch. ${machine.advice}`,
    `    (WebAssembly reported: ${raw})`,
  ].join('\n')
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

  // Checked against the student's own text before anything is compiled, so the
  // message lands on their line rather than arriving from inside TeaVM. The
  // warnings ride along with every later report, since they stay true.
  const preflight = checkUnsupportedApis(request.sources).map(toPreflightDiagnostic)

  const publish = (extra: CompilerDiagnostic[] = []) =>
    callbacks.onDiagnostics([...preflight, ...collected.map(toDiagnostic), ...extra])

  // Every way out of this function has to clear the phase as well as report the
  // exit code, or a compilation that fails leaves the status line reading
  // "compiling…" for ever.
  const finish = (code: number) => {
    callbacks.onStatus('idle')
    callbacks.onExit(code)
  }

  if (preflight.some(problem => problem.severity === 'error')) {
    publish()
    finish(1)
    return
  }

  // ── javac: .java → .class ────────────────────────────────────────────
  const { units, fileSupportBlockedBy } = planCompilation(request.sources)
  if (fileSupportBlockedBy.length > 0) {
    // Their class wins, but reading files is off, and a later "cannot find
    // symbol: Files" would be baffling on its own.
    preflight.push(syntheticWarning(
      `Reading and writing files is switched off for this program, because it `
      + `declares its own ${fileSupportBlockedBy.join(', ')}. `
      + `Rename ${fileSupportBlockedBy.length > 1 ? 'those classes' : 'that class'} `
      + 'if you need to open a file.',
    ))
  }
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
  const files = new FileBridge(request.files)
  await runGenerated(toolchain.load, wasm, request.args, callbacks, files)
  callbacks.onFilesChanged(files.changedFiles(), files.createdFolders())
}

async function runGenerated(
  load: Toolchain['load'],
  wasm: Int8Array,
  args: string[],
  callbacks: RunCallbacks,
  files: FileBridge,
): Promise<void> {
  const stdout = new ConsoleSink(callbacks.writeStdout)
  const stderr = new ConsoleSink(callbacks.writeStderr)

  const input = new InputBridge(() => {
    // The program is about to block, so anything it has printed — including a
    // prompt with no trailing newline — must be on screen first.
    stdout.flush()
    stderr.flush()
    return callbacks.readLine()
  }, files)

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
    callbacks.writeStderr(explainRuntimeError(error) + '\n')
    exitCode = 1
  } finally {
    stdout.flush()
    stderr.flush()
  }

  callbacks.onStatus('idle')
  callbacks.onExit(exitCode)
}
