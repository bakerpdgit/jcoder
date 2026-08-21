/**
 * Owns the TeaVM runner worker as a *page-level* resource.
 *
 * Booting the toolchain costs a multi-megabyte download and several seconds, so
 * it must not be tied to a React component's lifetime. In particular, React 18
 * StrictMode deliberately mounts effects, unmounts them and mounts them again
 * in development: a component-owned worker is therefore created, killed
 * mid-download and created again, wasting the whole bundle download twice.
 *
 * So the worker is created once here and outlives any component. Components
 * subscribe and unsubscribe; events that arrive while nobody is listening are
 * queued rather than dropped, so a remount cannot miss the "ready" message and
 * leave the UI stuck on "loading".
 */
import type { RunnerEvent, RunnerRequest } from '../types'
import { RUNTIME_BASE_PATH, SAB_TOTAL_BYTES } from '../constants'
import { createStdinChannel, type StdinChannel } from './stdinChannel'
import { isTracing } from './mainThreadRuntime'

let worker: Worker | null = null
let stdin: StdinChannel | null = null
let listener: ((event: RunnerEvent) => void) | null = null
let queued: RunnerEvent[] = []

function emit(event: RunnerEvent): void {
  if (listener) listener(event)
  else queued.push(event)
}

/** Creates the worker and starts the runtime. Does nothing if already started. */
export function startWorkerRuntime(useSharedMemory: boolean): boolean {
  if (worker) return true

  let sab: SharedArrayBuffer | null = null
  if (useSharedMemory) {
    sab = new SharedArrayBuffer(SAB_TOTAL_BYTES)
    stdin = createStdinChannel(sab)
  }

  // A browser without module-worker support throws here rather than failing
  // later, so the caller can fall back immediately instead of waiting out the
  // boot timeout.
  let created: Worker
  try {
    created = new Worker(new URL('../workers/runner.worker.ts', import.meta.url), {
      type: 'module',
      name: 'java-runner',
    })
  } catch {
    stdin = null
    return false
  }
  created.onmessage = (event: MessageEvent<RunnerEvent>) => emit(event.data)
  created.onerror = (event) =>
    emit({ type: 'fatal', message: event.message || 'The runner worker crashed.' })

  const request: RunnerRequest = {
    type: 'init',
    runtimeBaseUrl: new URL(RUNTIME_BASE_PATH, location.origin).href,
    sab,
    // A worker's location is its own script URL, so the page's ?trace=1 has to
    // be handed over explicitly.
    verbose: isTracing(),
  }
  created.postMessage(request)
  worker = created
  return true
}

/** Throws the current runtime away and starts a fresh one. */
export function restartWorkerRuntime(useSharedMemory: boolean): void {
  worker?.terminate()
  worker = null
  stdin = null
  queued = []
  startWorkerRuntime(useSharedMemory)
}

export function subscribeToRuntime(fn: (event: RunnerEvent) => void): void {
  listener = fn
  const backlog = queued
  queued = []
  for (const event of backlog) fn(event)
}

export function unsubscribeFromRuntime(): void {
  listener = null
}

/** Whether this environment has workers at all. */
export function isWorkerRuntimeSupported(): boolean {
  return typeof Worker !== 'undefined'
}

/** Throws the worker away without starting another — used when falling back. */
export function stopWorkerRuntime(): void {
  worker?.terminate()
  worker = null
  stdin = null
  queued = []
}

export function postToRuntime(request: RunnerRequest): boolean {
  if (!worker) return false
  worker.postMessage(request)
  return true
}

export function getStdinChannel(): StdinChannel | null {
  return stdin
}

/** Test hook — drops the singleton so each test starts clean. */
export function _resetRuntimeHostForTests(): void {
  worker?.terminate()
  worker = null
  stdin = null
  listener = null
  queued = []
}
