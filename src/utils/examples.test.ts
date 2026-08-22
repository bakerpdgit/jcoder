import { describe, expect, it } from 'vitest'
import { EXAMPLES, examplePath, findExample } from './examples'
import { checkUnsupportedApis, declaredTypeNames, planCompilation } from './javaSupport'
import { FILE_SUPPORT_PATH } from './javaFileSystem'

describe('the example catalogue', () => {
  it('has unique ids, class names and labels', () => {
    const ids = EXAMPLES.map(e => e.id)
    const classNames = EXAMPLES.map(e => e.className)
    const labels = EXAMPLES.map(e => e.label)
    expect(new Set(ids).size).toBe(ids.length)
    expect(new Set(classNames).size).toBe(classNames.length)
    expect(new Set(labels).size).toBe(labels.length)
  })

  it('looks an example up by id, and puts it at the root', () => {
    const example = findExample('ex1')
    expect(example).toBeDefined()
    expect(examplePath(example!)).toBe('/Example1.java')
  })
})

describe.each(EXAMPLES)('$label', (example) => {
  it('declares the public class the file is named after', () => {
    expect(example.source).toContain(`public class ${example.className}`)
    expect(declaredTypeNames(example.source)).toContain(example.className)
  })

  it('has a main method, so Run does something', () => {
    expect(example.source).toMatch(/public\s+static\s+void\s+main\s*\(\s*String\s*\[\s*\]/)
  })

  it('uses no annotation with arguments, which this javac cannot compile', () => {
    // `@Override` and the like are fine; anything with brackets is not.
    expect(example.source.match(/@\w+\s*\(/g) ?? []).toEqual([])
  })

  it('raises no pre-flight problem', () => {
    // Catches a fully-qualified java.io.File, an uncatchable exception type,
    // RandomAccessFile — anything the app would complain about if a student
    // wrote it. An example that trips its own warnings is a bad example.
    const problems = checkUnsupportedApis([{ path: examplePath(example), text: example.source }])
    expect(problems.map(p => `${p.severity} line ${p.line}: ${p.message.split('\n')[0]}`)).toEqual([])
  })

  it('does not collide with the injected support classes', () => {
    const plan = planCompilation([{ path: examplePath(example), text: example.source }])
    expect(plan.fileSupportBlockedBy).toEqual([])
    expect(plan.units.some(u => u.path === FILE_SUPPORT_PATH)).toBe(true)
  })

  it('every literal closes on its own line', () => {
    // These are TypeScript template literals; a `\n` written with one
    // backslash would become a real newline inside a Java string.
    for (const [index, line] of example.source.split('\n').entries()) {
      const code = line.replace(/\/\/.*$/, '').replace(/\\\\/g, '').replace(/\\'/g, '').replace(/\\"/g, '')
      expect((code.match(/"/g) ?? []).length % 2, `line ${index + 1}: ${line}`).toBe(0)
    }
  })

  it('ends with a newline, like a normal source file', () => {
    expect(example.source.endsWith('\n')).toBe(true)
  })
})
