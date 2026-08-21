// Type augmentations for File System Access API members not yet in all TypeScript DOM lib versions
interface FileSystemHandle {
  queryPermission(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>
  requestPermission(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>
  // Chromium-only in-place rename/move. Optional: not implemented everywhere.
  move?(newName: string): Promise<void>
}

interface FileSystemDirectoryHandle {
  [Symbol.asyncIterator](): AsyncIterator<[string, FileSystemHandle]>
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>
  keys(): AsyncIterableIterator<string>
  values(): AsyncIterableIterator<FileSystemHandle>
}
