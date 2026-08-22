import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CodeEditor, type EditorHandle } from './components/CodeEditor'
import { ConsolePanel } from './components/ConsolePanel'
import { FileSystemPanel } from './components/FileSystemPanel'
import { AboutDialog } from './components/dialogs/AboutDialog'
import { useDialogs } from './components/dialogs/DialogProvider'
import { IconButton } from './components/ui/IconButton'
import { ThemeToggleButton } from './components/ui/ThemeToggleButton'
import { useRunner, type FilesChangedHandler } from './hooks/useRunner'
import {
  MAX_CONSOLE_HEIGHT, MAX_SIDEBAR_WIDTH, MIN_CONSOLE_HEIGHT, MIN_SIDEBAR_WIDTH,
  PRODUCT_NAME,
} from './constants'
import { parseArgs } from './utils/args'
import { EXAMPLES, examplePath, findExample } from './utils/examples'
import { DEFAULT_LANGUAGE, getLanguage } from './utils/languages'
import {
  DEFAULT_FS_ID, createFilesystem, deleteEntry, ensureDefaultFilesystem,
  ensureFolders, ensureLanguageEntryPoint, getAllEntries, getEntryByPath,
  getMountableFiles, getParentPath, getSourceFiles, guessMimeType, importFileMapToFs,
  listFilesystems, writeFile,
} from './utils/virtualFS'
import {
  deleteFromFolderHandle, mkdirInFolderHandle, readDirectoryToMap,
  renameInFolderHandle, writeFileToFolderHandle,
} from './utils/localFolderIo'
import {
  loadActiveFilesystem, loadFixedInput, loadLayout, loadMainClass, loadRunArgs, loadTheme,
  saveActiveFilesystem, saveFixedInput, saveLayout, saveMainClass, saveRunArgs, saveTheme,
  toInputLines,
} from './utils/storage'
import type { CompilerDiagnostic, LocalFolderSyncOp, Theme, VFSEntry } from './types'

const decoder = new TextDecoder()
const encoder = new TextEncoder()

/** java coder compiles Java; the registry entry is still what drives the VFS. */
const language = DEFAULT_LANGUAGE

