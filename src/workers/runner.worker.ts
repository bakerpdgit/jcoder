/// <reference lib="webworker" />
/**
 * Runs student code on a worker thread.
 *
 * The worker exists for one reason: reading a line of input has to *block*.
 * WebAssembly calls back into JavaScript synchronously, and that JavaScript
 * parks on `Atomics.wait` until the UI thread writes a line into the
 * SharedArrayBuffer. `Atomics.wait` is forbidden on the main thread, so the
 * runtime has to live here. That in turn requires the page to be cross-origin
 * isolated — see the COOP/COEP headers in vite.config.ts, server.mjs and
 * public/_headers.
 *
 * If the runtime cannot start here, ?runtime=main boots it on the UI thread
 * instead (see utils/mainThreadRuntime.ts): no typed input, but it isolates
 * whether the worker is the problem.
 */
import type { RunnerEvent, RunnerRequest } from '../types'
import { awaitLine, createStdinChannel, markWaiting, type StdinChannel } from '../utils/stdinChannel'
import { WORKER_STALL_WARNING_MS } from '../constants'
import { bootJavaToolchain, describeError, type Toolchain } from './bootRuntime'
import { compileAndRun } from './javaPipeline'

const ctx = self as unknown as DedicatedWorkerGlobalScope

let toolchain: Toolchain | null = null
let stdin: StdinChannel | null = null
let initPromise: Promise<void> | null = null
let running = false

function post(event: RunnerEvent): void {
  ctx.postMessage(event)
}

/**
 * Boot progress, mirrored to the browser console as well as the UI.
 *
 * Booting is a long chain of async steps — a 4MB WebAssembly compile and two
 * class libraries — and if one of them never settles the symptom is simply that
 * nothing happens. The step name makes a stall self-describing, and the
 * watchdog turns "it hangs" into "it stalled at X after N seconds".
 */
let currentStep = 'starting'
let stepStartedAt = 0
let watchdog: ReturnType<typeof setTimeout> | undefined
let verboseLogging = false

function step(name: string, detail = ''): void {
  if (watchdog !== undefined) clearTimeout(watchdog)
  currentStep = name
  stepStartedAt = Date.now()
  if (verboseLogging) console.log(`[jcoder] ${name}${detail ? ': ' + detail : ''}`)
  post({ type: 'status', phase: 'loading-runtime', detail: name })
  watchdog = setTimeout(() => {
    const seconds = Math.round((Date.now() - stepStartedAt) / 1000)
    const message =
      `The Java toolchain has been stuck at "${currentStep}" for ${seconds} seconds.\n` +
      'Add ?trace=1 for verbose logging, or ?runtime=main to load it on the UI\n' +
      'thread instead (no typed input there).\n'
    console.warn('[jcoder] ' + message)
    post({ type: 'stderr', text: message })
  }, WORKER_STALL_WARNING_MS)
}

function stepDone(): void {
  if (watchdog !== undefined) clearTimeout(watchdog)
  watchdog = undefined
}

// A rejected promise inside the loader would otherwise vanish silently and look
// exactly like a hang.
ctx.addEventListener('unhandledrejection', (event) => {
  post({
    type: 'fatal',
    message: `Unhandled error while at "${currentStep}": ${describeError((event as PromiseRejectionEvent).reason)}`,
  })
})

ctx.addEventListener('error', (event) => {
  post({ type: 'fatal', message: `Worker error while at "${currentStep}": ${(event as ErrorEvent).message}` })
})

// ── stdin bridge ───────────────────────────────────────────────────────────

/**
 * Called synchronously from inside WebAssembly. Blocks this thread until the UI
 * supplies a line or signals end-of-input, then returns the line (null at EOF).
 */
function readLineBlocking(): string | null {
  if (!stdin) return null
  markWaiting(stdin)
  post({ type: 'input-request', prompt: '' })
  return awaitLine(stdin)
}

// ── boot ───────────────────────────────────────────────────────────────────

async function initialise(
  runtimeBaseUrl: string,
  sab: SharedArrayBuffer | null,
  verbose: boolean,
): Promise<void> {
  if (sab) stdin = createStdinChannel(sab)

  toolchain = await bootJavaToolchain(runtimeBaseUrl, { verbose, onStep: step })

  stepDone()
  post({ type: 'status', phase: 'ready' })
  post({ type: 'ready' })
}

// ── compile + run ──────────────────────────────────────────────────────────

async function handleRun(request: Extract<RunnerRequest, { type: 'run' }>): Promise<void> {
  if (!toolchain) {
    post({ type: 'fatal', message: 'The Java toolchain is not ready yet.' })
    return
  }
  // Re-entrancy would interleave two programs' output on one console and share
  // one stdin queue between them.
  if (running) return
  running = true

  try {
    await compileAndRun(toolchain, request, {
      verbose: verboseLogging,
      onStatus: (phase, detail) => post({ type: 'status', phase, detail }),
      onDiagnostics: (diagnostics) => post({ type: 'diagnostics', diagnostics }),
      onMainClasses: (classes, selected) => post({ type: 'main-classes', classes, selected }),
      writeStdout: (text) => post({ type: 'stdout', text }),
      writeStderr: (text) => post({ type: 'stderr', text }),
      readLine: readLineBlocking,
      onExit: (code) => post({ type: 'exit', code }),
    })
  } catch (error) {
    post({ type: 'status', phase: 'idle' })
    post({ type: 'fatal', message: `The compiler failed unexpectedly: ${describeError(error)}` })
  } finally {
    running = false
  }
}

// ── message pump ───────────────────────────────────────────────────────────

ctx.onmessage = (event: MessageEvent<RunnerRequest>) => {
  const request = event.data
  switch (request.type) {
    case 'init':
      if (initPromise) return
      verboseLogging = request.verbose
      initPromise = initialise(request.runtimeBaseUrl, request.sab, request.verbose).catch((error: unknown) => {
        stepDone()
        console.error(`[jcoder] failed at "${currentStep}"`, error)
        post({ type: 'status', phase: 'error' })
        post({ type: 'fatal', message: `Failed at "${currentStep}": ${describeError(error)}` })
      })
      return
    case 'run':
      void handleRun(request)
      return
    case 'cancel':
      // Nothing to do: WebAssembly cannot be interrupted from outside. The UI
      // terminates and recreates this worker instead.
      return
  }
}
