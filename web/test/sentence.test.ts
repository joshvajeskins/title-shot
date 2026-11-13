// Client-side sentence rules (code points, invisible/bidi characters) kept in step with the Rust crate, and the refund wording.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ROOT, sim } from './helpers'
import { challenge } from './fixtures'
import { cleanSentence, isInvisible, SENTENCE_MAX, sentenceProblem } from '../src/game/sentence'
import * as client from '../src/game/client'
import { describeChallenge, messageFor, refundMessageFor } from '../src/game/chain/errors'

const cp = (...n: number[]) => String.fromCodePoint(...n)

describe('sentence length counts Unicode code points', () => {
  it('120 emoji pass (240 UTF-16 units) and 121 do not', () => {
    expect(sentenceProblem('🥊'.repeat(120))).toBeNull()
    expect(sentenceProblem('🥊'.repeat(121))).toBe('Keep it under 120 characters.')
  })
  it('3 emoji are long enough (6 UTF-16 units must not be what is counted) and 2 are not', () => {
    expect(sentenceProblem('🥊🥊🥊')).toBeNull()
    expect(sentenceProblem('🥊🥊')).toBe('Give it at least a few words.')
    expect('👨‍👩‍👧'.length).toBeGreaterThan(Array.from('👨‍👩‍👧').length) // a ZWJ family is 5 code points, 8 units
  })
  it('astral letters count once each, plain text bounds are 3..120', () => {
    expect(sentenceProblem('𝒜𝒷𝒸')).toBeNull()
    expect(sentenceProblem('ab')).not.toBeNull()
    expect(sentenceProblem('a'.repeat(SENTENCE_MAX))).toBeNull()
    expect(sentenceProblem('a'.repeat(SENTENCE_MAX + 1))).not.toBeNull()
  })
  it('length is taken after whitespace is collapsed, as the contract does', () => {
    expect(sentenceProblem('  a   b  ')).toBeNull() // collapses to "a b": 3 characters
    expect(sentenceProblem('   a      ')).toBe('Give it at least a few words.')
    expect(sentenceProblem(' '.repeat(50) + 'abc' + ' '.repeat(80))).toBeNull() // padding does not count
  })
  it('a lone surrogate (not valid text) is refused instead of being counted as a character', () => {
    expect(sentenceProblem('abc\ud83d')).toBe('That text has a broken character in it.')
    expect(sentenceProblem('\ude00abc')).toBe('That text has a broken character in it.')
    expect(sentenceProblem('a 🥊 b')).toBeNull()
  })
})

