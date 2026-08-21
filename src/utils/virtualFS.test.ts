import { beforeEach, describe, expect, it } from 'vitest'
import { IDBFactory as FakeIndexedDBFactory } from 'fake-indexeddb'
import {
  DEFAULT_FS_ID, _resetDbForTests, createEntry, createFilesystem, deleteEntry,
  deleteFilesystem, ensureDefaultFilesystem, ensureLanguageEntryPoint, getAllEntries,
  getEntryByPath, getSourceFiles, guessMimeType, importFileMapToFs, listChildren,
  listFilesystems, renameEntry, writeFile,
} from './virtualFS'

const encoder = new TextEncoder()
const text = (value: string) => encoder.encode(value).buffer as ArrayBuffer

beforeEach(() => {
  // fake-indexeddb keeps state between tests; a new factory is a clean disk.
  globalThis.indexedDB = new FakeIndexedDBFactory()
  _resetDbForTests()
})

describe('filesystems', () => {
  it('creates a default filesystem with a starter file', async () => {
    await ensureDefaultFilesystem('java')
    expect((await listFilesystems()).map(f => f.id)).toContain(DEFAULT_FS_ID)
    expect(await getEntryByPath(DEFAULT_FS_ID, '/Main.java')).not.toBeNull()
  })

  it('does not overwrite an existing starter file', async () => {
    await ensureDefaultFilesystem('java')
    await writeFile(DEFAULT_FS_ID, '/Main.java', text('public class Main { }'))
    await ensureLanguageEntryPoint(DEFAULT_FS_ID, 'java')
    const sources = await getSourceFiles(DEFAULT_FS_ID, 'java')
    expect(sources[0].text).toBe('public class Main { }')
  })

  it('refuses to delete the default filesystem', async () => {
    await ensureDefaultFilesystem('java')
    await expect(deleteFilesystem(DEFAULT_FS_ID)).rejects.toThrow()
  })

  it('keeps filesystems isolated from one another', async () => {
    const a = await createFilesystem('A', { seedLanguage: 'java' })
    const b = await createFilesystem('B')
    await writeFile(a.id, '/Only.java', text('class Only {}'))
    expect(await getEntryByPath(b.id, '/Only.java')).toBeNull()
    expect(await getSourceFiles(b.id, 'java')).toEqual([])
  })
})

describe('entries', () => {
  it('lists only the children of the requested folder', async () => {
    const fs = await createFilesystem('T')
    await createEntry(fs.id, '/', 'util', 'folder')
    await writeFile(fs.id, '/Main.java', text('a'))
    await writeFile(fs.id, '/util/Helper.java', text('b'))
    expect((await listChildren(fs.id, '/')).map(e => e.name).sort()).toEqual(['Main.java', 'util'])
    expect((await listChildren(fs.id, '/util')).map(e => e.name)).toEqual(['Helper.java'])
  })

  it('renames a folder and everything under it', async () => {
    const fs = await createFilesystem('T')
    await createEntry(fs.id, '/', 'old', 'folder')
    await writeFile(fs.id, '/old/Helper.java', text('class Helper {}'))
    await renameEntry(fs.id, '/old', 'new')
    expect(await getEntryByPath(fs.id, '/new/Helper.java')).not.toBeNull()
    expect(await getEntryByPath(fs.id, '/old/Helper.java')).toBeNull()
  })

  it('refuses a rename that would collide', async () => {
    const fs = await createFilesystem('T')
    await writeFile(fs.id, '/A.java', text('a'))
    await writeFile(fs.id, '/B.java', text('b'))
    await expect(renameEntry(fs.id, '/A.java', 'B.java')).rejects.toThrow()
  })

  it('deletes a folder recursively', async () => {
    const fs = await createFilesystem('T')
    await createEntry(fs.id, '/', 'pkg', 'folder')
    await writeFile(fs.id, '/pkg/A.java', text('a'))
    await deleteEntry(fs.id, '/pkg')
    expect(await getAllEntries(fs.id)).toEqual([])
  })

  it('overwrites rather than duplicating on a second write', async () => {
    const fs = await createFilesystem('T')
    await writeFile(fs.id, '/Main.java', text('first'))
    await writeFile(fs.id, '/Main.java', text('second'))
    const sources = await getSourceFiles(fs.id, 'java')
    expect(sources).toHaveLength(1)
    expect(sources[0].text).toBe('second')
  })
})

describe('getSourceFiles', () => {
  it('returns every .java file in path order, and nothing else', async () => {
    const fs = await createFilesystem('T')
    await createEntry(fs.id, '/', 'util', 'folder')
    await writeFile(fs.id, '/Main.java', text('class Main {}'))
    await writeFile(fs.id, '/util/Helper.java', text('class Helper {}'))
    await writeFile(fs.id, '/notes.txt', text('not source'))
    expect((await getSourceFiles(fs.id, 'java')).map(f => f.path))
      .toEqual(['/Main.java', '/util/Helper.java'])
  })
})

describe('importFileMapToFs', () => {
  it('creates the folders a nested file needs', async () => {
    const fs = await createFilesystem('T')
    await importFileMapToFs(fs.id, new Map([['a/b/C.java', text('class C {}')]]))
    expect((await getEntryByPath(fs.id, '/a'))?.type).toBe('folder')
    expect((await getEntryByPath(fs.id, '/a/b'))?.type).toBe('folder')
    expect(await getEntryByPath(fs.id, '/a/b/C.java')).not.toBeNull()
  })
})

describe('guessMimeType', () => {
  it('knows Java source', () => {
    expect(guessMimeType('Main.java')).toBe('text/x-java-source')
  })

  it('falls back for unknown extensions', () => {
    expect(guessMimeType('mystery.qqq')).toBe('application/octet-stream')
  })
})
