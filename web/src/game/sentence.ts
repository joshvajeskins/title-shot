// The player-sentence rules, one implementation for the browser, the Pages Functions and the tests. They mirror the Rust
// crate (crates/bout-sim/src/spec.rs `check_sentence`, `is_invisible`): 3..=120 characters counted as Unicode code points
// (not UTF-16 units: an emoji is one), no control characters and none of the invisible or bidi-control characters.
// The server still runs the wasm `checkSentence` as the final authority; this gives the player the same answer instantly.

export const SENTENCE_MIN = 3
export const SENTENCE_MAX = 120

// Exactly Rust's `char::is_whitespace` (Unicode White_Space), which is what the contract's split_whitespace uses. JS `\s`
// and trim() differ: they also take U+FEFF and miss U+0085, which would change the hash after a reload.
const cp = String.fromCharCode
const WS = new RegExp(`[\\t-\\r \\x85\\xa0${cp(0x1680)}${cp(0x2000)}-${cp(0x200a)}${cp(0x2028)}${cp(0x2029)}${cp(0x202f)}${cp(0x205f)}${cp(0x3000)}]+`, 'g')

/** Collapse every run of whitespace to one space and trim: the form that is hashed and stored. */
export function cleanSentence(s: string): string {
  return s.replace(WS, ' ').replace(/^ | $/g, '')
}

/** Characters that render as nothing or reorder text (the same set as `is_invisible` in the Rust crate). */
export function isInvisible(c: number): boolean {
  return c === 0x00ad || c === 0x034f || c === 0x061c || c === 0x115f || c === 0x1160 || c === 0x17b4 || c === 0x17b5 || c === 0x180e
    || (c >= 0x200b && c <= 0x200f) || (c >= 0x202a && c <= 0x202e) || (c >= 0x2060 && c <= 0x2064) || (c >= 0x2066 && c <= 0x2069)
    || c === 0x2800 || c === 0x3164 || c === 0xfeff || c === 0xffa0 || (c >= 0xe0000 && c <= 0xe007f)
}

/** Rust `char::is_control` (general category Cc): C0, DEL and C1. */
const isControl = (c: number): boolean => c <= 0x1f || (c >= 0x7f && c <= 0x9f)

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/

/** A player-readable reason the sentence cannot be used, or null when it passes. */
export function sentenceProblem(s: string): string | null {
  const c = cleanSentence(s)
  if (LONE_SURROGATE.test(c)) return 'That text has a broken character in it.'
  const points = Array.from(c)
  if (points.length < SENTENCE_MIN) return 'Give it at least a few words.'
  if (points.length > SENTENCE_MAX) return 'Keep it under 120 characters.'
  for (const ch of points) {
    const code = ch.codePointAt(0)!
    if (isControl(code)) return 'No control characters.'
    if (isInvisible(code)) return 'No invisible or direction-changing characters.'
  }
  return null
}
