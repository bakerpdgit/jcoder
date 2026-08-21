import type { LanguageId, VFSEntry, VFSFile, VFSFilesystem } from '../types'
import { LANGUAGES, compileExtensions } from './languages'

const DB_NAME = 'jcoder-vfs'
const DB_VERSION = 1

export const DEFAULT_FS_ID = 'default'

let dbPromise: Promise<IDBDatabase> | null = null

function openVFSDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result
      if (!db.objectStoreNames.contains('filesystems')) {
        db.createObjectStore('filesystems', { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains('entries')) {
        const store = db.createObjectStore('entries', { keyPath: 'id' })
        store.createIndex('byFsAndParent', ['fsId', 'parentPath'], { unique: false })
        store.createIndex('byFsAndPath', ['fsId', 'path'], { unique: true })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

/** Test hook — drops the cached connection so a fresh fake IndexedDB is picked up. */
export function _resetDbForTests(): void {
  dbPromise = null
}

export function getParentPath(path: string): string {
  const idx = path.lastIndexOf('/')
  if (idx <= 0) return '/'
  return path.substring(0, idx)
}

export function basename(path: string): string {
  return path.substring(path.lastIndexOf('/') + 1)
}

function idbGet<T>(store: IDBObjectStore | IDBIndex, key: IDBValidKey | IDBKeyRange): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const req = store.get(key)
    req.onsuccess = () => resolve((req.result as T) ?? null)
    req.onerror = () => reject(req.error)
  })
}

function idbGetAll<T>(store: IDBObjectStore | IDBIndex, query?: IDBValidKey | IDBKeyRange): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const req = query !== undefined ? store.getAll(query) : store.getAll()
    req.onsuccess = () => resolve(req.result as T[])
    req.onerror = () => reject(req.error)
  })
}

function idbPut(store: IDBObjectStore, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = store.put(value)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
}

function idbAdd(store: IDBObjectStore, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = store.add(value)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
}

function idbDelete(store: IDBObjectStore, key: IDBValidKey): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = store.delete(key)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
}

// ── Filesystems ────────────────────────────────────────────────────────────

export async function ensureDefaultFilesystem(language: LanguageId): Promise<void> {
  const db = await openVFSDb()
  const t = db.transaction('filesystems', 'readwrite')
  const store = t.objectStore('filesystems')
  const existing = await idbGet<VFSFilesystem>(store, DEFAULT_FS_ID)
  if (!existing) {
    await idbAdd(store, { id: DEFAULT_FS_ID, name: 'Default', createdAt: Date.now() })
  }
  await ensureLanguageEntryPoint(DEFAULT_FS_ID, language)
}

/**
 * Make sure the filesystem has at least one source file, so the editor always
 * has something to show. Returns the path of the file to open, or null when the
 * filesystem already had sources.
 */
export async function ensureLanguageEntryPoint(fsId: string, language: LanguageId): Promise<string | null> {
  const lang = LANGUAGES[language]
  const existing = await getSourceFiles(fsId, language)
  if (existing.length > 0) return null
  const path = `/${lang.defaultFileName}`
  const already = await getEntryByPath(fsId, path)
  if (already) return path
  const content = new TextEncoder().encode(lang.template).buffer as ArrayBuffer
  await createEntry(fsId, '/', lang.defaultFileName, 'file', content, guessMimeType(lang.defaultFileName))
  return path
}

export async function listFilesystems(): Promise<VFSFilesystem[]> {
  const db = await openVFSDb()
  const store = db.transaction('filesystems', 'readonly').objectStore('filesystems')
  return idbGetAll<VFSFilesystem>(store)
}

export async function createFilesystem(name: string, opts?: { seedLanguage?: LanguageId }): Promise<VFSFilesystem> {
  const db = await openVFSDb()
  const fs: VFSFilesystem = { id: crypto.randomUUID(), name, createdAt: Date.now() }
  const store = db.transaction('filesystems', 'readwrite').objectStore('filesystems')
  await idbAdd(store, fs)
  if (opts?.seedLanguage) await ensureLanguageEntryPoint(fs.id, opts.seedLanguage)
  return fs
}

export async function renameFilesystem(id: string, newName: string): Promise<void> {
  if (id === DEFAULT_FS_ID) throw new Error('Cannot rename the default filesystem.')
  const db = await openVFSDb()
  const store = db.transaction('filesystems', 'readwrite').objectStore('filesystems')
  const existing = await idbGet<VFSFilesystem>(store, id)
  if (!existing) throw new Error('Filesystem not found.')
  await idbPut(store, { ...existing, name: newName })
}

export async function deleteFilesystem(id: string): Promise<void> {
  if (id === DEFAULT_FS_ID) throw new Error('Cannot delete the default filesystem.')
  const db = await openVFSDb()
  const allEntries = await getAllEntries(id)
  const t = db.transaction(['filesystems', 'entries'], 'readwrite')
  const fsStore = t.objectStore('filesystems')
  const entryStore = t.objectStore('entries')
  await Promise.all([
    idbDelete(fsStore, id),
    ...allEntries.map(e => idbDelete(entryStore, e.id)),
  ])
}

