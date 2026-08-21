/**
 * The host half of the file emulation described in `utils/javaFileSystem`.
 *
 * A run is handed a *snapshot* of the editor's files. Everything the program
 * reads or writes is answered from that snapshot immediately — no thread ever
 * blocks for a file, unlike console input — and `changedFiles()` afterwards
 * reports what to write back to the editor.
 *
 * Files are held as bytes, which is what they are. Text reads and writes decode
 * and encode UTF-8 at the edge; binary reads and writes hand the bytes over
 * unchanged, one per character on the wire. The channel carries any code unit
 * from 0 to 65535 without alteration — measured, not assumed — so a byte in
 * 0…255 crosses it untouched.
 *
 * Folders are implied by paths rather than stored, except for ones the program
 * creates that are still empty, which are remembered so `exists()` can answer
 * for them.
 */

export interface FileSnapshot {
  path: string
  bytes: Uint8Array
}

export interface FileChange {
  path: string
  /** Null when the program deleted the file. */
  bytes: Uint8Array | null
}

/** Answered to the program when a file or folder is not there. */
export const ABSENT = null

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function normalisePath(path: string): string {
  let p = path.replace(/\\/g, '/')
  while (p.startsWith('./')) p = p.slice(2)
  if (!p.startsWith('/')) p = `/${p}`
  p = p.replace(/\/{2,}/g, '/')
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1)
  return p
}

function parentsOf(path: string): string[] {
  const parts = path.split('/').filter(Boolean)
  const parents: string[] = []
  let accumulated = ''
  for (let i = 0; i < parts.length - 1; i++) {
    accumulated += `/${parts[i]}`
    parents.push(accumulated)
  }
  return parents
}

/** Bytes → the string that carries them, one character per byte. */
export function bytesToWire(bytes: Uint8Array): string {
  // Built in chunks: String.fromCharCode(...all) overflows the argument limit
  // on anything large, which a binary file certainly is.
  let wire = ''
  const chunk = 8192
  for (let i = 0; i < bytes.length; i += chunk) {
    wire += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return wire
}

/** The inverse. Anything above 255 would not have been sent by the program. */
export function wireToBytes(wire: string): Uint8Array {
  const bytes = new Uint8Array(wire.length)
  for (let i = 0; i < wire.length; i++) bytes[i] = wire.charCodeAt(i) & 0xff
  return bytes
}

export class FileBridge {
  private readonly files = new Map<string, Uint8Array>()
  private readonly folders = new Set<string>(['/'])
  /** Paths the program created, changed or removed. */
  private readonly touched = new Set<string>()

  constructor(snapshot: FileSnapshot[]) {
    for (const file of snapshot) {
      const path = normalisePath(file.path)
      this.files.set(path, file.bytes)
      for (const folder of parentsOf(path)) this.folders.add(folder)
    }
  }

  /** What the program changed, for writing back to the editor. */
  changedFiles(): FileChange[] {
    return [...this.touched].sort().map(path => ({
      path,
      bytes: this.files.get(path) ?? null,
    }))
  }

  /** Folders the program created that hold no file, so are otherwise invisible. */
  createdFolders(): string[] {
    return [...this.folders]
      .filter(folder => folder !== '/' && !this.hasChildren(folder))
      .sort()
  }

  private hasChildren(folder: string): boolean {
    const prefix = `${folder}/`
    for (const path of this.files.keys()) if (path.startsWith(prefix)) return true
    return false
  }

  /**
   * Runs one command from the program.
   *
   * The two writes are handled by the caller, because their content arrives
   * after the command line rather than in it.
   */
  execute(command: string): string | null {
    const space = command.indexOf(' ')
    const verb = space < 0 ? command : command.slice(0, space)
    const argument = space < 0 ? '' : command.slice(space + 1)

    switch (verb) {
      case 'R': return this.read(normalisePath(argument))
      case 'B': return this.readBytesAsWire(normalisePath(argument))
      case 'S': return this.stat(normalisePath(argument))
      case 'L': return this.list(normalisePath(argument))
      case 'D': return this.delete(normalisePath(argument))
      case 'M': return this.makeDirectories(normalisePath(argument))
      default: return ABSENT
    }
  }

  /** The file as text. */
  read(path: string): string | null {
    const bytes = this.files.get(path)
    return bytes === undefined ? ABSENT : decoder.decode(bytes)
  }

  readBytes(path: string): Uint8Array | null {
    return this.files.get(path) ?? ABSENT
  }

  private readBytesAsWire(path: string): string | null {
    const bytes = this.files.get(path)
    return bytes === undefined ? ABSENT : bytesToWire(bytes)
  }

  stat(path: string): string | null {
    const bytes = this.files.get(path)
    if (bytes !== undefined) return `f${bytes.length}`
    return this.folders.has(path) ? 'd' : ABSENT
  }

  list(path: string): string | null {
    if (!this.folders.has(path)) return ABSENT
    const prefix = path === '/' ? '/' : `${path}/`
    const names = new Set<string>()
    for (const candidate of [...this.files.keys(), ...this.folders]) {
      if (candidate === path || !candidate.startsWith(prefix)) continue
      names.add(candidate.slice(prefix.length).split('/')[0])
    }
    return [...names].sort().join('\n')
  }

  delete(path: string): string | null {
    if (this.files.delete(path)) {
      this.touched.add(path)
      return 'ok'
    }
    // Only an empty folder can go, which is what java.io.File does too.
    if (this.folders.has(path) && path !== '/' && !this.hasChildren(path)) {
      this.folders.delete(path)
      return 'ok'
    }
    return ABSENT
  }

  makeDirectories(path: string): string {
    this.folders.add(path)
    for (const folder of parentsOf(`${path}/x`)) this.folders.add(folder)
    return 'ok'
  }

  /** Replaces a file with text, encoded as UTF-8. */
  write(path: string, text: string): string {
    return this.store(path, encoder.encode(text))
  }

  /** Replaces a file with the bytes carried by `wire`. */
  writeBytes(path: string, wire: string): string {
    return this.store(path, wireToBytes(wire))
  }

  private store(path: string, bytes: Uint8Array): string {
    const normalised = normalisePath(path)
    this.files.set(normalised, bytes)
    this.touched.add(normalised)
    for (const folder of parentsOf(normalised)) this.folders.add(folder)
    return 'ok'
  }
}
