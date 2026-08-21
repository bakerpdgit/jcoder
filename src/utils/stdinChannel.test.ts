import { describe, expect, it } from 'vitest'
import { SAB_TOTAL_BYTES, STDIN_BUFFER_BYTES } from '../constants'
import {
  awaitLine, consumeLine, createStdinChannel, markWaiting, publishEof, publishLine, truncateUtf8,
} from './stdinChannel'

/**
 * The worker side normally blocks on Atomics.wait, which cannot be exercised on
 * the main thread. Publishing *before* awaiting leaves the flag already moved,
 * so awaitLine returns without ever waiting — which is exactly the race the
 * protocol has to survive in the real thing.
 */
function newChannel() {
  return createStdinChannel(new ArrayBuffer(SAB_TOTAL_BYTES))
}

describe('the stdin channel', () => {
  it('carries a line from the UI to the worker', () => {
    const channel = newChannel()
    markWaiting(channel)
    publishLine(channel, 'Ada')
    expect(awaitLine(channel)).toBe('Ada')
  })

  it('carries an empty line as an empty line, not as end of input', () => {
    const channel = newChannel()
    markWaiting(channel)
    publishLine(channel, '')
    expect(awaitLine(channel)).toBe('')
  })

  it('reports end of input as null', () => {
    const channel = newChannel()
    markWaiting(channel)
    publishEof(channel)
    expect(awaitLine(channel)).toBeNull()
  })

  it('round-trips non-ASCII text', () => {
    const channel = newChannel()
    markWaiting(channel)
    publishLine(channel, 'naïve café 日本語 🙂')
    expect(awaitLine(channel)).toBe('naïve café 日本語 🙂')
  })

  it('does not leak the previous line into a shorter one', () => {
    const channel = newChannel()
    markWaiting(channel)
    publishLine(channel, 'a longer first line')
    expect(consumeLine(channel)).toBe('a longer first line')
    markWaiting(channel)
    publishLine(channel, 'short')
    expect(consumeLine(channel)).toBe('short')
  })

  it('truncates an over-long line without corrupting the last character', () => {
    const channel = newChannel()
    markWaiting(channel)
    publishLine(channel, 'é'.repeat(STDIN_BUFFER_BYTES))
    const received = awaitLine(channel)
    expect(received).not.toBeNull()
    expect(received!).not.toContain('�')
  })
})

describe('truncateUtf8', () => {
  it('leaves short input alone', () => {
    const bytes = new TextEncoder().encode('hello')
    expect(truncateUtf8(bytes, 64)).toHaveLength(5)
  })

  it('never splits a multi-byte character', () => {
    // 'é' is two bytes, so a limit of 3 must drop the second one entirely.
    const bytes = new TextEncoder().encode('éé')
    const trimmed = truncateUtf8(bytes, 3)
    expect(new TextDecoder().decode(trimmed)).toBe('é')
  })
})
