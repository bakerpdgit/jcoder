// File System Access API helpers for mirroring VFS mutations onto a connected
// local OS folder. These are pure functions over a FileSystemDirectoryHandle —
// no React state — so they can be called from anywhere that changes the
// filesystem, and unit tested against a stub handle.

export async function readDirectoryToMap(handle: FileSystemDirectoryHandle, prefix = ''): Promise<Map<string, ArrayBuffer>> {
  const map = new Map<string, ArrayBuffer>()
  for await (const [name, entry] of handle as unknown as AsyncIterable<[string, FileSystemHandle]>) {
    const relPath = prefix ? `${prefix}/${name}` : name
    if (entry.kind === 'directory') {
      const sub = await readDirectoryToMap(entry as FileSystemDirectoryHandle, relPath)
      for (const [k, v] of sub) map.set(k, v)
    } else {
      const file = await (entry as FileSystemFileHandle).getFile()
      map.set(relPath, await file.arrayBuffer())
    }
  }
  return map
}

export async function writeFileToFolderHandle(root: FileSystemDirectoryHandle, vfsPath: string, content: ArrayBuffer): Promise<void> {
  const parts = vfsPath.replace(/^\//, '').split('/')
  const filename = parts.pop()!
  let dir = root
  for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true })
  const fh = await dir.getFileHandle(filename, { create: true })
  const w = await fh.createWritable()
  await w.write(content)
  await w.close()
}

// Resolve the parent directory handle for a VFS path, returning the final segment name.
async function resolveParentDir(root: FileSystemDirectoryHandle, vfsPath: string, create: boolean): Promise<{ dir: FileSystemDirectoryHandle; name: string }> {
  const parts = vfsPath.replace(/^\//, '').split('/')
  const name = parts.pop()!
  let dir = root
  for (const part of parts) dir = await dir.getDirectoryHandle(part, { create })
  return { dir, name }
}

export async function mkdirInFolderHandle(root: FileSystemDirectoryHandle, vfsPath: string): Promise<void> {
  const parts = vfsPath.replace(/^\//, '').split('/').filter(Boolean)
  let dir = root
  for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true })
}

export async function deleteFromFolderHandle(root: FileSystemDirectoryHandle, vfsPath: string): Promise<void> {
  const { dir, name } = await resolveParentDir(root, vfsPath, false)
  await dir.removeEntry(name, { recursive: true })
}

async function copyDirContents(src: FileSystemDirectoryHandle, dst: FileSystemDirectoryHandle): Promise<void> {
  for await (const [name, entry] of src as unknown as AsyncIterable<[string, FileSystemHandle]>) {
    if (entry.kind === 'directory') {
      const sub = await dst.getDirectoryHandle(name, { create: true })
      await copyDirContents(entry as FileSystemDirectoryHandle, sub)
    } else {
      const buf = await (await (entry as FileSystemFileHandle).getFile()).arrayBuffer()
      const fh = await dst.getFileHandle(name, { create: true })
      const w = await fh.createWritable()
      await w.write(buf)
      await w.close()
    }
  }
}

export async function renameInFolderHandle(root: FileSystemDirectoryHandle, oldPath: string, newName: string): Promise<void> {
  const { dir, name } = await resolveParentDir(root, oldPath, false)
  let handle: FileSystemHandle
  try { handle = await dir.getFileHandle(name) }
  catch { handle = await dir.getDirectoryHandle(name) }
  // Prefer the native in-place rename where available (Chromium).
  const movable = handle as FileSystemHandle & { move?: (name: string) => Promise<void> }
  if (typeof movable.move === 'function') { await movable.move(newName); return }
  // Fallback: copy to the new name, then remove the original.
  if (handle.kind === 'file') {
    const buf = await (await (handle as FileSystemFileHandle).getFile()).arrayBuffer()
    const fh = await dir.getFileHandle(newName, { create: true })
    const w = await fh.createWritable()
    await w.write(buf)
    await w.close()
    await dir.removeEntry(name)
  } else {
    const newDir = await dir.getDirectoryHandle(newName, { create: true })
    await copyDirContents(handle as FileSystemDirectoryHandle, newDir)
    await dir.removeEntry(name, { recursive: true })
  }
}
