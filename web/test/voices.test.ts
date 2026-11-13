import { describe, expect, it } from 'vitest'
import { cleanCry, pickVoice, VOICES } from '../functions/_lib/voices'

const SCHOOLS = ['BLAZE', 'TIDE', 'VOLT', 'IRON', 'MIND', 'WILD']
const STYLES = ['BRAWLER', 'TACTICIAN', 'COUNTERPUNCHER', 'SHOWBOAT']
const hash = (n: number) => n.toString(16).padStart(8, '0') + '0'.repeat(56)

describe('battle-cry voice selection is deterministic', () => {
  it('same inputs, same voice, every time', () => {
    for (const sc of SCHOOLS) for (const st of STYLES) for (let i = 0; i < 20; i++) expect(pickVoice(sc, st, hash(i * 7919)).voice_id).toBe(pickVoice(sc, st, hash(i * 7919)).voice_id)
  })
  it('only picks voices from fighter_voices.json', () => {
    const ids = new Set(VOICES.map((v) => v.voice_id))
    for (const sc of SCHOOLS) for (const st of STYLES) for (let i = 0; i < 50; i++) expect(ids.has(pickVoice(sc, st, hash(i)).voice_id)).toBe(true)
  })
  it('different hashes spread across more than one voice for a style', () => {
    const used = new Set(Array.from({ length: 40 }, (_, i) => pickVoice('BLAZE', 'SHOWBOAT', hash(i)).key))
    expect(used.size).toBeGreaterThan(1)
  })
  it('style shapes the choice: an iron brawler is never the squeaky critter', () => {
    for (let i = 0; i < 60; i++) expect(pickVoice('IRON', 'BRAWLER', hash(i)).key).not.toBe('squeaky_tiny')
  })
  it('unknown school and style still return a voice', () => expect(pickVoice('NOPE', 'NOPE', hash(3)).voice_id).toBeTruthy())
  it('a malformed hash cannot crash selection', () => expect(pickVoice('MIND', 'TACTICIAN', 'zz').voice_id).toBeTruthy())
})

describe('cry text filter (<= 60 chars, letters and light punctuation only)', () => {
  it('keeps normal cries', () => expect(cleanCry('I object! Also, crumbs.')).toBe('I object! Also, crumbs.'))
  it('strips audio tags, markup and symbols so the TTS cannot be steered', () => {
    expect(cleanCry('[whispers] <b>Fear</b> my {crumb-fire}!!!')).toBe('Fear my!!!')
    expect(cleanCry('https://evil.test/x?a=1&b=2')).not.toMatch(/[/=&]/)
  })
  it('caps at 60 characters by code point', () => expect(Array.from(cleanCry('é'.repeat(100))).length).toBe(60))
  it('collapses whitespace and returns empty for nothing speakable', () => {
    expect(cleanCry('a   \n\t b')).toBe('a b')
    expect(cleanCry('@@@###$$$')).toBe('')
    expect(cleanCry('')).toBe('')
  })
  it('keeps non-latin letters', () => expect(cleanCry('こんにちは 勝つ!')).toBe('こんにちは 勝つ!'))
})
