// Sound manager: one Howl per id from /audio/manifest.json, music crossfades, VO ducks music.
import { Howl, Howler } from 'howler'

type Kind = 'vo' | 'sfx' | 'music'
interface Entry { id: string; file: string; kind: Kind; loop?: boolean; duration_ms?: number; text?: string }

const VOL: Record<Kind, number> = { vo: 1, sfx: 0.8, music: 0.42 }
const howls = new Map<string, Howl>()
let manifest: Map<string, Entry> | null = null
let loading: Promise<void> | null = null
let musicId: string | null = null
let muted = false
let duckDepth = 0

try { muted = localStorage.getItem('ts-muted') === '1' } catch { /* storage blocked */ }
Howler.mute(muted)

async function load(): Promise<void> {
  if (manifest) return
  if (!loading) {
    loading = fetch('/audio/manifest.json')
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: Entry[] | { entries: Entry[] }) => {
        const list = Array.isArray(rows) ? rows : rows.entries ?? []
        manifest = new Map(list.map((e) => [e.id, e]))
      })
      .catch(() => { manifest = new Map() })
  }
  return loading
}

function howl(id: string): Howl | null {
  const e = manifest?.get(id)
  if (!e) return null
  let h = howls.get(id)
  if (!h) {
    const src = e.file.startsWith('/') ? e.file : e.file.startsWith('audio/') ? `/${e.file}` : `/audio/${e.file}`
    h = new Howl({ src: [src], loop: !!e.loop, volume: VOL[e.kind], preload: true })
    howls.set(id, h)
  }
  return h
}

export const sound = {
  async init() { await load() },
  /** preload a set of ids so the first hit has no latency */
  async warm(ids: string[]) { await load(); ids.forEach((i) => howl(i)) },
  play(id: string, opts: { rate?: number; volume?: number } = {}) {
    if (!manifest) { void load().then(() => sound.play(id, opts)); return }
    const h = howl(id)
    if (!h) return
    const pid = h.play()
    if (opts.rate) h.rate(opts.rate, pid)
    if (opts.volume !== undefined) h.volume(opts.volume, pid)
    if (manifest.get(id)?.kind === 'vo') duck(h, pid)
  },
  /** play one of several variants, e.g. pick('punch_light', 3) -> punch_light_1..3 */
  pick(base: string, n: number, opts?: { rate?: number; volume?: number }) {
    const i = 1 + Math.floor(Math.random() * n)
    sound.play(manifest?.has(`${base}_${i}`) ? `${base}_${i}` : base, opts)
  },
  async music(id: string | null, fadeMs = 700) {
    await load()
    if (musicId === id) return
    const prev = musicId ? howls.get(musicId) : null
    if (prev) { const p = prev; p.fade(p.volume(), 0, fadeMs); setTimeout(() => p.stop(), fadeMs + 30) }
    musicId = id
    if (!id) return
    const h = howl(id)
    if (!h) return
    h.volume(0)
    h.play()
    h.fade(0, VOL.music, fadeMs)
  },
  stop(id: string) { howls.get(id)?.stop() },
  stopAll() { howls.forEach((h) => h.stop()); musicId = null },
  isMuted() { return muted },
  setMuted(m: boolean) {
    muted = m
    Howler.mute(m)
    try { localStorage.setItem('ts-muted', m ? '1' : '0') } catch { /* storage blocked */ }
  },
  /** a fighter's battle cry from the worker's TTS cache; silent if unavailable */
  cry(hash: string) {
    if (!hash || muted) return
    fetch(`/api/cry/${hash}`, { method: 'HEAD' }).then((r) => { if (r.ok && (r.headers.get('content-type') ?? '').includes('audio')) sound.url(`/api/cry/${hash}`, 1) }).catch(() => { /* no TTS endpoint */ })
  },
  /** play an arbitrary URL (runtime TTS battle cries) */
  url(src: string, volume = 1) {
    const h = new Howl({ src: [src], volume, format: ['mp3'] })
    const pid = h.play()
    duck(h, pid)
    h.once('end', () => h.unload())
  },
}

function duck(h: Howl, pid: number) {
  const m = musicId ? howls.get(musicId) : null
  if (!m) return
  duckDepth++
  m.fade(m.volume(), VOL.music * 0.35, 120)
  const restore = () => {
    duckDepth = Math.max(0, duckDepth - 1)
    if (duckDepth === 0 && musicId && howls.get(musicId) === m) m.fade(m.volume(), VOL.music, 400)
  }
  h.once('end', restore, pid)
  h.once('stop', restore, pid)
}
