import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LANGUAGE, LANGUAGES, compileExtensions,
  getLanguage, isLanguageId, languageForFile, monacoLanguageForFile,
} from './languages'

describe('the language registry', () => {
  it('recognises java and nothing else', () => {
    expect(isLanguageId('java')).toBe(true)
    expect(isLanguageId('csharp')).toBe(false)
    expect(getLanguage(DEFAULT_LANGUAGE).extension).toBe('.java')
  })

  it('hands the compiler .java files', () => {
    expect(compileExtensions('java')).toContain('.java')
  })

  it('identifies source files by extension, case-insensitively', () => {
    expect(languageForFile('Main.java')).toBe('java')
    expect(languageForFile('MAIN.JAVA')).toBe('java')
    expect(languageForFile('notes.txt')).toBeNull()
    expect(languageForFile('Main.class')).toBeNull()
  })

  it('picks a Monaco language for non-source files too', () => {
    expect(monacoLanguageForFile('Main.java')).toBe('java')
    expect(monacoLanguageForFile('README.md')).toBe('markdown')
    expect(monacoLanguageForFile('data.json')).toBe('json')
    expect(monacoLanguageForFile('mystery.bin')).toBe('plaintext')
  })

  it('ships a starter template that compiles to a class called Main', () => {
    const template = LANGUAGES.java.template
    expect(LANGUAGES.java.defaultFileName).toBe('Main.java')
    expect(template).toContain('public class Main')
    expect(template).toContain('public static void main(String[] args)')
  })
})
