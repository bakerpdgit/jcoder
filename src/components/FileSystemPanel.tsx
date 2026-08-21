import { useCallback, useEffect, useRef, useState } from 'react'
import type { LanguageId, LocalFolderSyncOp, VFSEntry, VFSFilesystem } from '../types'
import {
  DEFAULT_FS_ID, createEntry, createFilesystem, deleteEntry, deleteFilesystem,
  downloadEntryAsZip, downloadSingleFile, getEntryByPath, guessMimeType,
  importZipToFs, isImageMime, isTextMime, listChildren, listFilesystems,
  renameEntry, renameFilesystem,
} from '../utils/virtualFS'
import { useDialogs } from './dialogs/DialogProvider'
import { IconButton } from './ui/IconButton'

interface Props {
  activeFilesystemId: string
  currentPath: string
  openFilePath: string | null
  language: LanguageId
  reloadTrigger: number
  isLocalFolderConnected: boolean
  localFolderName: string | null
  onFilesystemChange: (id: string) => void
  onPathChange: (path: string) => void
  onOpenFile: (entry: VFSEntry) => void
  onFileDeleted: (path: string) => void
  onFileRenamed: (oldPath: string, newPath: string) => void
  onError: (message: string) => void
  onChanged: () => void
  onConnectLocalFolder: () => void
  onReloadLocalFolder: () => void
  onDisconnectLocalFolder: () => void
  onLocalFolderSync: (op: LocalFolderSyncOp) => Promise<void>
}

interface ContextMenuState {
  x: number
  y: number
  entry: VFSEntry
}

