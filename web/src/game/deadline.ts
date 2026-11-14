// A promise with a deadline: settles like `p`, or rejects with `err()` after `ms`. Nothing on a first paint may hang forever.
export function within<T>(p: Promise<T>, ms: number, err: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(err()), ms)
    p.then((v) => { clearTimeout(t); resolve(v) }, (e: unknown) => { clearTimeout(t); reject(e) })
  })
}
