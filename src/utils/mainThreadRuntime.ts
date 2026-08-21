/**
 * Boots the Java toolchain on the UI thread instead of a worker.
 *
 * This is the ?runtime=main fallback. It exists for two reasons:
 *
 *  - Diagnosis. If the toolchain starts here but not in the worker, the worker
 *    is the problem; if it stalls in both, the problem is the bundle.
 *  - Availability. A page served without the COOP/COEP headers has no
 *    SharedArrayBuffer, so the worker buys nothing anyway.
 *
 * The trade-off is real and not hideable: reading input cannot block on the UI
 * thread, so it is answered from lines supplied before the run and then reports
 * end-of-input, and a student's infinite loop freezes the tab until it is
 * closed.
 */
import { bootJavaToolchain, type Toolchain } from '../workers/bootRuntime'
import type { RunnerEvent } from '../types'

export interface MainThreadHost {
  emit(event: RunnerEvent): void
}

/**
 * Booting is a page-level singleton: React 18 StrictMode invokes effects twice
 * in development, and the compiler is a 4MB download that must not happen
 * twice.
 */
let bootPromise: Promise<Toolchain> | null = null

export function bootOnMainThread(
  runtimeBaseUrl: string,
  host: MainThreadHost,
): Promise<Toolchain> {
  if (bootPromise) return bootPromise
  const verbose = isTracing()
  bootPromise = bootJavaToolchain(runtimeBaseUrl, {
    verbose,
    onStep: (name) => {
      if (verbose) console.log(`[jcoder] ${name}`)
      host.emit({ type: 'status', phase: 'loading-runtime', detail: name })
    },
  })
  return bootPromise
}

/** Test hook — drops the singleton so each test starts clean. */
export function _resetMainThreadRuntimeForTests(): void {
  bootPromise = null
}

/**
 * Where the runtime should run.
 *
 * The worker is strongly preferred: it is the only place a read can block, so
 * it is the only place a student can type input while a program is waiting. But
 * a broken worker must not mean a broken IDE, so `auto` tries the worker and
 * falls back to the UI thread if it does not come up.
 *
 * `?runtime=worker` and `?runtime=main` pin one host, with no fallback, which
 * is what you want when investigating which of them is at fault.
 */
export type RuntimePreference = 'auto' | 'worker' | 'main'

export function resolveRuntimePreference(): RuntimePreference {
  const requested = new URLSearchParams(location.search).get('runtime')
  return requested === 'worker' ? 'worker' : requested === 'main' ? 'main' : 'auto'
}

/** ?trace=1 on the page URL turns on verbose logging. */
export function isTracing(): boolean {
  return new URLSearchParams(location.search).get('trace') === '1'
}

/**
 * Lines waiting to be handed to the program.
 *
 * The UI thread cannot block, so interactive typing is impossible here.
 * Instead the input is supplied up front, from the Inputs tab, and consumed
 * line by line.
 */
let pendingInput: string[] = []

export function setPendingInput(lines: string[]): void {
  pendingInput = [...lines]
}

export function takePendingInput(): string | null {
  return pendingInput.length > 0 ? pendingInput.shift()! : null
}
