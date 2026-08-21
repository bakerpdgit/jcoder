import { useCallback, useEffect, useMemo, useRef } from 'react'
import Editor, { type OnMount } from '@monaco-editor/react'
import type { editor as MonacoEditor, IDisposable } from 'monaco-editor'
import type { CompilerDiagnostic, Theme } from '../types'
import { monaco, setupMonaco } from '../utils/monacoSetup'
import { monacoLanguageForFile } from '../utils/languages'

setupMonaco()

export interface EditorHandle {
  revealPosition(line: number, column: number): void
}

interface Props {
  path: string | null
  value: string
  diagnostics: CompilerDiagnostic[]
  theme: Theme
  readOnly?: boolean
  onChange: (value: string) => void
  onSave: () => void
  onRun: () => void
  handleRef?: (handle: EditorHandle | null) => void
}

export function CodeEditor({
  path, value, diagnostics, theme, readOnly, onChange, onSave, onRun, handleRef,
}: Props) {
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null)
  const disposablesRef = useRef<IDisposable[]>([])
  // Keep the latest callbacks reachable from Monaco commands, which are bound
  // once at mount and would otherwise capture stale closures.
  const onSaveRef = useRef(onSave)
  const onRunRef = useRef(onRun)
  onSaveRef.current = onSave
  onRunRef.current = onRun

  const language = useMemo(() => (path ? monacoLanguageForFile(path) : 'plaintext'), [path])

  const handleMount = useCallback<OnMount>((editorInstance) => {
    editorRef.current = editorInstance
    disposablesRef.current.push(
      editorInstance.addAction({
        id: 'jcoder.save',
        label: 'Save file',
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
        run: () => onSaveRef.current(),
      }),
      editorInstance.addAction({
        id: 'jcoder.run',
        label: 'Run',
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, monaco.KeyCode.F5],
        run: () => onRunRef.current(),
      }),
    )
    handleRef?.({
      revealPosition: (line, column) => {
        editorInstance.revealPositionInCenter({ lineNumber: line, column })
        editorInstance.setPosition({ lineNumber: line, column })
        editorInstance.focus()
      },
    })
  }, [handleRef])

  useEffect(() => () => {
    for (const disposable of disposablesRef.current) disposable.dispose()
    disposablesRef.current = []
    handleRef?.(null)
  }, [handleRef])

  // Push compiler diagnostics for the open file onto the model as markers.
  useEffect(() => {
    const model = editorRef.current?.getModel()
    if (!model) return
    const forThisFile = diagnostics.filter(d => d.file === path)
    monaco.editor.setModelMarkers(model, 'javac', forThisFile.map(d => ({
      severity: d.severity === 'error'
        ? monaco.MarkerSeverity.Error
        : d.severity === 'warning'
          ? monaco.MarkerSeverity.Warning
          : monaco.MarkerSeverity.Info,
      message: d.message,
      startLineNumber: d.line,
      startColumn: d.column,
      endLineNumber: d.endLine,
      endColumn: Math.max(d.endColumn, d.column + 1),
    })))
  }, [diagnostics, path, value])

  if (!path) {
    return (
      <div className="flex h-full items-center justify-center rounded-xl border border-slate-700 bg-slate-900/60 text-sm text-slate-500">
        Select a file in the sidebar to start editing.
      </div>
    )
  }

  return (
    <div className="h-full min-h-0 overflow-hidden rounded-xl border border-slate-700">
      <Editor
        path={path}
        language={language}
        value={value}
        theme={theme === 'dark' ? 'vs-dark' : 'vs'}
        onMount={handleMount}
        onChange={(next) => onChange(next ?? '')}
        options={{
          readOnly,
          fontSize: 14,
          fontFamily: 'Consolas, "Courier New", ui-monospace, monospace',
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          automaticLayout: true,
          tabSize: 4,
          insertSpaces: true,
          renderWhitespace: 'selection',
          smoothScrolling: true,
          bracketPairColorization: { enabled: true },
        }}
      />
    </div>
  )
}
