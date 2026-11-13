// Battle-cry voices: deterministic choice from fighter_voices.json by style, school and the fighter hash.
import voices from '../../public/audio/fighter_voices.json'

export interface VoiceRow { key: string; voice_id: string; model_id: string; stability: number; similarity_boost: number }
export const VOICES = (voices as { fighters: VoiceRow[] }).fighters

const BY_STYLE: Record<string, string[]> = {
  BRAWLER: ['gruff_veteran', 'theatrical_villain', 'hyper_teen'],
  TACTICIAN: ['calm_monk', 'regal_grand', 'deadpan_robot'],
  COUNTERPUNCHER: ['sweet_elderly', 'gruff_veteran', 'calm_monk'],
  SHOWBOAT: ['theatrical_villain', 'hyper_teen', 'regal_grand', 'squeaky_tiny'],
}
const BY_SCHOOL: Record<string, string[]> = {
  BLAZE: ['theatrical_villain', 'hyper_teen'],
  TIDE: ['calm_monk', 'regal_grand'],
  VOLT: ['deadpan_robot', 'squeaky_tiny'],
  IRON: ['gruff_veteran', 'regal_grand'],
  MIND: ['calm_monk', 'deadpan_robot'],
  WILD: ['squeaky_tiny', 'sweet_elderly'],
}

/** Same (school, style, hash) always gives the same voice. */
export function pickVoice(school: string, style: string, hashHex: string): VoiceRow {
  const keys: string[] = []
  for (const k of [...(BY_STYLE[style] ?? []), ...(BY_SCHOOL[school] ?? [])]) if (!keys.includes(k)) keys.push(k)
  const pool = keys.map((k) => VOICES.find((v) => v.key === k)).filter((v): v is VoiceRow => !!v)
  const list = pool.length ? pool : VOICES
  const n = parseInt(hashHex.slice(0, 8), 16) >>> 0
  return list[n % list.length]!
}

/** Letters, digits and light punctuation only, max 60 chars, collapsed spaces. Empty string = nothing to say. */
export function cleanCry(cry: string): string {
  const kept = cry.replace(/\[[^\]]*\]|<[^>]*>|\{[^}]*\}/g, ' ').replace(/[^\p{L}\p{N} .,!?'’:;-]/gu, ' ').replace(/\s+([.,!?;:])/g, '$1').replace(/\s+/g, ' ').trim()
  return Array.from(kept).slice(0, 60).join('').trim()
}
