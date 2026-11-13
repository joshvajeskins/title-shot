import type { AnchorHTMLAttributes } from 'react'
import { onLinkClick } from '../lib/router'

export function Link(props: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  const { onClick, ...rest } = props
  return <a {...rest} onClick={(e) => { onClick?.(e); onLinkClick(e) }} />
}

export function Wordmark({ size = 28, className = '' }: { size?: number; className?: string }) {
  return (
    <span className={`display print wordmark ${className}`} style={{ fontSize: size }} aria-label="Title Shot">
      Title<span className="wordmark-shot">Shot</span>
    </span>
  )
}
