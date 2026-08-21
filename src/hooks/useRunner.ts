import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CompilerDiagnostic, RunnerEvent, RunnerPhase, RunnerRequest } from '../types'
import { CONSOLE_SCROLLBACK_LINES, RUNTIME_BASE_PATH, WORKER_BOOT_TIMEOUT_MS } from '../constants'
import { publishEof, publishLine } from '../utils/stdinChannel'
import {
  getStdinChannel, isWorkerRuntimeSupported, postToRuntime, restartWorkerRuntime,
  startWorkerRuntime, stopWorkerRuntime, subscribeToRuntime, unsubscribeFromRuntime,
} from '../utils/runtimeHost'
import {
  bootOnMainThread, resolveRuntimePreference, setPendingInput, takePendingInput,
} from '../utils/mainThreadRuntime'
import { compileAndRun } from '../workers/javaPipeline'
import type { Toolchain } from '../workers/bootRuntime'

export type ConsoleChunkKind = 'out' | 'err' | 'system' | 'input'

export interface ConsoleChunk {
  id: number
  kind: ConsoleChunkKind
  text: string
}

export interface RunnerState {
  phase: RunnerPhase
  statusDetail: string
  ready: boolean
  running: boolean
  awaitingInput: boolean
  output: ConsoleChunk[]
  diagnostics: CompilerDiagnostic[]
  fatal: string | null
  /** False when a read cannot block, i.e. input can only come from the Inputs tab. */
  inputSupported: boolean
  /** Why input is unavailable, when it is. */
  inputUnavailableReason: string | null
  lastExitCode: number | null
  /** Entry points the last compilation found. */
  mainClasses: string[]
  /** The one it actually ran. */
  selectedMainClass: string | null
}

export interface RunnerControls extends RunnerState {
  run(
    sources: Array<{ path: string; text: string }>,
    args: string[],
    /** Lines handed to the program before the user is asked to type. */
    fixedInput: string[],
    /** Class whose `main` to run, or null to let the compiler choose. */
    mainClass: string | null,
    /** The editor's files, which the program can read and write. */
    files: Array<{ path: string; bytes: Uint8Array }>,
  ): void
  submitInput(line: string): void
  /** Answer the next reads without the user typing again. */
  queueInput(lines: string[]): void
  endInput(): void
  stop(): void
  clearOutput(): void
}

/** What a finished program changed in the editor's filesystem. */
export type FilesChangedHandler = (
  changes: Array<{ path: string; bytes: Uint8Array | null }>,
  createdFolders: string[],
) => void

export interface RunnerOptions {
  /**
   * Called once a run ends, with the files it touched. Kept in a ref rather
   * than a dependency, so App can close over its current state without the
   * worker having to be re-subscribed.
   */
  onFilesChanged?: FilesChangedHandler
}

/** SharedArrayBuffer needs cross-origin isolation; without it reads cannot block. */
function canUseSharedMemory(): boolean {
  return typeof SharedArrayBuffer !== 'undefined' && globalThis.crossOriginIsolated === true
}

