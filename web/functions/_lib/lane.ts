// In-isolate serialization. KV has no compare-and-swap, so a counter read-then-write is only exact when the requests that
// touch one key run one after another: a lane per key does that for everything that lands on the same isolate (a burst
// from one client almost always does). Across isolates the limits stay best-effort; the money paths add their own floor.
const tails = new Map<string, Promise<unknown>>()
const depth = new Map<string, number>()

/** Run `f` after every earlier `serialize(key, ...)` has settled. Failures do not block the lane. */
export function serialize<T>(key: string, f: () => Promise<T>): Promise<T> {
  const prev = tails.get(key) ?? Promise.resolve()
  depth.set(key, (depth.get(key) ?? 0) + 1)
  const run = prev.then(f, f)
  const tail = run.then(() => undefined, () => undefined).then(() => {
    const d = (depth.get(key) ?? 1) - 1
    if (d <= 0) { depth.delete(key); tails.delete(key) } else depth.set(key, d)
  })
  tails.set(key, tail)
  return run
}

/** Requests waiting on or running in the lane. */
export const laneDepth = (key: string): number => depth.get(key) ?? 0

const admitted = new Map<string, number>()

/**
 * Take one of `max` slots synchronously (no await between the check and the increment, so concurrent requests on one
 * isolate cannot both pass the check). Returns the release function, or null when full.
 */
export function admit(key: string, max: number): (() => void) | null {
  const n = admitted.get(key) ?? 0
  if (n >= max) return null
  admitted.set(key, n + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    const m = (admitted.get(key) ?? 1) - 1
    if (m <= 0) admitted.delete(key); else admitted.set(key, m)
  }
}