// ── Entries ────────────────────────────────────────────────────────────────

export async function listChildren(fsId: string, parentPath: string): Promise<VFSEntry[]> {
  const db = await openVFSDb()
  const index = db.transaction('entries', 'readonly').objectStore('entries').index('byFsAndParent')
  return idbGetAll<VFSEntry>(index, [fsId, parentPath])
}

export async function getEntryByPath(fsId: string, path: string): Promise<VFSEntry | null> {
  const db = await openVFSDb()
  const index = db.transaction('entries', 'readonly').objectStore('entries').index('byFsAndPath')
  return idbGet<VFSEntry>(index, [fsId, path])
}

export async function createEntry(
  fsId: string,
  parentPath: string,
  name: string,
  type: 'file' | 'folder',
  content?: ArrayBuffer,
  mimeType?: string,
): Promise<VFSEntry> {
  const path = parentPath === '/' ? `/${name}` : `${parentPath}/${name}`
  const entry: VFSEntry = {
    id: crypto.randomUUID(), fsId, parentPath, path, name, type,
    content, mimeType, size: content?.byteLength, modifiedAt: Date.now(),
  }
  const db = await openVFSDb()
  await idbAdd(db.transaction('entries', 'readwrite').objectStore('entries'), entry)
  return entry
}

export async function writeFile(fsId: string, path: string, content: ArrayBuffer, mimeType?: string): Promise<void> {
  const db = await openVFSDb()
  const t = db.transaction('entries', 'readwrite')
  const store = t.objectStore('entries')
  const existing = await idbGet<VFSEntry>(store.index('byFsAndPath'), [fsId, path])
  if (existing) {
    await idbPut(store, {
      ...existing,
      content,
      mimeType: mimeType ?? existing.mimeType,
      size: content.byteLength,
      modifiedAt: Date.now(),
    })
    return
  }
  await idbAdd(store, {
    id: crypto.randomUUID(),
    fsId,
    parentPath: getParentPath(path),
    path,
    name: basename(path),
    type: 'file',
    content,
    mimeType: mimeType ?? guessMimeType(basename(path)),
    size: content.byteLength,
    modifiedAt: Date.now(),
  })
}

export async function getAllEntries(fsId: string): Promise<VFSEntry[]> {
  const db = await openVFSDb()
  return new Promise((resolve, reject) => {
    const store = db.transaction('entries', 'readonly').objectStore('entries')
    const cursor = store.openCursor()
    const results: VFSEntry[] = []
    cursor.onsuccess = () => {
      const c = cursor.result
      if (c) {
        if ((c.value as VFSEntry).fsId === fsId) results.push(c.value as VFSEntry)
        c.continue()
      } else {
        resolve(results)
      }
    }
    cursor.onerror = () => reject(cursor.error)
  })
}

export async function renameEntry(fsId: string, path: string, newName: string): Promise<void> {
  const db = await openVFSDb()
  const allEntries = await getAllEntries(fsId)
  const entry = allEntries.find(e => e.path === path)
  if (!entry) throw new Error('Entry not found')
  const parentPath = getParentPath(path)
  const newPath = parentPath === '/' ? `/${newName}` : `${parentPath}/${newName}`
  if (allEntries.some(e => e.path === newPath)) throw new Error(`"${newName}" already exists here.`)
  const store = db.transaction('entries', 'readwrite').objectStore('entries')
  const updates: VFSEntry[] = [{ ...entry, path: newPath, name: newName, modifiedAt: Date.now() }]
  if (entry.type === 'folder') {
    for (const desc of allEntries.filter(e => e.path.startsWith(path + '/'))) {
      const newDescPath = newPath + desc.path.substring(path.length)
      const newDescParent = desc.parentPath === path
        ? newPath
        : desc.parentPath.startsWith(path + '/')
          ? newPath + desc.parentPath.substring(path.length)
          : desc.parentPath
      updates.push({ ...desc, path: newDescPath, parentPath: newDescParent, modifiedAt: Date.now() })
    }
  }
  await Promise.all(updates.map(u => idbPut(store, u)))
}

export async function deleteEntry(fsId: string, path: string): Promise<void> {
  const db = await openVFSDb()
  const allEntries = await getAllEntries(fsId)
  const toDelete = allEntries.filter(e => e.path === path || e.path.startsWith(path + '/'))
  const store = db.transaction('entries', 'readwrite').objectStore('entries')
  await Promise.all(toDelete.map(e => idbDelete(store, e.id)))
}

export async function getAllFiles(fsId: string): Promise<VFSFile[]> {
  const entries = await getAllEntries(fsId)
  return entries
    .filter(e => e.type === 'file' && e.content !== undefined)
    .map(e => ({ path: e.path, content: e.content!, mimeType: e.mimeType ?? 'text/plain' }))
}