export function useRunner(options: RunnerOptions = {}): RunnerControls {
  const filesChangedRef = useRef<FilesChangedHandler | undefined>(undefined)
  filesChangedRef.current = options.onFilesChanged

  // Set only in ?runtime=main mode, where there is no worker at all.
  const mainThreadToolchainRef = useRef<Toolchain | null>(null)
  // Worker mode answers input requests from here before prompting the user.
  const pendingInputRef = useRef<string[]>([])
  const preference = useMemo(resolveRuntimePreference, [])
  // Where the runtime actually ended up. Starts as the preference, and only
  // changes when `auto` gives up on the worker.
  const [mainThreadMode, setMainThreadMode] = useState(
    preference === 'main' || (preference === 'auto' && !isWorkerRuntimeSupported()),
  )
  const mainThreadModeRef = useRef(mainThreadMode)
  mainThreadModeRef.current = mainThreadMode
  const preferenceRef = useRef(preference)
  preferenceRef.current = preference
  // Set once bootMainThread exists; the event handler is defined before it.
  const fallbackToMainThreadRef = useRef<((reason: string) => void) | null>(null)
  const readyRef = useRef(false)
  const chunkIdRef = useRef(0)

  const [phase, setPhase] = useState<RunnerPhase>('loading-runtime')
  const [statusDetail, setStatusDetail] = useState('')
  const [ready, setReady] = useState(false)
  const [running, setRunning] = useState(false)
  const [awaitingInput, setAwaitingInput] = useState(false)
  const [output, setOutput] = useState<ConsoleChunk[]>([])
  const [diagnostics, setDiagnostics] = useState<CompilerDiagnostic[]>([])
  const [fatal, setFatal] = useState<string | null>(null)
  const [lastExitCode, setLastExitCode] = useState<number | null>(null)
  const [mainClasses, setMainClasses] = useState<string[]>([])
  const [selectedMainClass, setSelectedMainClass] = useState<string | null>(null)

  // Typed input needs a worker that can block; the UI thread cannot.
  const sharedMemoryAvailable = useMemo(canUseSharedMemory, [])
  const inputSupported = !mainThreadMode && sharedMemoryAvailable

  const append = useCallback((kind: ConsoleChunkKind, text: string) => {
    if (!text) return
    setOutput((previous) => {
      const next = [...previous, { id: chunkIdRef.current++, kind, text }]
      return next.length > CONSOLE_SCROLLBACK_LINES
        ? next.slice(next.length - CONSOLE_SCROLLBACK_LINES)
        : next
    })
  }, [])

  const handleEvent = useCallback((message: RunnerEvent) => {
    switch (message.type) {
      case 'status':
        setPhase(message.phase)
        setStatusDetail(message.detail ?? '')
        break
      case 'ready':
        readyRef.current = true
        setReady(true)
        setPhase('idle')
        break
      case 'stdout': append('out', message.text); break
      case 'stderr': append('err', message.text); break
      case 'diagnostics':
        setDiagnostics(message.diagnostics)
        for (const diagnostic of message.diagnostics.filter(d => d.severity === 'error')) {
          const where = diagnostic.file ? `${diagnostic.file}:${diagnostic.line}:${diagnostic.column}` : 'error'
          append('err', `${where}: ${diagnostic.message}\n`)
        }
        break
      case 'main-classes':
        setMainClasses(message.classes)
        setSelectedMainClass(message.selected)
        break
      case 'files-changed':
        // Handed to App, which owns the filesystem and any connected folder.
        filesChangedRef.current?.(message.changes, message.createdFolders)
        break
      case 'input-request': {
        // A line supplied up front answers the request without interrupting the
        // user; only fall back to typing once those run out.
        const queued = pendingInputRef.current.shift()
        if (queued !== undefined) {
          append('input', queued + '\n')
          const channel = getStdinChannel()
          if (channel) publishLine(channel, queued)
        } else {
          setAwaitingInput(true)
        }
        break
      }
      case 'exit':
        setRunning(false)
        setAwaitingInput(false)
        setLastExitCode(message.code)
        break
      case 'fatal':
        setRunning(false)
        setAwaitingInput(false)
        // A worker that dies before it is ready should not strand the IDE:
        // fall back rather than waiting out the boot timeout.
        if (!readyRef.current && !mainThreadModeRef.current && preferenceRef.current === 'auto') {
          fallbackToMainThreadRef.current?.(`the worker runtime failed to start (${message.message})`)
          break
        }
        setFatal(message.message)
        append('err', message.message + '\n')
        break
    }
  }, [append])

  const bootMainThread = useCallback(() => {
    setMainThreadMode(true)
    setFatal(null)
    setPhase('loading-runtime')
    void bootOnMainThread(new URL(RUNTIME_BASE_PATH, location.origin).href, { emit: handleEvent })
      .then((toolchain) => {
        mainThreadToolchainRef.current = toolchain
        readyRef.current = true
        setReady(true)
        setPhase('idle')
        setStatusDetail('')
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        setPhase('error')
        setFatal(message)
        append('err', message + '\n')
      })
  }, [append, handleEvent])

  const fallbackToMainThread = useCallback((reason: string) => {
    stopWorkerRuntime()
    append('system',
      `\n[${reason}, so it has been restarted on the UI thread]\n` +
      '[typing input is unavailable there — put the program\'s input in the Inputs tab]\n')
    bootMainThread()
  }, [append, bootMainThread])
  fallbackToMainThreadRef.current = fallbackToMainThread

  useEffect(() => {
    if (mainThreadMode) {
      if (preference === 'auto') {
        append('system',
          '[this browser cannot run the Java toolchain on a worker thread]\n' +
          '[put the program\'s input in the Inputs tab — typing in the console needs a worker]\n')
      }
      bootMainThread()
      return undefined
    }

    // The runtime outlives this component (see utils/runtimeHost.ts), so the
    // cleanup only detaches the listener — it must not tear the runtime down.
    subscribeToRuntime(handleEvent)
    if (!startWorkerRuntime(sharedMemoryAvailable)) {
      unsubscribeFromRuntime()
      fallbackToMainThread('this browser cannot run the Java toolchain on a worker thread')
      return undefined
    }

    if (preference !== 'auto') return () => unsubscribeFromRuntime()

    // A worker that never starts must not mean a broken IDE. Give it a
    // generous window — a cold cache on a slow connection is a legitimate
    // couple of dozen seconds for 6.7MB — then fall back and say so plainly.
    const fallback = window.setTimeout(() => {
      if (readyRef.current || mainThreadModeRef.current) return
      fallbackToMainThread('the toolchain did not start on a worker thread')
    }, WORKER_BOOT_TIMEOUT_MS)

    return () => {
      window.clearTimeout(fallback)
      unsubscribeFromRuntime()
    }
    // Runs once. handleEvent is stable, and the runtime itself is a page-level
    // singleton, so a StrictMode double-mount re-subscribes rather than
    // re-booting.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const run = useCallback((
    sources: Array<{ path: string; text: string }>,
    args: string[],
    fixedInput: string[],
    mainClass: string | null,
    files: Array<{ path: string; bytes: Uint8Array }>,
  ) => {
    if (!ready || running) return
    setDiagnostics([])
    setLastExitCode(null)
    setRunning(true)
    pendingInputRef.current = [...fixedInput]
    setPendingInput(fixedInput)

    if (mainThreadMode) {
      const toolchain = mainThreadToolchainRef.current
      if (!toolchain) { setRunning(false); return }
      // Everything below runs on the UI thread and blocks it until the
      // student's program returns.
      void compileAndRun(toolchain, { sources, args, mainClass, files }, {
        verbose: false,
        onStatus: (nextPhase, detail) => { setPhase(nextPhase); setStatusDetail(detail ?? '') },
        onDiagnostics: (list) => {
          setDiagnostics(list)
          for (const diagnostic of list.filter(d => d.severity === 'error')) {
            const where = diagnostic.file ? `${diagnostic.file}:${diagnostic.line}:${diagnostic.column}` : 'error'
            append('err', `${where}: ${diagnostic.message}\n`)
          }
        },
        onMainClasses: (classes, selected) => { setMainClasses(classes); setSelectedMainClass(selected) },
        onFilesChanged: (changes, createdFolders) => {
          if (changes.length > 0 || createdFolders.length > 0) {
            filesChangedRef.current?.(changes, createdFolders)
          }
        },
        writeStdout: (text) => append('out', text),
        writeStderr: (text) => append('err', text),
        // Nothing can block here: answer from the Inputs tab, then report EOF.
        readLine: () => {
          const line = takePendingInput()
          if (line !== null) append('input', line + '\n')
          return line
        },
        onExit: (code) => { setRunning(false); setLastExitCode(code); setPhase('idle') },
      }).catch((error: unknown) => {
        append('err', (error instanceof Error ? error.message : String(error)) + '\n')
        setRunning(false)
        setPhase('idle')
      })
      return
    }

    const request: RunnerRequest = { type: 'run', sources, args, mainClass, files }
    if (!postToRuntime(request)) setRunning(false)
  }, [append, mainThreadMode, ready, running])

  const submitInput = useCallback((line: string) => {
    setAwaitingInput(false)
    append('input', line + '\n')
    const channel = getStdinChannel()
    if (channel) publishLine(channel, line)
  }, [append])

  const queueInput = useCallback((lines: string[]) => {
    // Ahead of anything else waiting: these came from the user just now.
    pendingInputRef.current.unshift(...lines)
  }, [])

  const endInput = useCallback(() => {
    setAwaitingInput(false)
    append('system', '[end of input]\n')
    const channel = getStdinChannel()
    if (channel) publishEof(channel)
  }, [append])

  const stop = useCallback(() => {
    if (mainThreadMode) {
      append('system', '\n[cannot stop a program running on the UI thread — reload the page]\n')
      return
    }
    // WebAssembly cannot be interrupted, so stopping means discarding the
    // worker and booting a fresh toolchain. The bundle comes from the HTTP
    // cache, so this takes a second or two rather than a fresh download.
    append('system', '\n[stopped — restarting the Java toolchain]\n')
    setRunning(false)
    setAwaitingInput(false)
    setReady(false)
    setFatal(null)
    setPhase('loading-runtime')
    restartWorkerRuntime(inputSupported)
  }, [append, inputSupported, mainThreadMode])

  const clearOutput = useCallback(() => {
    setOutput([])
    setLastExitCode(null)
  }, [])

  const inputUnavailableReason = inputSupported
    ? null
    : mainThreadMode
      ? 'Typing here needs the worker runtime, which cannot block on the UI thread. Put the program\'s input in the Inputs tab instead — each line answers one read.'
      : 'Console input is unavailable: this page is not cross-origin isolated, so SharedArrayBuffer is blocked. Serve it with the COOP/COEP headers in _headers.'

  return {
    phase, statusDetail, ready, running, awaitingInput, output, diagnostics,
    fatal, inputSupported, inputUnavailableReason, lastExitCode,
    mainClasses, selectedMainClass,
    run, submitInput, queueInput, endInput, stop, clearOutput,
  }
}
