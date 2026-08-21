/**
 * The stdin protocol shared by the UI thread and the runner worker.
 *
 * Both sides view the same SharedArrayBuffer:
 *
 *   int32[0]  control flag  — 0 waiting, 1 line ready, 2 end of input
 *   int32[1]  byte length of the pending line
 *   bytes[8…] the line, UTF-8 encoded
 *
 * Keeping the layout in one module means the reader and the writer cannot drift
 * apart, and lets the round trip be unit tested without a worker.
 */
import {
  SAB_FLAG_INDEX,
  SAB_LENGTH_INDEX,
  SAB_STATE_EOF,
  SAB_STATE_LINE_READY,
  SAB_STATE_WAITING,
  STDIN_BUFFER_BYTES,
  STDIN_DATA_OFFSET,
} from '../constants'

export interface StdinChannel {
  flags: Int32Array
  bytes: Uint8Array
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function createStdinChannel(buffer: SharedArrayBuffer | ArrayBuffer): StdinChannel {
  return { flags: new Int32Array(buffer, 0, 2), bytes: new Uint8Array(buffer) }
}

/**
 * Trims a UTF-8 byte array to at most `limit` bytes without splitting a
 * multi-byte character — a naive slice would leave a dangling continuation byte
 * and decode as U+FFFD.
 */
export function truncateUtf8(bytes: Uint8Array, limit: number): Uint8Array {
  if (bytes.length <= limit) return bytes
  let end = limit
  // Continuation bytes match 10xxxxxx; walk back to the lead byte that starts
  // the truncated character and drop the whole character.
  while (end > 0 && (bytes[end] & 0b1100_0000) === 0b1000_0000) end -= 1
  return bytes.subarray(0, end)
}

/** UI thread: hand a line to the waiting worker. */
export function publishLine(channel: StdinChannel, line: string): void {
  const payload = truncateUtf8(encoder.encode(line), STDIN_BUFFER_BYTES)
  channel.bytes.set(payload, STDIN_DATA_OFFSET)
  Atomics.store(channel.flags, SAB_LENGTH_INDEX, payload.length)
  Atomics.store(channel.flags, SAB_FLAG_INDEX, SAB_STATE_LINE_READY)
  Atomics.notify(channel.flags, SAB_FLAG_INDEX)
}

/** UI thread: tell the worker that stdin is closed (reads then report EOF). */
export function publishEof(channel: StdinChannel): void {
  Atomics.store(channel.flags, SAB_LENGTH_INDEX, 0)
  Atomics.store(channel.flags, SAB_FLAG_INDEX, SAB_STATE_EOF)
  Atomics.notify(channel.flags, SAB_FLAG_INDEX)
}

/** Worker: mark the channel as waiting, before asking the UI for a line. */
export function markWaiting(channel: StdinChannel): void {
  Atomics.store(channel.flags, SAB_FLAG_INDEX, SAB_STATE_WAITING)
}

/** Worker: read whatever the UI published. Call only once the flag has moved. */
export function consumeLine(channel: StdinChannel): string | null {
  if (Atomics.load(channel.flags, SAB_FLAG_INDEX) === SAB_STATE_EOF) return null
  const length = Math.min(Atomics.load(channel.flags, SAB_LENGTH_INDEX), STDIN_BUFFER_BYTES)
  return decoder.decode(channel.bytes.slice(STDIN_DATA_OFFSET, STDIN_DATA_OFFSET + length))
}

/**
 * Worker only: block this thread until the UI publishes a line or EOF.
 * Atomics.wait throws on the main thread, which is exactly why the runtime
 * lives in a worker.
 */
export function awaitLine(channel: StdinChannel): string | null {
  while (Atomics.load(channel.flags, SAB_FLAG_INDEX) === SAB_STATE_WAITING) {
    // Returns 'not-equal' immediately if the UI answered between the check and
    // the wait, so a line can never be missed.
    Atomics.wait(channel.flags, SAB_FLAG_INDEX, SAB_STATE_WAITING)
  }
  return consumeLine(channel)
}
