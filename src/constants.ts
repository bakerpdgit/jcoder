/**
 * What this thing is called, in prose. The header renders the same words with
 * "Coder" picked out in the accent colour, so change both together.
 */
export const PRODUCT_NAME = 'A Java Coder'

/** Where the TeaVM toolchain is served from, relative to the site root. */
export const RUNTIME_BASE_PATH = '/teavm/'

/** Bytes reserved in the SharedArrayBuffer for one line of stdin. */
export const STDIN_BUFFER_BYTES = 64 * 1024

/**
 * SharedArrayBuffer layout for the blocking stdin bridge.
 *
 *   int32[0] — control flag. 0 = worker is waiting, 1 = a line is ready,
 *              2 = end-of-input (the next read reports EOF).
 *   int32[1] — byte length of the UTF-8 encoded line in the data region.
 *   bytes from STDIN_DATA_OFFSET — the UTF-8 encoded line itself.
 */
export const SAB_FLAG_INDEX = 0
export const SAB_LENGTH_INDEX = 1
export const STDIN_DATA_OFFSET = 8
export const SAB_TOTAL_BYTES = STDIN_DATA_OFFSET + STDIN_BUFFER_BYTES

export const SAB_STATE_WAITING = 0
export const SAB_STATE_LINE_READY = 1
export const SAB_STATE_EOF = 2

/** Maximum console lines retained before the oldest are dropped. */
export const CONSOLE_SCROLLBACK_LINES = 5000

export const MIN_SIDEBAR_WIDTH = 180
export const MAX_SIDEBAR_WIDTH = 520
export const MIN_CONSOLE_HEIGHT = 100
export const MAX_CONSOLE_HEIGHT = 700

/**
 * How long to let the worker runtime boot before falling back to the UI thread.
 *
 * Generous on purpose: a cold cache on a slow school connection legitimately
 * takes tens of seconds for a ~6.7MB bundle, and falling back early would cost
 * typed input for no reason. Only `?runtime=auto` (the default) falls back.
 */
export const WORKER_BOOT_TIMEOUT_MS = 45_000

/** How long a single boot step may take before the console says which one. */
export const WORKER_STALL_WARNING_MS = 30_000

/**
 * Characters buffered from the program's stdout before a chunk is posted to the
 * UI.
 *
 * TeaVM hands console output to JavaScript one UTF-16 code unit at a time, so
 * an output-heavy program would otherwise post one message per character and
 * swamp the worker's message channel. Output is also flushed on every newline
 * and immediately before the program blocks on input, so a prompt written with
 * `System.out.print` still appears before the caret.
 */
export const STDOUT_FLUSH_THRESHOLD = 4096