export function App() {
  const dialogs = useDialogs()
  // Declared before useRunner so the handler can be handed to it, and defined
  // after the filesystem helpers it needs; a ref inside useRunner keeps it
  // current without re-subscribing the worker.
  const filesChangedRef = useRef<FilesChangedHandler | null>(null)
  const runner = useRunner({
    onFilesChanged: (changes, createdFolders) =>
      filesChangedRef.current?.(changes, createdFolders),
  })

  const [theme, setTheme] = useState<Theme>(loadTheme)
  const [activeFilesystemId, setActiveFilesystemId] = useState<string>(() => loadActiveFilesystem() ?? DEFAULT_FS_ID)
  const [currentPath, setCurrentPath] = useState('/')
  const [openFilePath, setOpenFilePath] = useState<string | null>(null)
  const [editorValue, setEditorValue] = useState('')
  const [dirty, setDirty] = useState(false)
  const [reloadTrigger, setReloadTrigger] = useState(0)
  const [banner, setBanner] = useState<string | null>(null)
  const [runArgs, setRunArgs] = useState(loadRunArgs)
  const [fixedInput, setFixedInput] = useState(loadFixedInput)
  const [layout, setLayout] = useState(loadLayout)
  const [booted, setBooted] = useState(false)
  /** '' means "let the compiler choose"; otherwise a pinned class name. */
  const [mainClass, setMainClass] = useState(loadMainClass)
  const [aboutOpen, setAboutOpen] = useState(false)

  const [localFolderHandle, setLocalFolderHandle] = useState<FileSystemDirectoryHandle | null>(null)
  const [localFolderFsId, setLocalFolderFsId] = useState<string | null>(null)

  const editorHandleRef = useRef<EditorHandle | null>(null)
  const saveTimerRef = useRef<number | null>(null)
  const openFilePathRef = useRef<string | null>(null)
  openFilePathRef.current = openFilePath

  const isLocalFolderConnected = localFolderHandle !== null && localFolderFsId === activeFilesystemId

  // ── Theme ───────────────────────────────────────────────────────────────
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    saveTheme(theme)
  }, [theme])

  useEffect(() => { saveActiveFilesystem(activeFilesystemId) }, [activeFilesystemId])
  useEffect(() => { saveRunArgs(runArgs) }, [runArgs])
  useEffect(() => { saveFixedInput(fixedInput) }, [fixedInput])
  useEffect(() => { saveLayout(layout) }, [layout])
  useEffect(() => { saveMainClass(mainClass) }, [mainClass])

  const showBanner = useCallback((message: string) => {
    setBanner(message)
    window.setTimeout(() => setBanner(current => (current === message ? null : current)), 6000)
  }, [])

  // ── File loading ────────────────────────────────────────────────────────

  const openPath = useCallback(async (fsId: string, path: string) => {
    const entry = await getEntryByPath(fsId, path)
    if (!entry || entry.type !== 'file') return
    setOpenFilePath(path)
    setEditorValue(entry.content ? decoder.decode(entry.content) : '')
    setDirty(false)
  }, [])

  // First paint: make sure there is a default filesystem with something to edit.
  useEffect(() => {
    void (async () => {
      try {
        await ensureDefaultFilesystem(language)
        const known = await listFilesystems()
        const targetFsId = known.some(f => f.id === activeFilesystemId) ? activeFilesystemId : DEFAULT_FS_ID
        if (targetFsId !== activeFilesystemId) setActiveFilesystemId(targetFsId)
        const entryPoint = await ensureLanguageEntryPoint(targetFsId, language)
        const sources = await getSourceFiles(targetFsId, language)
        await openPath(targetFsId, entryPoint ?? sources[0]?.path ?? `/${getLanguage(language).defaultFileName}`)
      } catch (error) {
        showBanner(`Could not open the workspace: ${String(error)}`)
      } finally {
        setBooted(true)
        setReloadTrigger(t => t + 1)
      }
    })()
    // Runs once: later changes go through switchFilesystem.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Saving ──────────────────────────────────────────────────────────────

  const saveNow = useCallback(async (path: string, text: string) => {
    const content = encoder.encode(text).buffer as ArrayBuffer
    await writeFile(activeFilesystemId, path, content, guessMimeType(path))
    if (localFolderHandle && localFolderFsId === activeFilesystemId) {
      try {
        await writeFileToFolderHandle(localFolderHandle, path, content)
      } catch (error) {
        showBanner(`Saved in the browser, but writing to your folder failed: ${String(error)}`)
      }
    }
    setDirty(false)
  }, [activeFilesystemId, localFolderHandle, localFolderFsId, showBanner])

  const handleEditorChange = useCallback((next: string) => {
    setEditorValue(next)
    setDirty(true)
    const path = openFilePathRef.current
    if (!path) return
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current)
    saveTimerRef.current = window.setTimeout(() => {
      void saveNow(path, next).then(() => setReloadTrigger(t => t + 1))
    }, 500)
  }, [saveNow])

  const flushSave = useCallback(async () => {
    const path = openFilePathRef.current
    if (!path) return
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    await saveNow(path, editorValue)
  }, [editorValue, saveNow])

  // ── Filesystem switching ────────────────────────────────────────────────

  /**
   * `seedStarter` creates a `Main.java` when the filesystem has no source of
   * its own. That is right for an empty workspace and wrong for a folder from
   * the user's computer, where it would put a file in their folder that they
   * never asked for.
   */
  const switchFilesystem = useCallback(async (id: string, options: { seedStarter?: boolean } = {}) => {
    const seedStarter = options.seedStarter !== false
    await flushSave()
    setActiveFilesystemId(id)
    setCurrentPath('/')
    try {
      const entryPoint = seedStarter ? await ensureLanguageEntryPoint(id, language) : null
      const sources = await getSourceFiles(id, language)
      const target = entryPoint ?? sources[0]?.path
      if (target) await openPath(id, target)
      else { setOpenFilePath(null); setEditorValue('') }
    } catch (error) {
      showBanner(String(error))
    }
    setReloadTrigger(t => t + 1)
  }, [flushSave, openPath, showBanner])

  // ── Local folder ────────────────────────────────────────────────────────

  const connectLocalFolder = useCallback(async () => {
    const picker = (window as unknown as {
      showDirectoryPicker?: (options?: { mode?: string }) => Promise<FileSystemDirectoryHandle>
    }).showDirectoryPicker
    if (!picker) {
      await dialogs.alert({
        title: 'Not supported in this browser',
        message: 'Connecting a folder needs the File System Access API, which is available in Chrome, Edge and other Chromium browsers. In Firefox and Safari you can still upload files and download them.',
      })
      return
    }
    // Asked *before* the folder picker, so the browser only ever requests the
    // access that was actually chosen — and so nobody grants write access to a
    // real folder without being told what that means.
    const mode = await dialogs.choose({
      title: 'Connect a folder on this computer',
      message: 'How should this folder be connected?',
      warning: 'A two-way link writes to the real folder on your computer. That includes files your programs create, and deleting a file here deletes it there.',
      choices: [
        {
          value: 'link',
          label: 'Two-way link',
          description: 'Open the folder and keep it in step: saving, creating, renaming and deleting here are applied to the folder straight away, as is anything your programs write.',
        },
        {
          value: 'import',
          label: 'One-way import (a copy)',
          description: 'Copy the files in now and leave the folder alone. Nothing is ever written back to your computer.',
        },
      ],
    })
    if (mode === null) return

    try {
      const handle = await picker({ mode: mode === 'link' ? 'readwrite' : 'read' })
      const files = await readDirectoryToMap(handle)
      const created = await createFilesystem(handle.name)
      await importFileMapToFs(created.id, files)
      if (mode === 'link') {
        setLocalFolderHandle(handle)
        setLocalFolderFsId(created.id)
      }
      // No starter file: this is the user's own folder, not an empty workspace.
      await switchFilesystem(created.id, { seedStarter: false })
      showBanner(mode === 'link'
        ? `Linked "${handle.name}". Changes here are written to that folder.`
        : `Imported a copy of "${handle.name}". Your folder will not be changed.`)
    } catch (error) {
      if ((error as DOMException)?.name === 'AbortError') return
      showBanner(`Could not connect the folder: ${String(error)}`)
    }
  }, [dialogs, showBanner, switchFilesystem])

  const reloadLocalFolder = useCallback(async () => {
    if (!localFolderHandle || !localFolderFsId) return
    try {
      const files = await readDirectoryToMap(localFolderHandle)
      await importFileMapToFs(localFolderFsId, files)
      setReloadTrigger(t => t + 1)
      if (openFilePath) await openPath(localFolderFsId, openFilePath)
      showBanner('Reloaded from the connected folder.')
    } catch (error) {
      showBanner(`Could not read the folder: ${String(error)}`)
    }
  }, [localFolderFsId, localFolderHandle, openFilePath, openPath, showBanner])

  const disconnectLocalFolder = useCallback(() => {
    setLocalFolderHandle(null)
    setLocalFolderFsId(null)
    showBanner('Folder disconnected. The files stay in this browser filesystem.')
  }, [showBanner])

  const syncToLocalFolder = useCallback(async (op: LocalFolderSyncOp) => {
    if (!localFolderHandle || localFolderFsId !== activeFilesystemId) return
    try {
      if (op.kind === 'write') await writeFileToFolderHandle(localFolderHandle, op.path, op.content)
      else if (op.kind === 'mkdir') await mkdirInFolderHandle(localFolderHandle, op.path)
      else if (op.kind === 'delete') await deleteFromFolderHandle(localFolderHandle, op.path)
      else await renameInFolderHandle(localFolderHandle, op.path, op.newName)
    } catch (error) {
      showBanner(`The change was saved in the browser but not on disk: ${String(error)}`)
    }
  }, [activeFilesystemId, localFolderFsId, localFolderHandle, showBanner])

  // ── Running ─────────────────────────────────────────────────────────────

  const handleRun = useCallback(async () => {
    if (!runner.ready || runner.running) return
    await flushSave()
    const sources = await getSourceFiles(activeFilesystemId, language)
    if (sources.length === 0) {
      showBanner('There are no .java files in this filesystem to run.')
      return
    }
    // The program gets a snapshot of the files, so it can open them; what it
    // changes comes back through onFilesChanged when the run ends.
    const { files, skipped } = await getMountableFiles(activeFilesystemId)
    if (skipped.length > 0) {
      showBanner(
        `Too large to give to the program, so left out: ${skipped.join(', ')}.`,
      )
    }
    runner.clearOutput()
    runner.run(sources, parseArgs(runArgs), toInputLines(fixedInput), mainClass || null, files)
  }, [activeFilesystemId, fixedInput, flushSave, mainClass, runArgs, runner, showBanner])

  /**
   * Writes back whatever the program did to the filesystem.
   *
   * Applied after the run rather than during it, so a program that writes a
   * file cannot interleave with the editor saving one.
   */
  const applyFileChanges = useCallback<FilesChangedHandler>((changes, createdFolders) => {
    void (async () => {
      try {
        for (const folder of createdFolders) {
          await ensureFolders(activeFilesystemId, folder)
          if (isLocalFolderConnected) await syncToLocalFolder({ kind: 'mkdir', path: folder })
        }
        for (const change of changes) {
          if (change.bytes === null) {
            await deleteEntry(activeFilesystemId, change.path)
            if (isLocalFolderConnected) await syncToLocalFolder({ kind: 'delete', path: change.path })
            continue
          }
          // Copied, because the bytes arrived from the worker in a buffer that
          // may be a view onto a larger one.
          const content = change.bytes.slice().buffer as ArrayBuffer
          await ensureFolders(activeFilesystemId, getParentPath(change.path))
          await writeFile(activeFilesystemId, change.path, content, guessMimeType(change.path))
          if (isLocalFolderConnected) await syncToLocalFolder({ kind: 'write', path: change.path, content })
        }
        setReloadTrigger(t => t + 1)
        // A file the program rewrote may be the one on screen.
        const open = openFilePathRef.current
        if (open && changes.some(change => change.path === open && change.bytes !== null)) {
          await openPath(activeFilesystemId, open)
        }
        const written = changes.filter(change => change.bytes !== null).length
        const removed = changes.length - written
        if (written > 0 || removed > 0) {
          showBanner(
            `The program updated the file list: ${written} written${removed > 0 ? `, ${removed} deleted` : ''}.`,
          )
        }
      } catch (error) {
        showBanner(`The program's file changes could not be saved: ${String(error)}`)
      }
    })()
  }, [activeFilesystemId, isLocalFolderConnected, openPath, showBanner, syncToLocalFolder])
  filesChangedRef.current = applyFileChanges

  /**
   * Writes a ready-made example into the current filesystem, opens it, and
   * pins it as the class to run — so the next thing to do is press Run.
   */
  const addExample = useCallback(async (id: string) => {
    const example = findExample(id)
    if (!example) return
    const path = examplePath(example)
    try {
      if (await getEntryByPath(activeFilesystemId, path)) {
        const replace = await dialogs.confirm({
          title: 'Replace the example?',
          message: `${path} already exists in this filesystem.`,
          warning: 'Any changes you have made to it will be lost.',
          confirmLabel: 'Replace',
          destructive: true,
        })
        if (!replace) return
      }
      await flushSave()
      const content = encoder.encode(example.source).buffer as ArrayBuffer
      await writeFile(activeFilesystemId, path, content, guessMimeType(path))
      if (isLocalFolderConnected) await syncToLocalFolder({ kind: 'write', path, content })
      await openPath(activeFilesystemId, path)
      setMainClass(example.className)
      setReloadTrigger(t => t + 1)
      showBanner(`Added ${path}. Press Run to try it.`)
    } catch (error) {
      showBanner(`Could not add the example: ${String(error)}`)
    }
  }, [activeFilesystemId, dialogs, flushSave, isLocalFolderConnected, openPath, showBanner, syncToLocalFolder])

  const selectDiagnostic = useCallback(async (diagnostic: CompilerDiagnostic) => {
    if (!diagnostic.file) return
    if (diagnostic.file !== openFilePath) {
      const entries = await getAllEntries(activeFilesystemId)
      if (!entries.some(e => e.path === diagnostic.file)) return
      await flushSave()
      await openPath(activeFilesystemId, diagnostic.file)
    }
    window.setTimeout(() => editorHandleRef.current?.revealPosition(diagnostic.line, diagnostic.column), 60)
  }, [activeFilesystemId, flushSave, openFilePath, openPath])

  const handleOpenFile = useCallback(async (entry: VFSEntry) => {
    await flushSave()
    await openPath(activeFilesystemId, entry.path)
  }, [activeFilesystemId, flushSave, openPath])

  const setEditorHandle = useCallback((handle: EditorHandle | null) => {
    editorHandleRef.current = handle
  }, [])

  // ── Splitters ───────────────────────────────────────────────────────────

  const startDrag = useCallback((axis: 'x' | 'y') => (event: React.PointerEvent) => {
    event.preventDefault()
    const startPosition = axis === 'x' ? event.clientX : event.clientY
    const startValue = axis === 'x' ? layout.sidebarWidth : layout.consoleHeight
    const move = (moveEvent: PointerEvent) => {
      const delta = (axis === 'x' ? moveEvent.clientX : moveEvent.clientY) - startPosition
      setLayout(current => axis === 'x'
        ? { ...current, sidebarWidth: clamp(startValue + delta, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH) }
        : { ...current, consoleHeight: clamp(startValue - delta, MIN_CONSOLE_HEIGHT, MAX_CONSOLE_HEIGHT) })
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }, [layout.consoleHeight, layout.sidebarWidth])

  const statusText = useMemo(() => {
    if (runner.fatal) return 'runtime error'
    switch (runner.phase) {
      case 'loading-runtime':
        return runner.statusDetail
          ? `loading the Java toolchain — ${runner.statusDetail}`
          : 'loading the Java toolchain…'
      case 'loading-classlib': return `loading the class library… ${runner.statusDetail}`
      // Two compilers, two waits: javac produces bytecode, TeaVM turns that
      // into WebAssembly. Naming the step makes the second one explicable.
      case 'compiling': return 'compiling with javac…'
      case 'generating': return 'generating WebAssembly…'
      case 'running': return runner.awaitingInput ? 'waiting for input' : 'running…'
      case 'error': return 'runtime error'
      default: return runner.ready ? 'ready' : 'starting…'
    }
  }, [runner.awaitingInput, runner.fatal, runner.phase, runner.ready, runner.statusDetail])

  // Offer whatever the last compilation found, plus anything already pinned, so
  // the picker never silently drops the user's choice before the first run.
  const mainClassOptions = useMemo(() => {
    const names = new Set(runner.mainClasses)
    if (mainClass) names.add(mainClass)
    return [...names].sort((a, b) => a.localeCompare(b))
  }, [mainClass, runner.mainClasses])

  return (
    <div className="flex h-screen w-screen flex-col gap-2 bg-slate-950 p-2">
      <header className="flex shrink-0 flex-wrap items-center gap-2 rounded-xl border border-slate-700 bg-slate-900/60 px-3 py-2">
        <h1 className="mr-2 text-sm font-semibold tracking-tight text-slate-100">
          A Java <span className="text-emerald-400">Coder</span>
        </h1>

        <label className="flex items-center gap-1.5 text-xs text-slate-400">
          Main
          <select
            value={mainClass}
            onChange={(event) => setMainClass(event.target.value)}
            title="Which class's main method to run"
            className="max-w-[12rem] rounded-md border border-slate-600 bg-slate-800 px-2 py-1 text-sm text-slate-100 outline-none focus:border-emerald-500"
          >
            <option value="">
              {runner.selectedMainClass ? `auto (${runner.selectedMainClass})` : 'auto'}
            </option>
            {mainClassOptions.map(name => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
        </label>

        {/* Value is always '', so the menu reads as an action rather than a
            setting and the same example can be added twice. */}
        <label className="flex items-center gap-1.5 text-xs text-slate-400">
          Examples
          <select
            value=""
            onChange={(event) => {
              const chosen = event.target.value
              if (chosen) void addExample(chosen)
            }}
            title="Add a ready-made example to this filesystem"
            className="max-w-[13rem] rounded-md border border-slate-600 bg-slate-800 px-2 py-1 text-sm text-slate-100 outline-none focus:border-emerald-500"
          >
            <option value="">Add…</option>
            {EXAMPLES.map(example => (
              <option key={example.id} value={example.id} title={example.summary}>
                {example.label}
              </option>
            ))}
          </select>
        </label>

        <button
          type="button"
          onClick={() => void handleRun()}
          disabled={!runner.ready || runner.running}
          title="Run (Ctrl+Enter)"
          className="flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-40"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M6 4l14 8-14 8z" /></svg>
          Run
        </button>

        {/* WebAssembly cannot be interrupted from outside, so stopping means
            discarding the worker and booting a fresh toolchain. The same button
            doubles as a retry when the toolchain failed to start. */}
        <button
          type="button"
          onClick={runner.stop}
          disabled={!runner.running && runner.ready}
          title={runner.running
            ? 'Stop the program and restart the Java toolchain'
            : 'Restart the Java toolchain'}
          className="flex items-center gap-1.5 rounded-md border border-slate-600 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-700 disabled:opacity-40"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1.5" /></svg>
          {runner.running ? 'Stop' : 'Restart'}
        </button>

        <label className="flex min-w-0 items-center gap-1.5 text-xs text-slate-400">
          Args
          <input
            value={runArgs}
            onChange={(event) => setRunArgs(event.target.value)}
            placeholder="passed to main(String[] args)"
            className="w-48 min-w-0 rounded-md border border-slate-600 bg-slate-800 px-2 py-1 text-sm text-slate-100 outline-none placeholder:text-slate-600 focus:border-emerald-500"
          />
        </label>

        <div className="ml-auto flex items-center gap-2">
          <span className={`text-xs ${runner.fatal ? 'text-red-300' : runner.ready ? 'text-slate-500' : 'text-amber-300'}`}>
            {statusText}
          </span>
          {dirty && <span className="text-xs text-slate-500">unsaved</span>}
          <IconButton label="Save (Ctrl+S)" onClick={() => void flushSave()} disabled={!openFilePath}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" /><path d="M17 21v-8H7v8M7 3v5h8" />
            </svg>
          </IconButton>
          <ThemeToggleButton theme={theme} onToggle={() => setTheme(t => (t === 'dark' ? 'light' : 'dark'))} />
          <IconButton label={`About ${PRODUCT_NAME}`} onClick={() => setAboutOpen(true)}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="12" cy="12" r="9" /><path d="M12 11v5" /><path d="M12 7.5v.5" />
            </svg>
          </IconButton>
        </div>
      </header>

      <AboutDialog open={aboutOpen} onClose={() => setAboutOpen(false)} />

      {banner && (
        <div className="shrink-0 rounded-lg border border-slate-600 bg-slate-800/60 px-3 py-2 text-xs text-slate-200">
          {banner}
          <button type="button" onClick={() => setBanner(null)} className="ml-2 text-slate-500 hover:text-slate-200">dismiss</button>
        </div>
      )}

      <main className="flex min-h-0 flex-1">
        {!layout.sidebarCollapsed && (
          <>
            <div style={{ width: layout.sidebarWidth }} className="min-h-0 shrink-0">
              <FileSystemPanel
                activeFilesystemId={activeFilesystemId}
                currentPath={currentPath}
                openFilePath={openFilePath}
                language={language}
                reloadTrigger={reloadTrigger}
                isLocalFolderConnected={isLocalFolderConnected}
                localFolderName={localFolderHandle?.name ?? null}
                onFilesystemChange={(id) => void switchFilesystem(id)}
                onPathChange={setCurrentPath}
                onOpenFile={(entry) => void handleOpenFile(entry)}
                onFileDeleted={(path) => {
                  if (path === openFilePath) { setOpenFilePath(null); setEditorValue('') }
                }}
                onFileRenamed={(oldPath, newPath) => {
                  if (oldPath === openFilePath) setOpenFilePath(newPath)
                }}
                onError={showBanner}
                onChanged={() => setReloadTrigger(t => t + 1)}
                onConnectLocalFolder={() => void connectLocalFolder()}
                onReloadLocalFolder={() => void reloadLocalFolder()}
                onDisconnectLocalFolder={disconnectLocalFolder}
                onLocalFolderSync={syncToLocalFolder}
              />
            </div>
            <div className="resize-handle-col" onPointerDown={startDrag('x')}>
              <div className="resize-bar h-16 w-1" />
            </div>
          </>
        )}

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex shrink-0 items-center gap-2 px-1 pb-1">
              <button
                type="button"
                onClick={() => setLayout(current => ({ ...current, sidebarCollapsed: !current.sidebarCollapsed }))}
                className="rounded px-1.5 py-0.5 text-xs text-slate-500 hover:bg-slate-700/60 hover:text-slate-200"
              >
                {layout.sidebarCollapsed ? '▸ files' : '◂ files'}
              </button>
              <span className="truncate text-xs text-slate-400">{openFilePath ?? (booted ? 'no file open' : 'loading…')}</span>
            </div>
            <div className="min-h-0 flex-1">
              <CodeEditor
                path={openFilePath}
                value={editorValue}
                diagnostics={runner.diagnostics}
                theme={theme}
                onChange={handleEditorChange}
                onSave={() => void flushSave()}
                onRun={() => void handleRun()}
                handleRef={setEditorHandle}
              />
            </div>
          </div>

          <div className="resize-handle-row" onPointerDown={startDrag('y')}>
            <div className="resize-bar h-1 w-16" />
          </div>

          <div style={{ height: layout.consoleHeight }} className="min-h-0 shrink-0">
            <ConsolePanel
              output={runner.output}
              diagnostics={runner.diagnostics}
              awaitingInput={runner.awaitingInput}
              inputSupported={runner.inputSupported}
              inputUnavailableReason={runner.inputUnavailableReason}
              fixedInput={fixedInput}
              onFixedInputChange={setFixedInput}
              running={runner.running}
              lastExitCode={runner.lastExitCode}
              onSubmitInput={runner.submitInput}
              onQueueInput={runner.queueInput}
              onEndInput={runner.endInput}
              onClear={runner.clearOutput}
              onSelectDiagnostic={(diagnostic) => void selectDiagnostic(diagnostic)}
            />
          </div>
        </div>
      </main>
    </div>
  )
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}
