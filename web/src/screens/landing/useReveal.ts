import { useEffect, type RefObject } from 'react'

/**
 * Card-in on scroll: every [data-reveal] under `root` gets `.is-in` the first time it enters the viewport.
 * Content is visible without JS; `.reveal-on` (set here) is what hides it until it scrolls in.
 */
export function useReveal(root: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = root.current
    if (!el) return
    const items = Array.from(el.querySelectorAll<HTMLElement>('[data-reveal]'))
    if (typeof IntersectionObserver === 'undefined') return
    el.classList.add('reveal-on')
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue
        e.target.classList.add('is-in')
        io.unobserve(e.target)
      }
    }, { rootMargin: '0px 0px -10% 0px', threshold: 0 })
    items.forEach((i) => io.observe(i))
    return () => io.disconnect()
  }, [root])
}
