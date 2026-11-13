import { useEffect, useState } from 'react'

type Listener = () => void
const listeners = new Set<Listener>()

export function navigate(to: string, opts: { replace?: boolean } = {}) {
  if (to === location.pathname + location.search) return
  if (opts.replace) history.replaceState(null, '', to)
  else history.pushState(null, '', to)
  window.scrollTo({ top: 0 })
  listeners.forEach((l) => l())
}

window.addEventListener('popstate', () => listeners.forEach((l) => l()))

export function usePath(): string {
  const [path, setPath] = useState(location.pathname)
  useEffect(() => {
    const l = () => setPath(location.pathname)
    listeners.add(l)
    return () => { listeners.delete(l) }
  }, [])
  return path
}

/** match('/play/belt/:id', '/play/belt/tide') -> { id: 'tide' } */
export function match(pattern: string, path: string): Record<string, string> | null {
  const a = pattern.split('/').filter(Boolean)
  const b = path.split('/').filter(Boolean)
  if (a.length !== b.length) return null
  const out: Record<string, string> = {}
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith(':')) out[a[i].slice(1)] = decodeURIComponent(b[i])
    else if (a[i] !== b[i]) return null
  }
  return out
}

/** Intercept same-origin <a> clicks so internal links use the client router. */
export function onLinkClick(e: React.MouseEvent<HTMLAnchorElement>) {
  const a = e.currentTarget
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || a.target === '_blank') return
  const url = new URL(a.href)
  if (url.origin !== location.origin) return
  e.preventDefault()
  navigate(url.pathname + url.search)
}
