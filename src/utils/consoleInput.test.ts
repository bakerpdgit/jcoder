import { describe, expect, it } from 'vitest'
import { splitPastedInput } from './consoleInput'

describe('splitPastedInput', () => {
  it('submits all but the last line, which stays at the prompt', () => {
    expect(splitPastedInput('Ada\n21', '', 0, 0)).toEqual({ submit: ['Ada'], draft: '21' })
  })

  it('submits every line when the paste ends with a newline', () => {
    expect(splitPastedInput('Ada\n21\n', '', 0, 0)).toEqual({ submit: ['Ada', '21'], draft: '' })
  })

  it('merges what was already typed on either side of the caret', () => {
    // Caret between "Ad" and "!" — pasting "a\n2" answers "Ada" and leaves "2!".
    expect(splitPastedInput('a\n2', 'Ad!', 2, 2)).toEqual({ submit: ['Ada'], draft: '2!' })
  })

  it('replaces the selection rather than keeping it', () => {
    expect(splitPastedInput('X\n', 'abcd', 1, 3)).toEqual({ submit: ['aX'], draft: 'd' })
  })

  it('normalises Windows and classic Mac line endings', () => {
    expect(splitPastedInput('Ada\r\n21\r', '', 0, 0)).toEqual({ submit: ['Ada', '21'], draft: '' })
  })

  it('keeps a blank line, which a program may legitimately read', () => {
    expect(splitPastedInput('Ada\n\n21\n', '', 0, 0)).toEqual({ submit: ['Ada', '', '21'], draft: '' })
  })
})
