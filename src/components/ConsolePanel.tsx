import { useEffect, useRef, useState } from 'react'
import type { CompilerDiagnostic } from '../types'
import type { ConsoleChunk } from '../hooks/useRunner'
import { IconButton } from './ui/IconButton'
import { splitPastedInput } from '../utils/consoleInput'

type Tab = 'console' | 'problems' | 'inputs'

interface Props {
  output: ConsoleChunk[]
  diagnostics: CompilerDiagnostic[]
  awaitingInput: boolean
  inputSupported: boolean
  inputUnavailableReason: string | null
  fixedInput: string
  onFixedInputChange: (text: string) => void
  running: boolean
  lastExitCode: number | null
  onSubmitInput: (line: string) => void
  onQueueInput: (lines: string[]) => void
  onEndInput: () => void
  onClear: () => void
  onSelectDiagnostic: (diagnostic: CompilerDiagnostic) => void
}

const CHUNK_CLASS: Record<ConsoleChunk['kind'], string> = {
  out: 'text-slate-200',
  err: 'text-red-300',
  system: 'text-slate-500 italic',
  input: 'text-emerald-300',
}

export function ConsolePanel({
  output, diagnostics, awaitingInput, inputSupported, inputUnavailableReason, running, lastExitCode,
  fixedInput, onFixedInputChange,
  onSubmitInput, onQueueInput, onEndInput, onClear, onSelectDiagnostic,
}: Props) {
  const [tab, setTab] = useState<Tab>('console')
  const [draft, setDraft] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const errorCount = diagnostics.filter(d => d.severity === 'error').length
  const warningCount = diagnostics.filter(d => d.severity === 'warning').length

  useEffect(() => {
    const element = scrollRef.current
    if (element) element.scrollTop = element.scrollHeight
  }, [output, tab])

  useEffect(() => {
    if (awaitingInput) inputRef.current?.focus()
  }, [awaitingInput])

  // The caret is in the console, so the console has to be the visible tab.
  useEffect(() => {
    if (awaitingInput) setTab('console')
  }, [awaitingInput])

  // Pressing Run means wanting to see output — typically right after filling in
  // the Inputs tab, which would otherwise stay in front of it. Errors still
  // pull focus to Problems afterwards.
  useEffect(() => {
    if (running) setTab('console')
  }, [running])

  // Compiler errors are the thing you want to see, so surface them without a click.
  useEffect(() => {
    if (errorCount > 0) setTab('problems')
  }, [errorCount, diagnostics])

  const submit = () => {
    onSubmitInput(draft)
    setDraft('')
  }

  return (
    <section className="flex h-full min-h-0 flex-col rounded-xl border border-slate-700 bg-slate-900/60">
      <header className="flex items-center gap-1 border-b border-slate-700 px-2 py-1">
        <TabButton active={tab === 'console'} onClick={() => setTab('console')}>Console</TabButton>
        <TabButton active={tab === 'inputs'} onClick={() => setTab('inputs')}>
          Inputs
          {fixedInput.trim() !== '' && <span className="ml-1.5 rounded-full bg-slate-600 px-1.5 text-[10px] text-white">{fixedInput.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n').length}</span>}
        </TabButton>
        <TabButton active={tab === 'problems'} onClick={() => setTab('problems')}>
          Problems
          {errorCount > 0 && <span className="ml-1.5 rounded-full bg-red-600 px-1.5 text-[10px] text-white">{errorCount}</span>}
          {errorCount === 0 && warningCount > 0 && (
            <span className="ml-1.5 rounded-full bg-amber-600 px-1.5 text-[10px] text-white">{warningCount}</span>
          )}
        </TabButton>

        <div className="ml-auto flex items-center gap-2">
          {lastExitCode !== null && !running && (
            <span className={`text-xs ${lastExitCode === 0 ? 'text-slate-500' : 'text-red-300'}`}>
              exited with code {lastExitCode}
            </span>
          )}
          {running && <span className="text-xs text-emerald-300">running…</span>}
          <IconButton label="Clear console" onClick={onClear} className="!h-7 !w-7">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" />
            </svg>
          </IconButton>
        </div>
      </header>

      {tab === 'console' ? (
        <>
          {/* The prompt lives *inside* the output rather than in a separate box,
              so a program that writes "Name? " and then reads shows the caret
              exactly where a real console would put it. Clicking anywhere in
              the output focuses it. */}
          <div
            ref={scrollRef}
            onMouseUp={() => { if (awaitingInput && !window.getSelection()?.toString()) inputRef.current?.focus() }}
            className={`min-h-0 flex-1 overflow-auto bg-slate-950/60 px-3 py-2 font-mono text-[13px] leading-relaxed ${awaitingInput ? 'cursor-text' : ''}`}
          >
            {output.length === 0 && !awaitingInput ? (
              <p className="text-slate-500">Program output appears here.</p>
            ) : (
              <pre className="console-line m-0">
                {output.map(chunk => (
                  <span key={chunk.id} className={CHUNK_CLASS[chunk.kind]}>{chunk.text}</span>
                ))}
                {awaitingInput && (
                  <input
                    ref={inputRef}
                    aria-label="Console input line"
                    name="console-input"
                    value={draft}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { e.preventDefault(); submit() }
                      if (e.key === 'd' && e.ctrlKey) { e.preventDefault(); onEndInput() }
                    }}
                    onPaste={(e) => {
                      const pasted = e.clipboardData.getData('text')
                      if (!/[\r\n]/.test(pasted)) return  // let the browser handle it
                      e.preventDefault()
                      const { submit: lines, draft: remaining } = splitPastedInput(
                        pasted, draft, e.currentTarget.selectionStart ?? draft.length,
                        e.currentTarget.selectionEnd ?? draft.length,
                      )
                      setDraft(remaining)
                      // Queue the rest *before* releasing the program, so it is
                      // already answered when it asks for the next line.
                      onQueueInput(lines.slice(1))
                      onSubmitInput(lines[0])
                    }}
                    className="console-inline-input"
                    style={{ width: `${Math.max(draft.length, 1)}ch` }}
                  />
                )}
              </pre>
            )}
          </div>

          <div className="flex items-center gap-2 border-t border-slate-700 px-2 py-1.5">
            {!inputSupported ? (
              <p className="text-xs text-amber-300">{inputUnavailableReason}</p>
            ) : awaitingInput ? (
              <>
                <span className="text-xs text-emerald-300">Waiting for input — type a line and press Enter.</span>
                <button
                  type="button"
                  onClick={onEndInput}
                  title="Signal end of input (Ctrl+D) — the program then sees the end of the stream"
                  className="ml-auto rounded-md border border-slate-600 px-2 py-1 text-xs text-slate-300 hover:bg-slate-700"
                >
                  End input
                </button>
              </>
            ) : (
              <p className="text-xs text-slate-500">
                Typed input appears here when the program calls <code>nextLine()</code>.
                Lines in the Inputs tab are used first.
              </p>
            )}
          </div>
        </>
      ) : tab === 'inputs' ? (
        <div className="flex min-h-0 flex-1 flex-col gap-1 bg-slate-950/60 p-2">
          <p className="text-xs text-slate-400">
            One line per <code>nextLine()</code>. These are consumed from the top on every run,
            so a run always starts from the first line.
          </p>
          <textarea
            aria-label="Program input"
            name="program-input"
            value={fixedInput}
            onChange={(event) => onFixedInputChange(event.target.value)}
            spellCheck={false}
            placeholder="Enter fixed inputs here, one per line…"
            className="min-h-0 flex-1 resize-none rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 font-mono text-[13px] text-slate-100 outline-none placeholder:text-slate-600 focus:border-emerald-500"
          />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto bg-slate-950/60">
          {diagnostics.length === 0 ? (
            <p className="px-3 py-2 text-sm text-slate-500">No problems.</p>
          ) : (
            <ul>
              {diagnostics.map((diagnostic, index) => (
                <li key={`${diagnostic.id}-${index}`}>
                  <button
                    type="button"
                    onClick={() => onSelectDiagnostic(diagnostic)}
                    className="flex w-full items-start gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-slate-700/60"
                  >
                    <span className={diagnostic.severity === 'error' ? 'text-red-400' : diagnostic.severity === 'warning' ? 'text-amber-400' : 'text-slate-400'}>
                      {diagnostic.severity === 'error' ? '✕' : diagnostic.severity === 'warning' ? '⚠' : 'ℹ'}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="whitespace-pre-wrap text-slate-200">{diagnostic.message}</span>
                      <span className="ml-2 text-xs text-slate-500">
                        {diagnostic.id}
                        {diagnostic.file ? ` · ${diagnostic.file}:${diagnostic.line}:${diagnostic.column}` : ''}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  )
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center rounded-md px-2.5 py-1 text-xs font-medium ${
        active ? 'bg-slate-700 text-slate-100' : 'text-slate-400 hover:bg-slate-700/60 hover:text-slate-100'
      }`}
    >
      {children}
    </button>
  )
}
