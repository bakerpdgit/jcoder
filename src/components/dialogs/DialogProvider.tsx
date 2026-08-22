import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'

/**
 * Promise-based, theme-aware replacements for window.confirm/prompt/alert.
 * Native browser dialogs are never used in this app: they ignore the theme and
 * they block the whole page, including the runner worker's message pump.
 */

interface ConfirmOptions {
  title?: string
  message: string
  warning?: string
  confirmLabel?: string
  cancelLabel?: string
  destructive?: boolean
}

interface PromptOptions {
  title?: string
  message: string
  initialValue?: string
  placeholder?: string
  confirmLabel?: string
  validate?: (value: string) => string | null
}

interface AlertOptions {
  title?: string
  message: string
}

export interface ChoiceOption {
  /** Returned by `choose` when this one is picked. */
  value: string
  label: string
  /** The consequence of picking it, which is usually the important part. */
  description?: string
  destructive?: boolean
}

interface ChooseOptions {
  title?: string
  message: string
  warning?: string
  choices: ChoiceOption[]
  cancelLabel?: string
}

interface DialogApi {
  confirm(options: ConfirmOptions): Promise<boolean>
  prompt(options: PromptOptions): Promise<string | null>
  alert(options: AlertOptions): Promise<void>
  /**
   * More than two ways forward — returns the chosen `value`, or null if the
   * user backed out. A confirm cannot express "do it, but differently".
   */
  choose(options: ChooseOptions): Promise<string | null>
}

const DialogContext = createContext<DialogApi | null>(null)

export function useDialogs(): DialogApi {
  const api = useContext(DialogContext)
  if (!api) throw new Error('useDialogs must be used inside <DialogProvider>')
  return api
}

type ActiveDialog =
  | { kind: 'confirm'; options: ConfirmOptions }
  | { kind: 'prompt'; options: PromptOptions }
  | { kind: 'alert'; options: AlertOptions }
  | { kind: 'choose'; options: ChooseOptions }

export function DialogProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState<ActiveDialog | null>(null)
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const resolverRef = useRef<((result: unknown) => void) | null>(null)

  const settle = useCallback((result: unknown) => {
    resolverRef.current?.(result)
    resolverRef.current = null
    setActive(null)
    setError(null)
    setValue('')
  }, [])

  const api = useMemo<DialogApi>(() => ({
    confirm: (options) => new Promise<boolean>((resolve) => {
      resolverRef.current = resolve as (result: unknown) => void
      setActive({ kind: 'confirm', options })
    }),
    prompt: (options) => new Promise<string | null>((resolve) => {
      resolverRef.current = resolve as (result: unknown) => void
      setValue(options.initialValue ?? '')
      setActive({ kind: 'prompt', options })
    }),
    alert: (options) => new Promise<void>((resolve) => {
      resolverRef.current = resolve as (result: unknown) => void
      setActive({ kind: 'alert', options })
    }),
    choose: (options) => new Promise<string | null>((resolve) => {
      resolverRef.current = resolve as (result: unknown) => void
      setActive({ kind: 'choose', options })
    }),
  }), [])

  const submitPrompt = () => {
    if (active?.kind !== 'prompt') return
    const trimmed = value.trim()
    const validationError = active.options.validate?.(trimmed) ?? null
    if (validationError) { setError(validationError); return }
    settle(trimmed)
  }

  return (
    <DialogContext.Provider value={api}>
      {children}
      {active && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={(e) => {
            if (e.target !== e.currentTarget) return
            if (active.kind === 'prompt' || active.kind === 'choose') settle(null)
            else settle(active.kind === 'confirm' ? false : undefined)
          }}
        >
          <div className="modal-card" role="dialog" aria-modal="true">
            {active.options.title && (
              <h2 className="mb-2 text-base font-semibold text-slate-100">{active.options.title}</h2>
            )}
            <p className="whitespace-pre-wrap text-sm text-slate-300">{active.options.message}</p>

            {(active.kind === 'confirm' || active.kind === 'choose') && active.options.warning && (
              <p className="confirm-warning mt-3 rounded-lg px-3 py-2 text-xs">{active.options.warning}</p>
            )}

            {active.kind === 'choose' && (
              // Stacked rather than a row of buttons: each option carries a
              // sentence explaining what it will do, which is the whole point.
              <div className="mt-3 flex flex-col gap-2">
                {active.options.choices.map(choice => (
                  <button
                    key={choice.value}
                    type="button"
                    onClick={() => settle(choice.value)}
                    className={`rounded-lg border px-3 py-2 text-left ${
                      choice.destructive
                        ? 'border-red-500/60 hover:bg-red-500/10'
                        : 'border-slate-600 hover:border-emerald-500 hover:bg-slate-700/60'
                    }`}
                  >
                    <span className="block text-sm font-medium text-slate-100">{choice.label}</span>
                    {choice.description && (
                      <span className="mt-0.5 block text-xs text-slate-400">{choice.description}</span>
                    )}
                  </button>
                ))}
              </div>
            )}

            {active.kind === 'prompt' && (
              <>
                <input
                  autoFocus
                  value={value}
                  placeholder={active.options.placeholder}
                  onChange={(e) => { setValue(e.target.value); setError(null) }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); submitPrompt() }
                    if (e.key === 'Escape') settle(null)
                  }}
                  className="mt-3 w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-emerald-400"
                />
                {error && <p className="mt-2 text-xs text-red-300">{error}</p>}
              </>
            )}

            <div className="mt-4 flex justify-end gap-2">
              {active.kind !== 'alert' && (
                <button
                  type="button"
                  onClick={() => settle(active.kind === 'confirm' ? false : null)}
                  className="rounded-lg border border-slate-600 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-700"
                >
                  {active.kind === 'confirm' || active.kind === 'choose'
                    ? (active.options.cancelLabel ?? 'Cancel')
                    : 'Cancel'}
                </button>
              )}
              {/* The choices are the buttons for a `choose`, so there is no
                  separate confirming one. */}
              {active.kind !== 'choose' && (
              <button
                type="button"
                autoFocus={active.kind !== 'prompt'}
                onClick={() => {
                  if (active.kind === 'prompt') submitPrompt()
                  else settle(active.kind === 'confirm' ? true : undefined)
                }}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium text-white ${
                  active.kind === 'confirm' && active.options.destructive
                    ? 'bg-red-600 hover:bg-red-500'
                    : 'bg-emerald-600 hover:bg-emerald-500'
                }`}
              >
                {active.kind === 'confirm'
                  ? (active.options.confirmLabel ?? 'OK')
                  : active.kind === 'prompt'
                    ? (active.options.confirmLabel ?? 'OK')
                    : 'OK'}
              </button>
              )}
            </div>
          </div>
        </div>
      )}
    </DialogContext.Provider>
  )
}
