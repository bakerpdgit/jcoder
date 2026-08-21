import { describe, expect, it } from 'vitest'
import { parseArgs } from './args'

describe('parseArgs', () => {
  it('splits on whitespace', () => {
    expect(parseArgs('one two three')).toEqual(['one', 'two', 'three'])
  })

  it('keeps a quoted argument together and drops the quotes', () => {
    expect(parseArgs('"hello world" second')).toEqual(['hello world', 'second'])
  })

  it('returns nothing for empty or blank input', () => {
    expect(parseArgs('')).toEqual([])
    expect(parseArgs('   ')).toEqual([])
  })

  it('collapses runs of whitespace', () => {
    expect(parseArgs('  a   b  ')).toEqual(['a', 'b'])
  })
})
