import { describe, expect, it, vi } from 'vitest'
import { ConsoleSink, InputBridge } from './javaPipeline'
import { END_OF_INPUT, END_OF_LINE, MAX_LINE_CHARS, REQUEST_CHAR } from '../utils/javaSupport'
import { STDOUT_FLUSH_THRESHOLD } from '../constants'

/**
 * The Java half of the input bridge, transcribed from the `hostReadLine` method
 * in `SCANNER_SOURCE`.
 *
 * Keeping a copy here is the point of these tests: the two halves live in
 * different languages and can only be checked against each other by running
 * them together. If the Java changes and this does not, these tests stop being
 * evidence — so the loop below should be kept a literal translation.
 */
function javaReadLine(bridge: InputBridge, clock: () => number): string | null {
  bridge.interceptStderr(REQUEST_CHAR)
  let text = ''
  while (text.length < MAX_LINE_CHARS) {
    const c = bridge.currentTimeMillis(clock)
    if (c === END_OF_LINE) return text
    if (c === END_OF_INPUT) return null
    if (c < 0 || c > 65535) return null
    text += String.fromCharCode(c)
  }
  return text
}

/** A clock far beyond the 0..65535 range, as a real one always is. */
const realClock = () => 1_700_000_000_000

describe('InputBridge', () => {
  it('hands a line across, character by character', () => {
    const bridge = new InputBridge(() => 'Ada')
    expect(javaReadLine(bridge, realClock)).toBe('Ada')
  })

  it('distinguishes an empty line from end of input', () => {
    expect(javaReadLine(new InputBridge(() => ''), realClock)).toBe('')
    expect(javaReadLine(new InputBridge(() => null), realClock)).toBeNull()
  })

  it('reads several lines in order', () => {
    const lines = ['first', 'second', 'third']
    const bridge = new InputBridge(() => lines.shift() ?? null)
    expect(javaReadLine(bridge, realClock)).toBe('first')
    expect(javaReadLine(bridge, realClock)).toBe('second')
    expect(javaReadLine(bridge, realClock)).toBe('third')
    expect(javaReadLine(bridge, realClock)).toBeNull()
  })

  it('carries non-ASCII text', () => {
    const bridge = new InputBridge(() => 'café 日本')
    expect(javaReadLine(bridge, realClock)).toBe('café 日本')
  })

  it('gives the program the real clock when no line is being read', () => {
    const bridge = new InputBridge(() => 'x')
    expect(bridge.currentTimeMillis(realClock)).toBe(realClock())
    // …and again once a line has been fully consumed.
    expect(javaReadLine(bridge, realClock)).toBe('x')
    expect(bridge.currentTimeMillis(realClock)).toBe(realClock())
  })

  it('only intercepts the request marker, passing other characters through', () => {
    const bridge = new InputBridge(() => 'unused')
    expect(bridge.interceptStderr('A'.charCodeAt(0))).toBe(false)
    expect(bridge.interceptStderr(10)).toBe(false)
    expect(bridge.interceptStderr(REQUEST_CHAR)).toBe(true)
  })

  it('does not ask for a line until the program requests one', () => {
    const readLine = vi.fn(() => 'Ada')
    const bridge = new InputBridge(readLine)
    bridge.currentTimeMillis(realClock)
    bridge.interceptStderr('x'.charCodeAt(0))
    expect(readLine).not.toHaveBeenCalled()
    bridge.interceptStderr(REQUEST_CHAR)
    expect(readLine).toHaveBeenCalledTimes(1)
  })

  it('stays at end of input once it is reached', () => {
    const bridge = new InputBridge(() => null)
    expect(javaReadLine(bridge, realClock)).toBeNull()
    expect(javaReadLine(bridge, realClock)).toBeNull()
  })
})

describe('ConsoleSink', () => {
  it('buffers until a newline, then emits the whole line', () => {
    const emit = vi.fn()
    const sink = new ConsoleSink(emit)
    for (const ch of 'hi') sink.putChar(ch.charCodeAt(0))
    expect(emit).not.toHaveBeenCalled()
    sink.putChar(10)
    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledWith('hi\n')
  })

  it('emits a prompt with no newline when flushed explicitly', () => {
    const emit = vi.fn()
    const sink = new ConsoleSink(emit)
    for (const ch of 'Name? ') sink.putChar(ch.charCodeAt(0))
    expect(emit).not.toHaveBeenCalled()
    sink.flush()
    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledWith('Name? ')
  })

  it('does nothing when flushed with an empty buffer', () => {
    const emit = vi.fn()
    new ConsoleSink(emit).flush()
    expect(emit).not.toHaveBeenCalled()
  })

  it('flushes on its own once the buffer is full', () => {
    const emit = vi.fn()
    const sink = new ConsoleSink(emit)
    for (let i = 0; i < STDOUT_FLUSH_THRESHOLD; i++) sink.putChar(65)
    expect(emit).toHaveBeenCalledTimes(1)
    expect((emit.mock.calls[0][0] as string)).toHaveLength(STDOUT_FLUSH_THRESHOLD)
  })
})
