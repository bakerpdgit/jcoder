import '@testing-library/jest-dom/vitest'
import 'fake-indexeddb/auto'

// jsdom has no crypto.randomUUID in older versions; the VFS relies on it.
if (typeof crypto.randomUUID !== 'function') {
  Object.defineProperty(crypto, 'randomUUID', {
    value: () => `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`,
  })
}
