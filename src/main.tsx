import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { DialogProvider } from './components/dialogs/DialogProvider'
import './styles/index.css'

// @monaco-editor/react rejects with a bare `Canceled` error when an editor
// model is disposed mid-operation. It is benign and not actionable.
function isMonacoCancellation(reason: unknown): boolean {
  return reason instanceof Error && reason.message === 'Canceled' && reason.name === 'Canceled'
}

window.addEventListener('unhandledrejection', (event) => {
  if (isMonacoCancellation(event.reason)) event.preventDefault()
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <DialogProvider>
      <App />
    </DialogProvider>
  </StrictMode>,
)