describe('control, invisible and bidi characters are rejected with the Rust set', () => {
  const rejected: [string, number][] = [
    ['ARABIC LETTER MARK', 0x061c], ['SOFT HYPHEN', 0x00ad], ['COMBINING GRAPHEME JOINER', 0x034f], ['HANGUL CHOSEONG FILLER', 0x115f], ['HANGUL JUNGSEONG FILLER', 0x1160],
    ['HANGUL FILLER', 0x3164], ['HALFWIDTH HANGUL FILLER', 0xffa0], ['BRAILLE BLANK', 0x2800], ['ZWSP', 0x200b], ['ZWNJ', 0x200c], ['ZWJ', 0x200d], ['LRM', 0x200e], ['RLM', 0x200f],
    ['LRE', 0x202a], ['RLE', 0x202b], ['PDF', 0x202c], ['LRO', 0x202d], ['RLO', 0x202e], ['WORD JOINER', 0x2060], ['FUNCTION APPLICATION', 0x2061], ['INVISIBLE TIMES', 0x2062],
    ['INVISIBLE SEPARATOR', 0x2063], ['INVISIBLE PLUS', 0x2064], ['LRI', 0x2066], ['RLI', 0x2067], ['FSI', 0x2068], ['PDI', 0x2069], ['BOM', 0xfeff], ['KHMER VOWEL INHERENT AQ', 0x17b4],
    ['MONGOLIAN VOWEL SEPARATOR', 0x180e], ['TAG SPACE', 0xe0020], ['CANCEL TAG', 0xe007f], ['TAG NUL', 0xe0000],
    ['NUL', 0x00], ['BEL', 0x07], ['ESC', 0x1b], ['DEL', 0x7f], ['C1 control', 0x90], ['C1 control (APC)', 0x9f],
  ]
  for (const [name, code] of rejected) {
    it(`${name} (U+${code.toString(16).toUpperCase().padStart(4, '0')}) is refused in the middle of a sentence`, () => {
      const s = `a cat ${cp(code)}in a hat`
      expect(sentenceProblem(s), name).not.toBeNull()
      // BOM, NUL and friends are never "whitespace": the cleaned text keeps them, so the server would refuse them too
      expect(cleanSentence(s)).toContain(cp(code))
    })
  }
  it('invisible characters get their own message, controls keep theirs', () => {
    expect(sentenceProblem(`a b${cp(0x202e)}c`)).toBe('No invisible or direction-changing characters.')
    expect(sentenceProblem('a b\u0000c')).toBe('No control characters.')
  })
  it('real whitespace and ordinary punctuation, accents, CJK and emoji are fine', () => {
    for (const ok of ['a pigeon with a law degree', 'café au lait, s’il vous plaît', '日本語の文章です', 'tab\tand\nnewline are just spaces', 'no break　space', "O'Brien & Sons (est. 1990)!", '🥊 vs 🏆']) expect(sentenceProblem(ok), ok).toBeNull()
  })
  it('a sentence made only of invisible characters is refused (not just empty)', () => {
    expect(sentenceProblem(cp(0x200b, 0x200b, 0x200b, 0x200b))).not.toBeNull()
  })
  it('the JS set is exactly the set in crates/bout-sim/src/spec.rs `is_invisible` (fails when the Rust lane changes it and this file is not updated)', () => {
    const src = readFileSync(join(ROOT, 'crates/bout-sim/src/spec.rs'), 'utf8')
    const body = /pub fn is_invisible\(c: char\) -> bool \{([\s\S]*?)\n\}/.exec(src)![1]!
    const rust = new Set<number>()
    for (const m of body.matchAll(/0x([0-9A-Fa-f]+)(?:\.\.=0x([0-9A-Fa-f]+))?/g)) {
      const lo = parseInt(m[1]!, 16), hi = m[2] ? parseInt(m[2], 16) : lo
      for (let c = lo; c <= hi; c++) rust.add(c)
    }
    expect(rust.size).toBeGreaterThan(40)
    const js = new Set<number>()
    for (let c = 0; c <= 0x10ffff; c++) if (isInvisible(c)) js.add(c)
    expect([...js].filter((c) => !rust.has(c))).toEqual([])
    expect([...rust].filter((c) => !js.has(c))).toEqual([])
  })
  it('agrees with the wasm checkSentence on length and the long-standing character classes', () => {
    const s = sim()
    const cases = ['a pigeon with a law degree', '🥊'.repeat(120), '🥊'.repeat(121), '🥊🥊', 'ab', `x${cp(0x202e)}yz`, `x${cp(0x200b)}yz`, 'a b\u0000c', 'a b\u007fc', 'a 🥊 b']
    for (const c of cases) expect(sentenceProblem(c) === null, JSON.stringify(c)).toBe(s.checkSentence(cleanSentence(c)) === null)
  })
})

describe('client.ts still exports the same two functions', () => {
  it('cleanSentence and sentenceProblem are the shared implementation', () => {
    expect(client.sentenceProblem('🥊'.repeat(121))).toBe('Keep it under 120 characters.')
    expect(client.sentenceProblem(`a b${cp(0x061c)}c`)).not.toBeNull()
    expect(client.cleanSentence('  a \t\n b  ')).toBe('a b')
    expect(client.cleanSentence('﻿a b')).toBe('﻿a b') // U+FEFF is not whitespace to Rust, so it stays (and is then refused)
  })
})

describe('a refund after forging reads as a refund', () => {
  it('E_SELF and E_CLOSED on a forged challenge say the toll came back minus the forge fee', () => {
    for (const code of ['E_SELF', 'E_CLOSED']) {
      for (const status of ['Rejected', 'Refunded'] as const) {
        const d = describeChallenge(challenge({ status, code }))
        expect(d).toMatchObject({ phase: 'failed', code, refunded: true })
        expect((d as { message: string }).message).toMatch(/toll came back minus the forge fee/)
      }
    }
    const self = describeChallenge(challenge({ status: 'Rejected', code: 'E_SELF' })) as { message: string }
    expect(self.message).toBe('The belt changed hands while your fighter was forging; your toll came back minus the forge fee.')
  })
  it('E_CLOSED names the season, since the belt may not have moved', () => {
    expect(refundMessageFor('E_CLOSED')).toBe('The season closed while your fighter was forging; your toll came back minus the forge fee.')
  })
  it('before any toll is taken (the challenge call itself refused) the old wording stays', () => {
    expect(messageFor('E_SELF')).toBe('You hold this belt. You cannot challenge yourself.')
    expect(messageFor('E_CLOSED')).toBe('This season is already closed.')
  })
  it('other codes keep their messages; unknown codes still get the generic text', () => {
    expect(refundMessageFor('E_TIMEOUT')).toBe(messageFor('E_TIMEOUT'))
    expect(refundMessageFor('E_WHAT')).toBe('The contract refused: E_WHAT.')
    expect(refundMessageFor(null)).toBe('Something went wrong. Try again.')
  })
})
