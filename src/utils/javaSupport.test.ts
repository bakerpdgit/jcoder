import { describe, expect, it } from 'vitest'
import {
  END_OF_INPUT, END_OF_LINE, REQUEST_CHAR, SCANNER_SOURCE, SUPPORT_SOURCE_PATH,
  buildCompilationUnits, chooseMainClass, prepareSource, toCompilerPath, toVfsPath,
} from './javaSupport'

describe('prepareSource', () => {
  it('neutralises an import of java.util.Scanner', () => {
    const result = prepareSource('import java.util.Scanner;\npublic class Main {}')
    expect(result).not.toMatch(/^\s*import\s+java\.util\.Scanner/m)
    expect(result).toContain('[jcoder]')
  })

  it('keeps the line count so diagnostics still point at the right line', () => {
    const source = 'import java.util.Scanner;\nimport java.util.List;\npublic class Main {}'
    const result = prepareSource(source)
    expect(result.split('\n')).toHaveLength(source.split('\n').length)
    // The line that was rewritten is still line 1.
    expect(result.split('\n')[1]).toBe('import java.util.List;')
  })

  it('leaves an on-demand java.util import alone', () => {
    // `import java.util.*` does not fail on a missing Scanner, and the unnamed
    // package still wins for an unqualified reference.
    const source = 'import java.util.*;\npublic class Main {}'
    expect(prepareSource(source)).toBe(source)
  })

  it('tolerates unusual spacing in the import', () => {
    expect(prepareSource('  import  java . util . Scanner ;  ')).toContain('[jcoder]')
  })

  it('does not touch a Scanner import inside a string or a longer name', () => {
    const source = 'public class Main { String s = "import java.util.Scanner;"; }'
    expect(prepareSource(source)).toBe(source)
  })

  it('removes @SuppressWarnings, which this javac cannot compile', () => {
    const result = prepareSource('public class Main {\n @SuppressWarnings("unchecked") void m() {}\n}')
    expect(result).not.toContain('@SuppressWarnings(')
    expect(result).toContain('void m() {}')
    expect(result.split('\n')).toHaveLength(3)
  })

  it('handles an array-valued @SuppressWarnings', () => {
    const result = prepareSource('@SuppressWarnings({"a", "b"}) class Main {}')
    expect(result).not.toContain('@SuppressWarnings(')
    expect(result).toContain('class Main {}')
  })

  it('never collapses lines, even when an annotation spans them', () => {
    const source = 'class Main {\n @SuppressWarnings(\n "unchecked")\n void m() {}\n}'
    expect(prepareSource(source).split('\n')).toHaveLength(source.split('\n').length)
  })

  it('leaves marker annotations alone, since those do compile', () => {
    const source = 'public class Main {\n @Override public String toString() { return ""; }\n}'
    expect(prepareSource(source)).toBe(source)
  })
})

describe('buildCompilationUnits', () => {
  it('injects the built-in Scanner alongside the student files', () => {
    const units = buildCompilationUnits([{ path: '/Main.java', text: 'public class Main {}' }])
    expect(units.map(u => u.path)).toEqual([SUPPORT_SOURCE_PATH, 'Main.java'])
    expect(units[0].injected).toBe(true)
    expect(units[1].injected).toBe(false)
  })

  it('stands aside when the student has written their own Scanner', () => {
    const units = buildCompilationUnits([
      { path: '/Scanner.java', text: 'public class Scanner {}' },
      { path: '/Main.java', text: 'public class Main {}' },
    ])
    expect(units.filter(u => u.path === SUPPORT_SOURCE_PATH)).toHaveLength(1)
    expect(units.every(u => !u.injected)).toBe(true)
  })

  it('strips the leading slash and applies the source rewrites', () => {
    const units = buildCompilationUnits([
      { path: '/util/Helper.java', text: 'import java.util.Scanner;\nclass Helper {}' },
    ])
    const helper = units.find(u => u.path === 'util/Helper.java')
    expect(helper).toBeDefined()
    expect(helper!.text).toContain('[jcoder]')
  })
})

describe('the injected Scanner source', () => {
  it('speaks the same protocol constants as the host', () => {
    expect(SCANNER_SOURCE).toContain(`REQUEST = ${REQUEST_CHAR}`)
    expect(SCANNER_SOURCE).toContain(`END_OF_LINE = ${END_OF_LINE}L`)
    expect(SCANNER_SOURCE).toContain(`END_OF_INPUT = ${END_OF_INPUT}L`)
  })

  it('uses no annotation with arguments, which this javac cannot compile', () => {
    // Marker annotations are fine; anything with brackets overflows javac's
    // stack. This is the guard on the constraint that shaped the whole bridge.
    const annotations = SCANNER_SOURCE.match(/@\w+\s*\(/g) ?? []
    expect(annotations).toEqual([])
  })

  it('declares a constructor taking an InputStream so textbook code compiles', () => {
    expect(SCANNER_SOURCE).toContain('public Scanner(InputStream')
  })

  it('has no package declaration, so it lands in the unnamed package', () => {
    expect(SCANNER_SOURCE).not.toMatch(/^\s*package\s/m)
  })
})

describe('chooseMainClass', () => {
  it('returns null when nothing has a main method', () => {
    expect(chooseMainClass([], null)).toBeNull()
  })

  it('honours the pinned class when it still exists', () => {
    expect(chooseMainClass(['Alpha', 'Main'], 'Alpha')).toBe('Alpha')
  })

  it('ignores a pinned class that has gone away', () => {
    expect(chooseMainClass(['Alpha', 'Main'], 'Deleted')).toBe('Main')
  })

  it('prefers Main by convention', () => {
    expect(chooseMainClass(['Alpha', 'Main', 'Zeta'], null)).toBe('Main')
    expect(chooseMainClass(['Alpha', 'demo.Main'], null)).toBe('demo.Main')
  })

  it('falls back to the first name alphabetically', () => {
    expect(chooseMainClass(['Zeta', 'Alpha'], null)).toBe('Alpha')
  })
})

describe('path mapping', () => {
  it('round-trips between the VFS and the compiler', () => {
    expect(toCompilerPath('/Main.java')).toBe('Main.java')
    expect(toCompilerPath('/a/b/C.java')).toBe('a/b/C.java')
    expect(toVfsPath('Main.java')).toBe('/Main.java')
    expect(toVfsPath('/Main.java')).toBe('/Main.java')
    expect(toVfsPath(toCompilerPath('/a/b/C.java'))).toBe('/a/b/C.java')
  })
})
