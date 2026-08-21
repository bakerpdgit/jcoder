import type { ButtonHTMLAttributes, ReactNode } from 'react'

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string
  children: ReactNode
}

export function IconButton({ label, children, className = '', ...rest }: Props) {
  return (
    <button type="button" title={label} aria-label={label} className={`icon-button ${className}`} {...rest}>
      {children}
    </button>
  )
}
