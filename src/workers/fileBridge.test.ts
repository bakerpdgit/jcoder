import { describe, expect, it } from 'vitest'
import { FileBridge, bytesToWire, normalisePath, wireToBytes } from './fileBridge'

const utf8 = (text: string) => new TextEncoder().encode(text)

const snapshot = () => new FileBridge([
  { path: '/demo.txt', bytes: utf8('alpha\nbeta\n') },
  { path: '/data/scores.csv', bytes: utf8('1,2,3') },
])

describe('normalisePath', () => {
  it('gives one spelling to the ways a student writes a path', () => {
    for (const written of ['demo.txt', './demo.txt', '/demo.txt', '//demo.txt']) {
      expect(normalisePath(written)).toBe('/demo.txt')
    }
  })

  it('accepts backslashes, which a Windows user may well type', () => {
    expect(normalisePath('data\\scores.csv')).toBe('/data/scores.csv')
  })

  it('drops a trailing slash but keeps the root', () => {
    expect(normalisePath('/data/')).toBe('/data')
    expect(normalisePath('/')).toBe('/')
  })
})

describe('reading', () => {
  it('finds a file however the path was written', () => {
    const files = snapshot()
    expect(files.read('/demo.txt')).toBe('alpha\nbeta\n')
    expect(files.execute('R demo.txt')).toBe('alpha\nbeta\n')
  })

  it('reports a missing file as absent rather than empty', () => {
    // The two must not be confused: an empty file is a real, readable file.
    expect(snapshot().execute('R nope.txt')).toBeNull()
  })

  it('stats files and folders', () => {
    const files = snapshot()
    expect(files.execute('S /demo.txt')).toBe('f11')
    expect(files.execute('S /data')).toBe('d')
    expect(files.execute('S /nope')).toBeNull()
  })

  it('lists a folder, naming a subfolder once', () => {
    expect(snapshot().execute('L /')).toBe('data\ndemo.txt')
    expect(snapshot().execute('L /data')).toBe('scores.csv')
  })

  it('will not list something that is not a folder', () => {
    expect(snapshot().execute('L /demo.txt')).toBeNull()
  })
})

describe('writing', () => {
  it('creates a file and reports it as changed', () => {
    const files = snapshot()
    files.write('out.txt', 'written')
    expect(files.read('/out.txt')).toBe('written')
    expect(files.changedFiles()).toEqual([{ path: '/out.txt', bytes: utf8('written') }])
  })

  it('creates the folders a nested path needs', () => {
    const files = snapshot()
    files.write('/notes/2026/log.txt', 'hi')
    expect(files.execute('S /notes')).toBe('d')
    expect(files.execute('S /notes/2026')).toBe('d')
    expect(files.execute('L /')).toContain('notes')
  })

  it('leaves files it did not touch out of the changes', () => {
    const files = snapshot()
    files.read('/demo.txt')
    expect(files.changedFiles()).toEqual([])
  })

  it('reports a delete as a null text', () => {
    const files = snapshot()
    expect(files.execute('D /demo.txt')).toBe('ok')
    expect(files.changedFiles()).toEqual([{ path: '/demo.txt', bytes: null }])
    expect(files.read('/demo.txt')).toBeNull()
  })

  it('refuses to delete a folder that still holds something', () => {
    const files = snapshot()
    expect(files.execute('D /data')).toBeNull()
  })

  it('remembers a folder the program created but left empty', () => {
    const files = snapshot()
    expect(files.execute('M /empty')).toBe('ok')
    expect(files.createdFolders()).toContain('/empty')
    // One that has a file in it needs no separate record.
    expect(files.createdFolders()).not.toContain('/data')
  })
})

describe('binary files', () => {
  /** Every byte value, including the ones no text encoding would survive. */
  const everyByte = Uint8Array.from({ length: 256 }, (_, i) => i)

  it('carries any byte on the wire and back', () => {
    expect(wireToBytes(bytesToWire(everyByte))).toEqual(everyByte)
  })

  it('encodes one character per byte, whatever the value', () => {
    expect(bytesToWire(everyByte)).toHaveLength(256)
    expect(bytesToWire(Uint8Array.of(0, 255)).charCodeAt(1)).toBe(255)
  })

  it('survives a payload larger than the argument limit of fromCharCode', () => {
    const large = Uint8Array.from({ length: 200_000 }, (_, i) => i % 256)
    const round = wireToBytes(bytesToWire(large))
    // Compared by hand: toEqual on 200,000 elements takes seconds.
    expect(round).toHaveLength(large.length)
    let firstDifference = -1
    for (let i = 0; i < large.length; i++) {
      if (round[i] !== large[i]) { firstDifference = i; break }
    }
    expect(firstDifference).toBe(-1)
  })

  it('reads a binary file back exactly', () => {
    const files = new FileBridge([{ path: '/data.bin', bytes: everyByte }])
    const wire = files.execute('B /data.bin')
    expect(wire).not.toBeNull()
    expect(wireToBytes(wire!)).toEqual(everyByte)
  })

  it('writes bytes without going through text', () => {
    const files = new FileBridge([])
    files.writeBytes('/out.bin', bytesToWire(everyByte))
    expect(files.readBytes('/out.bin')).toEqual(everyByte)
    expect(files.changedFiles()).toEqual([{ path: '/out.bin', bytes: everyByte }])
  })

  it('reports a binary file\'s size in bytes, not characters', () => {
    // "é" is one character but two bytes; File.length() must say two.
    const files = new FileBridge([{ path: '/a.txt', bytes: utf8('é') }])
    expect(files.execute('S /a.txt')).toBe('f2')
  })

  it('lets text be written and read back as bytes', () => {
    const files = new FileBridge([])
    files.write('/mixed.txt', 'héllo')
    expect(files.readBytes('/mixed.txt')).toEqual(utf8('héllo'))
    expect(files.read('/mixed.txt')).toBe('héllo')
  })
})

describe('unknown commands', () => {
  it('are absent rather than an exception', () => {
    expect(snapshot().execute('Z /demo.txt')).toBeNull()
    expect(snapshot().execute('')).toBeNull()
  })
})