export function FileSystemPanel(props: Props) {
  const {
    activeFilesystemId, currentPath, openFilePath, language, reloadTrigger,
    isLocalFolderConnected, localFolderName,
    onFilesystemChange, onPathChange, onOpenFile, onFileDeleted, onFileRenamed,
    onError, onChanged, onConnectLocalFolder, onReloadLocalFolder,
    onDisconnectLocalFolder, onLocalFolderSync,
  } = props

  const dialogs = useDialogs()
  const [filesystems, setFilesystems] = useState<VFSFilesystem[]>([])
  const [entries, setEntries] = useState<VFSEntry[]>([])
  const [menuOpen, setMenuOpen] = useState(false)
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [imagePreview, setImagePreview] = useState<{ url: string; name: string } | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)
  const uploadRef = useRef<HTMLInputElement>(null)
  const zipRef = useRef<HTMLInputElement>(null)

  const activeFilesystem = filesystems.find(f => f.id === activeFilesystemId) ?? null

  const reload = useCallback(async () => {
    try {
      const [list, children] = await Promise.all([
        listFilesystems(),
        listChildren(activeFilesystemId, currentPath),
      ])
      setFilesystems(list.sort((a, b) => a.createdAt - b.createdAt))
      setEntries(children.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'folder' ? -1 : 1
        return a.name.localeCompare(b.name, undefined, { numeric: true })
      }))
    } catch (error) {
      onError(String(error))
    }
  }, [activeFilesystemId, currentPath, onError])

  useEffect(() => { void reload() }, [reload, reloadTrigger])

  useEffect(() => {
    if (!menuOpen) return
    const close = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [menuOpen])

  useEffect(() => {
    if (!contextMenu) return
    const close = (event: MouseEvent) => {
      if (!contextMenuRef.current?.contains(event.target as Node)) setContextMenu(null)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setContextMenu(null)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', onKey)
    }
  }, [contextMenu])

  const breadcrumbs = (() => {
    const crumbs = [{ label: activeFilesystem?.name ?? 'Files', path: '/' }]
    if (currentPath === '/') return crumbs
    let accumulated = ''
    for (const part of currentPath.split('/').filter(Boolean)) {
      accumulated += '/' + part
      crumbs.push({ label: part, path: accumulated })
    }
    return crumbs
  })()

  const afterMutation = () => { void reload(); onChanged() }

  // ── Entry actions ───────────────────────────────────────────────────────

  const openEntry = async (entry: VFSEntry) => {
    if (entry.type === 'folder') { onPathChange(entry.path); return }
    const mime = entry.mimeType ?? guessMimeType(entry.name)
    if (isImageMime(mime) && entry.content) {
      setImagePreview({ url: URL.createObjectURL(new Blob([entry.content], { type: mime })), name: entry.name })
      return
    }
    if (isTextMime(mime) || mime === 'application/octet-stream') { onOpenFile(entry); return }
    onError(`"${entry.name}" is not a text file. Download it to view it.`)
  }

  const createNewFile = async () => {
    const name = await dialogs.prompt({
      title: 'New file',
      message: `Create a file in ${currentPath === '/' ? 'the root folder' : currentPath}.`,
      placeholder: 'Helpers.java',
      validate: (value) => (value ? null : 'Enter a file name.'),
    })
    if (!name) return
    try {
      if (await getEntryByPath(activeFilesystemId, joinPath(currentPath, name))) {
        onError(`"${name}" already exists here.`)
        return
      }
      const content = new ArrayBuffer(0)
      await createEntry(activeFilesystemId, currentPath, name, 'file', content, guessMimeType(name))
      if (isLocalFolderConnected) await onLocalFolderSync({ kind: 'write', path: joinPath(currentPath, name), content })
      afterMutation()
    } catch (error) {
      onError(String(error))
    }
  }

  const createNewFolder = async () => {
    const name = await dialogs.prompt({
      title: 'New folder',
      message: `Create a folder in ${currentPath === '/' ? 'the root folder' : currentPath}.`,
      placeholder: 'util',
      validate: (value) => (value ? null : 'Enter a folder name.'),
    })
    if (!name) return
    try {
      if (await getEntryByPath(activeFilesystemId, joinPath(currentPath, name))) {
        onError(`"${name}" already exists here.`)
        return
      }
      await createEntry(activeFilesystemId, currentPath, name, 'folder')
      if (isLocalFolderConnected) await onLocalFolderSync({ kind: 'mkdir', path: joinPath(currentPath, name) })
      afterMutation()
    } catch (error) {
      onError(String(error))
    }
  }

  const renameSelected = async (entry: VFSEntry) => {
    setContextMenu(null)
    const name = await dialogs.prompt({
      title: 'Rename',
      message: `Rename "${entry.name}" to:`,
      initialValue: entry.name,
      validate: (value) => (value ? null : 'Enter a name.'),
    })
    if (!name || name === entry.name) return
    try {
      await renameEntry(activeFilesystemId, entry.path, name)
      if (isLocalFolderConnected) await onLocalFolderSync({ kind: 'rename', path: entry.path, newName: name })
      onFileRenamed(entry.path, joinPath(entry.parentPath, name))
      afterMutation()
    } catch (error) {
      onError(String(error))
    }
  }

  const deleteSelected = async (entry: VFSEntry) => {
    setContextMenu(null)
    const confirmed = await dialogs.confirm({
      title: 'Delete',
      message: `Delete "${entry.name}"${entry.type === 'folder' ? ' and everything in it' : ''}?`,
      warning: isLocalFolderConnected
        ? 'This also deletes it from the connected folder on your computer.'
        : undefined,
      confirmLabel: 'Delete',
      destructive: true,
    })
    if (!confirmed) return
    try {
      await deleteEntry(activeFilesystemId, entry.path)
      if (isLocalFolderConnected) await onLocalFolderSync({ kind: 'delete', path: entry.path })
      onFileDeleted(entry.path)
      afterMutation()
    } catch (error) {
      onError(String(error))
    }
  }

  const downloadSelected = async (entry: VFSEntry) => {
    setContextMenu(null)
    try {
      if (entry.type === 'folder') {
        await downloadEntryAsZip(activeFilesystemId, entry.path, entry.name)
      } else if (entry.content) {
        downloadSingleFile(entry.content, entry.name, entry.mimeType ?? guessMimeType(entry.name))
      }
    } catch (error) {
      onError(String(error))
    }
  }

  const handleUpload = async (files: FileList | null) => {
    if (!files?.length) return
    try {
      for (const file of Array.from(files)) {
        const content = await file.arrayBuffer()
        const path = joinPath(currentPath, file.name)
        const existing = await getEntryByPath(activeFilesystemId, path)
        if (existing) {
          const replace = await dialogs.confirm({
            title: 'Replace file',
            message: `"${file.name}" already exists here. Replace it?`,
            confirmLabel: 'Replace',
          })
          if (!replace) continue
          await deleteEntry(activeFilesystemId, path)
        }
        await createEntry(activeFilesystemId, currentPath, file.name, 'file', content, guessMimeType(file.name))
        if (isLocalFolderConnected) await onLocalFolderSync({ kind: 'write', path, content })
      }
      afterMutation()
    } catch (error) {
      onError(String(error))
    }
  }

  // ── Filesystem actions ──────────────────────────────────────────────────

  const newFilesystem = async () => {
    setMenuOpen(false)
    const name = await dialogs.prompt({
      title: 'New filesystem',
      message: 'A filesystem is a separate project workspace with its own files.',
      placeholder: 'Coursework',
      validate: (value) => (value ? null : 'Enter a name.'),
    })
    if (!name) return
    try {
      const created = await createFilesystem(name, { seedLanguage: language })
      onFilesystemChange(created.id)
      afterMutation()
    } catch (error) {
      onError(String(error))
    }
  }

  const renameCurrentFilesystem = async () => {
    setMenuOpen(false)
    if (!activeFilesystem) return
    if (activeFilesystem.id === DEFAULT_FS_ID) { onError('The default filesystem cannot be renamed.'); return }
    const name = await dialogs.prompt({
      title: 'Rename filesystem',
      message: 'New name:',
      initialValue: activeFilesystem.name,
      validate: (value) => (value ? null : 'Enter a name.'),
    })
    if (!name) return
    try {
      await renameFilesystem(activeFilesystem.id, name)
      afterMutation()
    } catch (error) {
      onError(String(error))
    }
  }

  const deleteCurrentFilesystem = async () => {
    setMenuOpen(false)
    if (!activeFilesystem) return
    if (activeFilesystem.id === DEFAULT_FS_ID) { onError('The default filesystem cannot be deleted.'); return }
    const confirmed = await dialogs.confirm({
      title: 'Delete filesystem',
      message: `Delete "${activeFilesystem.name}" and all of its files?`,
      warning: 'This cannot be undone. Files on your computer are not affected.',
      confirmLabel: 'Delete',
      destructive: true,
    })
    if (!confirmed) return
    try {
      await deleteFilesystem(activeFilesystem.id)
      onFilesystemChange(DEFAULT_FS_ID)
      afterMutation()
    } catch (error) {
      onError(String(error))
    }
  }

  const importZip = async (files: FileList | null) => {
    if (!files?.length) return
    try {
      const file = files[0]
      const created = await createFilesystem(file.name.replace(/\.zip$/i, ''))
      await importZipToFs(created.id, await file.arrayBuffer())
      onFilesystemChange(created.id)
      afterMutation()
    } catch (error) {
      onError(String(error))
    }
  }

  return (
    <aside className="flex h-full min-h-0 flex-col rounded-xl border border-slate-700 bg-slate-900/60">
      <header className="relative flex items-center gap-1 border-b border-slate-700 px-2 py-1.5" ref={menuRef}>
        <button
          type="button"
          onClick={() => setMenuOpen(v => !v)}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-sm font-medium text-slate-200 hover:bg-slate-700/60"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0">
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          </svg>
          <span className="truncate">{activeFilesystem?.name ?? 'Files'}</span>
          {isLocalFolderConnected && (
            <span
              title={`Synced with the folder "${localFolderName ?? ''}" on your computer`}
              className="shrink-0 rounded bg-emerald-500/10 px-1 text-[10px] font-normal text-emerald-300"
            >
              linked
            </span>
          )}
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="ml-auto shrink-0">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>

        {menuOpen && (
          <div className="absolute left-2 top-full z-30 mt-1 w-64 overflow-hidden rounded-lg border border-slate-600 bg-slate-800 py-1 shadow-xl">
            <p className="px-3 py-1 text-[10px] uppercase tracking-wide text-slate-500">Filesystems</p>
            {filesystems.map(fs => (
              <button
                key={fs.id}
                type="button"
                onClick={() => { onFilesystemChange(fs.id); setMenuOpen(false) }}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-slate-700 ${
                  fs.id === activeFilesystemId ? 'text-emerald-300' : 'text-slate-200'
                }`}
              >
                <span className="w-3">{fs.id === activeFilesystemId ? '•' : ''}</span>
                <span className="truncate">{fs.name}</span>
              </button>
            ))}
            <div className="my-1 border-t border-slate-700" />
            <MenuItem onClick={newFilesystem}>New filesystem…</MenuItem>
            <MenuItem onClick={renameCurrentFilesystem} disabled={activeFilesystemId === DEFAULT_FS_ID}>Rename this filesystem…</MenuItem>
            <MenuItem onClick={deleteCurrentFilesystem} disabled={activeFilesystemId === DEFAULT_FS_ID}>Delete this filesystem…</MenuItem>
            <div className="my-1 border-t border-slate-700" />
            <MenuItem onClick={() => { setMenuOpen(false); zipRef.current?.click() }}>Import a .zip as a filesystem…</MenuItem>
            <MenuItem onClick={() => { setMenuOpen(false); void downloadEntryAsZip(activeFilesystemId, '/', activeFilesystem?.name ?? 'files') }}>
              Download everything as .zip
            </MenuItem>
            <div className="my-1 border-t border-slate-700" />
            {isLocalFolderConnected ? (
              <>
                <MenuItem onClick={() => { setMenuOpen(false); onReloadLocalFolder() }}>Reload from the connected folder</MenuItem>
                <MenuItem onClick={() => { setMenuOpen(false); onDisconnectLocalFolder() }}>Disconnect the folder</MenuItem>
              </>
            ) : (
              <MenuItem onClick={() => { setMenuOpen(false); onConnectLocalFolder() }}>Connect a folder on this computer…</MenuItem>
            )}
          </div>
        )}
      </header>

      <div className="flex items-center gap-1 border-b border-slate-700 px-2 py-1">
        <IconButton label="New file" onClick={createNewFile} className="!h-7 !w-7">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" />
          </svg>
        </IconButton>
        <IconButton label="New folder" onClick={createNewFolder} className="!h-7 !w-7">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><path d="M12 11v6M9 14h6" />
          </svg>
        </IconButton>
        <IconButton label="Upload files into this folder" onClick={() => uploadRef.current?.click()} className="!h-7 !w-7">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M12 17V4M7 9l5-5 5 5M4 20h16" />
          </svg>
        </IconButton>
        <IconButton label="Download this folder as .zip" onClick={() => void downloadEntryAsZip(activeFilesystemId, currentPath, currentPath === '/' ? (activeFilesystem?.name ?? 'files') : currentPath.split('/').pop()!)} className="!h-7 !w-7">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M12 4v13M7 12l5 5 5-5M4 20h16" />
          </svg>
        </IconButton>
      </div>

      <nav className="flex flex-wrap items-center gap-0.5 border-b border-slate-700 px-2 py-1 text-xs text-slate-400">
        {breadcrumbs.map((crumb, index) => (
          <span key={crumb.path} className="flex items-center gap-0.5">
            {index > 0 && <span className="text-slate-600">/</span>}
            <button
              type="button"
              onClick={() => onPathChange(crumb.path)}
              className="max-w-[10rem] truncate rounded px-1 hover:bg-slate-700/60 hover:text-slate-100"
            >
              {crumb.label}
            </button>
          </span>
        ))}
      </nav>

      <ul className="min-h-0 flex-1 overflow-auto py-1">
        {currentPath !== '/' && (
          <li>
            <button
              type="button"
              onClick={() => onPathChange(parentOf(currentPath))}
              className="flex w-full items-center gap-2 px-3 py-1 text-left text-[13px] text-slate-400 hover:bg-slate-700/60"
            >
              <span className="w-4 text-center">↰</span>..
            </button>
          </li>
        )}
        {entries.length === 0 && currentPath === '/' && (
          <li className="px-3 py-2 text-xs text-slate-500">This filesystem is empty.</li>
        )}
        {entries.map(entry => (
          <li key={entry.id}>
            <button
              type="button"
              onClick={() => void openEntry(entry)}
              onContextMenu={(event) => {
                event.preventDefault()
                setContextMenu({ x: event.clientX, y: event.clientY, entry })
              }}
              className={`flex w-full items-center gap-2 px-3 py-1 text-left text-[13px] hover:bg-slate-700/60 ${
                entry.path === openFilePath ? 'bg-emerald-500/10 text-emerald-300' : 'text-slate-200'
              }`}
            >
              <span className="w-4 shrink-0 text-center text-slate-500">
                {entry.type === 'folder' ? '▸' : '·'}
              </span>
              <span className="truncate">{entry.name}</span>
            </button>
          </li>
        ))}
      </ul>

      {contextMenu && (
        <div
          ref={contextMenuRef}
          role="menu"
          aria-label={`Actions for ${contextMenu.entry.name}`}
          className="fixed z-40 w-44 overflow-hidden rounded-lg border border-slate-600 bg-slate-800 py-1 shadow-xl"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <MenuItem onClick={() => void renameSelected(contextMenu.entry)}>Rename…</MenuItem>
          <MenuItem onClick={() => void downloadSelected(contextMenu.entry)}>Download</MenuItem>
          <MenuItem onClick={() => void deleteSelected(contextMenu.entry)}>Delete…</MenuItem>
        </div>
      )}

      {imagePreview && (
        <div className="modal-backdrop" onMouseDown={() => { URL.revokeObjectURL(imagePreview.url); setImagePreview(null) }}>
          <div className="modal-card" onMouseDown={(e) => e.stopPropagation()}>
            <p className="mb-2 text-sm text-slate-300">{imagePreview.name}</p>
            <img src={imagePreview.url} alt={imagePreview.name} className="max-h-[60vh] w-full object-contain" />
          </div>
        </div>
      )}

      <input ref={uploadRef} type="file" multiple hidden onChange={(e) => { void handleUpload(e.target.files); e.target.value = '' }} />
      <input ref={zipRef} type="file" accept=".zip" hidden onChange={(e) => { void importZip(e.target.files); e.target.value = '' }} />
    </aside>
  )
}

function MenuItem({ onClick, disabled, children }: { onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="block w-full px-3 py-1.5 text-left text-sm text-slate-200 hover:bg-slate-700 disabled:opacity-40 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  )
}

function joinPath(parent: string, name: string): string {
  return parent === '/' ? `/${name}` : `${parent}/${name}`
}

function parentOf(path: string): string {
  const index = path.lastIndexOf('/')
  return index <= 0 ? '/' : path.substring(0, index)
}
