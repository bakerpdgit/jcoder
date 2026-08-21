import { describe, expect, it } from 'vitest'
import {
  END_OF_INPUT, END_OF_LINE, ERROR_HELPER_PATH, REQUEST_CHAR,
  ERROR_HELPER_SOURCE, SUPPORT_SOURCE_PATH, blankLiteralsAndComments, buildCompilationUnits,
  checkUnsupportedApis, chooseMainClass, declaredTypeNames, planCompilation,
  prepareSource, scannerSource, toCompilerPath, toVfsPath,
} from './javaSupport'
import { FILE_SUPPORT_PATH, FILE_SUPPORT_SOURCE } from './javaFileSystem'
import { LANGUAGES } from './languages'

/** The Scanner as it is injected in the normal case, with file support. */
const SCANNER_SOURCE = scannerSource(true)

/** The file every new workspace starts from; it must be warning-free. */
const LANGUAGES_TEMPLATE = LANGUAGES.java.template

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
    expect(units.map(u => u.path)).toContain(SUPPORT_SOURCE_PATH)
    expect(units.find(u => u.path === SUPPORT_SOURCE_PATH)!.injected).toBe(true)
    expect(units.find(u => u.path === 'Main.java')!.injected).toBe(false)
    // The student's own file always comes last, so the injected ones cannot
    // push its diagnostics around.
    expect(units[units.length - 1].path).toBe('Main.java')
  })

  it('stands aside when the student has written their own Scanner', () => {
    const units = buildCompilationUnits([
      { path: '/Scanner.java', text: 'public class Scanner {}' },
      { path: '/Main.java', text: 'public class Main {}' },
    ])
    expect(units.filter(u => u.path === SUPPORT_SOURCE_PATH)).toHaveLength(1)
    expect(units.find(u => u.path === SUPPORT_SOURCE_PATH)!.injected).toBe(false)
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

describe('the injected Java is well formed', () => {
  // These sources are TypeScript template literals, so a `\n` written with one
  // backslash becomes a real newline and lands inside a Java character literal
  // as an unterminated one. That has happened; this catches it without needing
  // the compiler.
  const sources: Array<[string, string]> = [
    ['Scanner', scannerSource(true)],
    ['Scanner (no file support)', scannerSource(false)],
    ['file support', FILE_SUPPORT_SOURCE],
    ['getMessage helper', ERROR_HELPER_SOURCE],
  ]

  /**
   * The line number of the first string or character literal that runs off the
   * end of its line, or null. This is exactly the shape the escaping bug takes.
   */
  function unterminatedLiteral(source: string): { line: number; text: string } | null {
    let line = 1
    for (let i = 0; i < source.length; i++) {
      const two = source.slice(i, i + 2)
      if (two === '//') {
        const end = source.indexOf('\n', i)
        i = end === -1 ? source.length : end - 1
        continue
      }
      if (two === '/*') {
        const end = source.indexOf('*/', i + 2)
        for (let j = i; j < (end === -1 ? source.length : end + 2); j++) {
          if (source[j] === '\n') line++
        }
        i = end === -1 ? source.length : end + 1
        continue
      }
      if (source[i] === '"' || source[i] === "'") {
        const quote = source[i]
        let j = i + 1
        while (j < source.length && source[j] !== quote) {
          if (source[j] === '\\') j++
          else if (source[j] === '\n') {
            return { line, text: source.split('\n')[line - 1] }
          }
          j++
        }
        i = j
        continue
      }
      if (source[i] === '\n') line++
    }
    return null
  }

  for (const [name, source] of sources) {
    it(`${name}: every literal closes on its own line`, () => {
      const problem = unterminatedLiteral(source)
      expect(problem, problem ? `${name} line ${problem.line}: ${problem.text}` : '').toBeNull()
    })

    it(`${name}: braces balance`, () => {
      // Blanking literals and comments first, so a brace inside either is not
      // counted — the string "//" in normalise() otherwise reads as a comment.
      const code = blankLiteralsAndComments(source)
      const opens = (code.match(/\{/g) ?? []).length
      const closes = (code.match(/\}/g) ?? []).length
      expect(opens).toBe(closes)
    })
  }
})

describe('blankLiteralsAndComments', () => {
  it('keeps the text the same length and shape', () => {
    const source = 'int a = 1; // note\nString s = "hello";\n'
    const blanked = blankLiteralsAndComments(source)
    expect(blanked).toHaveLength(source.length)
    expect(blanked.split('\n')).toHaveLength(source.split('\n').length)
  })

  it('hides string, char and comment contents but keeps code', () => {
    const blanked = blankLiteralsAndComments('x("java.nio.file"); /* java.nio.file */ y();')
    expect(blanked).not.toContain('java.nio.file')
    expect(blanked).toContain('x(')
    expect(blanked).toContain('y();')
  })

  it('is not confused by an escaped quote', () => {
    const blanked = blankLiteralsAndComments('String s = "a\\"b"; int n = 1;')
    expect(blanked).toContain('int n = 1;')
  })
})

describe('checkUnsupportedApis', () => {
  const check = (text: string) => checkUnsupportedApis([{ path: '/Main.java', text }])

  it('says nothing about the text file APIs, which now work', () => {
    expect(check([
      'import java.nio.file.Files;',
      'import java.nio.file.Paths;',
      'import java.io.FileReader;',
      'public class Main { public static void main(String[] a) throws Exception {',
      '  Files.readAllLines(Paths.get("demo.txt"));',
      '  new FileReader("demo.txt");',
      '  new File("demo.txt").exists();',
      '} }',
    ].join('\n'))).toEqual([])
  })

  it('says nothing about byte streams, which now work too', () => {
    expect(check([
      'import java.io.*;',
      'public class Main { public static void main(String[] a) throws Exception {',
      '  FileInputStream in = new FileInputStream("data.bin");',
      '  FileOutputStream out = new FileOutputStream("copy.bin");',
      '} }',
    ].join('\n'))).toEqual([])
  })

  it('rejects random access, which has no stand-in', () => {
    const problems = check('class M { void f() throws Exception { new java.io.RandomAccessFile("x", "r"); } }')
    expect(problems).toHaveLength(1)
    expect(problems[0].severity).toBe('error')
    expect(problems[0].message).toMatch(/FileInputStream|Scanner/)
  })

  it('reports each problem once per file, at the first occurrence', () => {
    const problems = check([
      'class M {',
      '  void a() throws Exception { new java.io.RandomAccessFile("x", "r"); }',
      '  void b() throws Exception { new java.io.RandomAccessFile("y", "r"); }',
      '}',
    ].join('\n'))
    expect(problems).toHaveLength(1)
    expect(problems[0].line).toBe(2)
  })

  it('warns about System.in but does not block the run', () => {
    const problems = check('class M { void f() throws Exception { int c = System.in.read(); } }')
    expect(problems).toHaveLength(1)
    expect(problems[0].severity).toBe('warning')
  })

  it('says nothing about new Scanner(System.in), which is the way to read input', () => {
    // The starter template uses exactly this; a badge on every run would teach
    // students to ignore the Problems tab.
    expect(check('class M { void f() { Scanner s = new Scanner(System.in); } }')).toEqual([])
    expect(check(LANGUAGES_TEMPLATE)).toEqual([])
  })

  it('ignores mentions inside strings and comments', () => {
    expect(check('class M { String s = "java.nio.file.Files"; /* new FileReader */ }')).toEqual([])
  })

  it('passes an ordinary program', () => {
    expect(check('public class Main { public static void main(String[] a) { System.out.println("hi"); } }')).toEqual([])
  })
})

describe('file support', () => {
  it('is injected, and neutralises the imports that would shadow it', () => {
    const plan = planCompilation([
      { path: '/Main.java', text: 'import java.io.File;\nclass Main { File f = new File("x"); }' },
    ])
    expect(plan.units.some(u => u.path === FILE_SUPPORT_PATH)).toBe(true)
    expect(plan.fileSupportBlockedBy).toEqual([])
    const main = plan.units.find(u => u.path === 'Main.java')!
    expect(main.text).not.toMatch(/^\s*import\s+java\.io\.File\s*;/m)
    expect(main.text).toContain('[jcoder]')
  })

  it('leaves an on-demand java.io import alone', () => {
    const plan = planCompilation([
      { path: '/Main.java', text: 'import java.io.*;\nclass Main {}' },
    ])
    expect(plan.units.find(u => u.path === 'Main.java')!.text).toContain('import java.io.*;')
  })

  it('gives the Scanner a file constructor only when file support is present', () => {
    expect(scannerSource(true)).toContain('public Scanner(File source)')
    expect(scannerSource(false)).not.toContain('public Scanner(File source)')
  })

  it('stands down when a student class would collide, and says which', () => {
    // A pathfinding exercise with its own Path is entirely plausible.
    const plan = planCompilation([
      { path: '/Path.java', text: 'class Path { int cost; }' },
      { path: '/Main.java', text: 'class Main { Path p = new Path(); }' },
    ])
    expect(plan.fileSupportBlockedBy).toEqual(['Path'])
    expect(plan.units.some(u => u.path === FILE_SUPPORT_PATH)).toBe(false)
    // …and the Scanner must still be there, without its file constructor.
    const scanner = plan.units.find(u => u.path === SUPPORT_SOURCE_PATH)!
    expect(scanner.text).not.toContain('public Scanner(File source)')
  })
})

describe('declaredTypeNames', () => {
  it('finds classes, interfaces and enums', () => {
    const names = declaredTypeNames('class A {}\ninterface B {}\nenum C { X }')
    expect([...names].sort()).toEqual(['A', 'B', 'C'])
  })

  it('ignores names inside strings and comments', () => {
    expect([...declaredTypeNames('// class Ghost\nString s = "class Other";\nclass Real {}')])
      .toEqual(['Real'])
  })
})

describe('the getMessage() stand-in', () => {
  it('rewrites a simple call onto the helper', () => {
    const units = buildCompilationUnits([
      { path: '/Main.java', text: 'class Main { void f(Exception e) { print(e.getMessage()); } }' },
    ])
    const main = units.find(u => u.path === 'Main.java')!
    expect(main.text).toContain('JCoderErr.messageOf(e)')
    expect(main.text).not.toContain('e.getMessage()')
  })

  it('carries the helper only when something needed it', () => {
    const withCall = buildCompilationUnits([
      { path: '/Main.java', text: 'class Main { void f(Exception e) { print(e.getMessage()); } }' },
    ])
    expect(withCall.some(u => u.path === ERROR_HELPER_PATH)).toBe(true)

    const without = buildCompilationUnits([{ path: '/Main.java', text: 'class Main {}' }])
    expect(without.some(u => u.path === ERROR_HELPER_PATH)).toBe(false)
  })

  it('leaves the code alone when the student declares their own getMessage', () => {
    const units = buildCompilationUnits([
      { path: '/Main.java', text: 'class Main { void f(Boom e) { print(e.getMessage()); } }' },
      { path: '/Boom.java', text: 'class Boom extends Exception { public String getMessage() { return "x"; } }' },
    ])
    const main = units.find(u => u.path === 'Main.java')!
    expect(main.text).toContain('e.getMessage()')
    expect(units.some(u => u.path === ERROR_HELPER_PATH)).toBe(false)
  })

  it('leaves a call on a complex receiver for the compiler to explain', () => {
    // A regular expression cannot know the type here, and guessing would change
    // what the program does.
    const units = buildCompilationUnits([
      { path: '/Main.java', text: 'class Main { void f() { print(lookUp().getMessage()); } }' },
    ])
    expect(units.find(u => u.path === 'Main.java')!.text).toContain('lookUp().getMessage()')
  })

  it('keeps the line count so diagnostics stay aligned', () => {
    const text = 'class Main {\n  void f(Exception e) {\n    print(e.getMessage());\n  }\n}'
    const units = buildCompilationUnits([{ path: '/Main.java', text }])
    const main = units.find(u => u.path === 'Main.java')!
    expect(main.text.split('\n')).toHaveLength(text.split('\n').length)
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
