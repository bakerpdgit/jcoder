import { beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_LAYOUT, loadLayout, loadMainClass, loadTheme, saveLayout, saveMainClass,
  saveTheme, toInputLines,
} from './storage'

beforeEach(() => localStorage.clear())

describe('toInputLines', () => {
  it('treats empty text as no input at all', () => {
    expect(toInputLines('')).toEqual([])
  })

  it('does not turn a trailing newline into an extra empty line', () => {
    expect(toInputLines('Ada\n21\n')).toEqual(['Ada', '21'])
  })

  it('keeps a blank line in the middle, which a program may read', () => {
    expect(toInputLines('Ada\n\n21')).toEqual(['Ada', '', '21'])
  })

  it('accepts Windows line endings', () => {
    expect(toInputLines('Ada\r\n21\r\n')).toEqual(['Ada', '21'])
  })

  it('treats a single newline as one empty line', () => {
    expect(toInputLines('\n')).toEqual([''])
  })
})

describe('preferences', () => {
  it('defaults to the dark theme and round-trips a change', () => {
    expect(loadTheme()).toBe('dark')
    saveTheme('light')
    expect(loadTheme()).toBe('light')
  })

  it('defaults the main class to "let jcoder choose"', () => {
    expect(loadMainClass()).toBe('')
    saveMainClass('demo.App')
    expect(loadMainClass()).toBe('demo.App')
  })

  it('falls back to the default layout when nothing is stored', () => {
    expect(loadLayout()).toEqual(DEFAULT_LAYOUT)
  })

  it('round-trips a layout', () => {
    saveLayout({ sidebarWidth: 300, consoleHeight: 180, sidebarCollapsed: true })
    expect(loadLayout()).toEqual({ sidebarWidth: 300, consoleHeight: 180, sidebarCollapsed: true })
  })

  it('survives corrupted stored JSON', () => {
    localStorage.setItem('jcoder_layout', '{not json')
    expect(loadLayout()).toEqual(DEFAULT_LAYOUT)
  })

  it('fills in missing fields from the default layout', () => {
    localStorage.setItem('jcoder_layout', JSON.stringify({ sidebarWidth: 400 }))
    expect(loadLayout()).toEqual({ ...DEFAULT_LAYOUT, sidebarWidth: 400 })
  })
})