/**
 * Every source file in `fsId`, sorted by path so a compilation is
 * deterministic. This is what gets handed to javac — the whole filesystem is
 * the project, so students can split code across files and packages without
 * any build file.
 */
export async function getSourceFiles(fsId: string, language: LanguageId): Promise<Array<{ path: string; text: string }>> {
  const exts = compileExtensions(language)
  const entries = await getAllEntries(fsId)
  const decoder = new TextDecoder()
  return entries
    .filter(e => e.type === 'file' && e.content !== undefined && exts.some(ext => e.name.toLowerCase().endsWith(ext)))
    .sort((a, b) => a.path.localeCompare(b.path))
    .map(e => ({ path: e.path, text: decoder.decode(e.content!) }))
}

// ── MIME helpers ───────────────────────────────────────────────────────────

export function guessMimeType(filename: string): string {
  const ext = filename.toLowerCase().split('.').pop() ?? ''
  const map: Record<string, string> = {
    java: 'text/x-java-source', kt: 'text/x-kotlin', jar: 'application/java-archive',
    properties: 'text/plain', gradle: 'text/plain', xml: 'application/xml',
    txt: 'text/plain', js: 'text/javascript', mjs: 'text/javascript',
    ts: 'text/typescript', html: 'text/html', htm: 'text/html', css: 'text/css',
    json: 'application/json', csv: 'text/csv', md: 'text/markdown',
    yml: 'text/yaml', yaml: 'text/yaml', sql: 'text/plain', log: 'text/plain',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp',
    mp3: 'audio/mpeg', wav: 'audio/wav', pdf: 'application/pdf',
  }
  return map[ext] ?? 'application/octet-stream'
}

export function isTextMime(mimeType: string): boolean {
  return mimeType.startsWith('text/') || mimeType === 'application/json' || mimeType === 'application/xml'
}

export function isImageMime(mimeType: string): boolean {
  return mimeType.startsWith('image/')
}

// ── Download / import ──────────────────────────────────────────────────────

export function downloadSingleFile(content: ArrayBuffer, filename: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

export async function downloadEntryAsZip(fsId: string, entryPath: string, zipName: string): Promise<void> {
  const { default: JSZip } = await import('jszip')
  const allFiles = await getAllFiles(fsId)
  const zip = new JSZip()
  const prefix = entryPath === '/' ? '' : entryPath
  const files = entryPath === '/'
    ? allFiles
    : allFiles.filter(f => f.path.startsWith(prefix + '/') || f.path === entryPath)
  for (const file of files) {
    const rel = prefix ? file.path.substring(prefix.length + 1) : file.path.substring(1)
    if (rel) zip.file(rel, file.content)
  }
  const blob = await zip.generateAsync({ type: 'blob' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${zipName}.zip`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

/** Create every missing folder along `parentPath`. */
export async function ensureFolders(fsId: string, parentPath: string): Promise<void> {
  if (parentPath === '/') return
  const parts = parentPath.split('/').filter(Boolean)
  let acc = ''
  for (const part of parts) {
    acc += '/' + part
    if (!(await getEntryByPath(fsId, acc))) {
      await createEntry(fsId, getParentPath(acc), part, 'folder')
    }
  }
}

export async function importFileMapToFs(
  fsId: string,
  fileMap: Map<string, ArrayBuffer>,
  overwrite = true,
): Promise<void> {
  for (const [rawPath, content] of fileMap) {
    const cleanPath = '/' + rawPath.replace(/^\//, '')
    const parentPath = getParentPath(cleanPath)
    const name = basename(cleanPath)
    if (!name) continue
    await ensureFolders(fsId, parentPath)
    const mime = guessMimeType(name)
    if (overwrite) {
      await writeFile(fsId, cleanPath, content, mime)
    } else if (!(await getEntryByPath(fsId, cleanPath))) {
      await createEntry(fsId, parentPath, name, 'file', content, mime)
    }
  }
}

function detectCommonPrefix(filenames: string[]): string {
  if (filenames.length === 0) return ''
  if (filenames.some(f => !f.includes('/'))) return ''
  const firstSlash = filenames[0].indexOf('/')
  if (firstSlash < 0) return ''
  const candidate = filenames[0].substring(0, firstSlash + 1)
  return filenames.every(f => f.startsWith(candidate)) ? candidate : ''
}

/** Unpack a .zip into `fsId`, stripping a single common top-level folder. */
export async function importZipToFs(fsId: string, buffer: ArrayBuffer): Promise<void> {
  const { default: JSZip } = await import('jszip')
  const zip = await JSZip.loadAsync(buffer)
  const allNames = Object.keys(zip.files).filter(n => !zip.files[n].dir && !n.startsWith('__MACOSX'))
  const prefix = detectCommonPrefix(allNames)
  const fileMap = new Map<string, ArrayBuffer>()
  for (const name of allNames) {
    const stripped = prefix ? name.slice(prefix.length) : name
    if (!stripped) continue
    fileMap.set(stripped, await zip.files[name].async('arraybuffer'))
  }
  await importFileMapToFs(fsId, fileMap)
}
