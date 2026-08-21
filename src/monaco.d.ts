// The ESM entry points of monaco-editor ship no .d.ts of their own; they all
// re-export the same API surface that the package's root types describe.
declare module 'monaco-editor/esm/vs/editor/edcore.main' {
  export * from 'monaco-editor'
}

declare module 'monaco-editor/esm/vs/basic-languages/*'
declare module 'monaco-editor/esm/vs/language/*'
