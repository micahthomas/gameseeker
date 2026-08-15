import type { RatingSystem } from '~/db/schema'

/**
 * NTRP is the matching currency. Players may enter either NTRP or UTR; UTR is
 * converted to an NTRP equivalent on save and stored alongside the original.
 */

export const NTRP_LEVELS = [2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0, 5.5, 6.0] as const

export const NTRP_DESCRIPTIONS: Record<string, string> = {
  '2.0': 'Learning to play; working on getting the ball in play',
  '2.5': 'Can sustain a short rally with players of similar ability',
  '3.0': 'Fairly consistent on medium-paced shots, limited directional control',
  '3.5': 'Improved directional control, developing spin and net play',
  '4.0': 'Dependable strokes, can use power and spin, teamwork in doubles',
  '4.5': 'Aggressive net play, sound footwork, can vary pace and tactics',
  '5.0': 'Good anticipation, frequent winners, strong shot selection',
  '5.5': 'Power and consistency as major weapons; tournament-level',
  '6.0': 'Sectional and national tournament experience',
}

export const UTR_MIN = 1
export const UTR_MAX = 16.5

/**
 * UTR -> NTRP equivalence.
 *
 * There is no official conversion — UTR is match-result derived and NTRP is
 * assessment based, so any mapping is approximate. These bands follow the
 * commonly cited community table. Tune them here once you see how real Santa
 * Fe players land; nothing else in the system needs to change.
 */
const UTR_TO_NTRP: Array<{ maxUtr: number; ntrp: number }> = [
  { maxUtr: 2.0, ntrp: 2.5 },
  { maxUtr: 3.5, ntrp: 3.0 },
  { maxUtr: 5.0, ntrp: 3.5 },
  { maxUtr: 6.5, ntrp: 4.0 },
  { maxUtr: 8.5, ntrp: 4.5 },
  { maxUtr: 10.5, ntrp: 5.0 },
  { maxUtr: 12.5, ntrp: 5.5 },
  { maxUtr: Infinity, ntrp: 6.0 },
]

export function utrToNtrp(utr: number): number {
  for (const band of UTR_TO_NTRP) {
    if (utr <= band.maxUtr) return band.ntrp
  }
  return 6.0
}

/** The approximate UTR span that maps to a given NTRP level, for display. */
export function ntrpToUtrRange(ntrp: number): [number, number] {
  let lower = UTR_MIN
  for (const band of UTR_TO_NTRP) {
    if (band.ntrp === ntrp) return [lower, Math.min(band.maxUtr, UTR_MAX)]
    lower = band.maxUtr
  }
  return [UTR_MIN, UTR_MAX]
}

/** Snap an arbitrary value to the nearest half-step within the NTRP range. */
export function snapNtrp(value: number): number {
  const snapped = Math.round(value * 2) / 2
  const first = NTRP_LEVELS[0]!
  const last = NTRP_LEVELS[NTRP_LEVELS.length - 1]!
  return Math.min(last, Math.max(first, snapped))
}

/** Convert a player's entered rating into the normalized NTRP used for matching. */
export function normalizeRating(system: RatingSystem, value: number): number {
  return system === 'UTR' ? utrToNtrp(value) : snapNtrp(value)
}

export function isValidRating(system: RatingSystem, value: number): boolean {
  if (!Number.isFinite(value)) return false
  if (system === 'UTR') return value >= UTR_MIN && value <= UTR_MAX
  return value >= 1.0 && value <= 7.0
}

/** "3.5" or "UTR 6.2 (~4.0 NTRP)" */
export function formatRating(system: RatingSystem, value: number, ntrp: number): string {
  if (system === 'UTR') return `UTR ${value} (~${ntrp.toFixed(1)} NTRP)`
  return `${value.toFixed(1)} NTRP`
}

/**
 * The levels a player is offered by default when they first set their rating:
 * their own level, plus the one above it. Most people are happy to play up a
 * step, and it's a single tap to remove.
 */
export function defaultPlayLevels(ntrp: number): number[] {
  const own = snapNtrp(ntrp)
  const next = NTRP_LEVELS.find((level) => level > own)
  return next !== undefined ? [own, next] : [own]
}

/** Keep a level set clean: valid levels only, unique, ascending. */
export function normalizePlayLevels(levels: number[], fallbackNtrp: number): number[] {
  const valid = [...new Set(levels.map(snapNtrp))]
    .filter((level) => (NTRP_LEVELS as readonly number[]).includes(level))
    .sort((a, b) => a - b)
  return valid.length > 0 ? valid : [snapNtrp(fallbackNtrp)]
}

/**
 * The span a game covers, derived from the levels its open seats ask for.
 * Stored on the game for display and for filtering browse lists; the
 * authoritative match is set intersection, not this range.
 */
export function levelSpan(levels: number[]): [number, number] {
  if (levels.length === 0) return [NTRP_LEVELS[0]!, NTRP_LEVELS[NTRP_LEVELS.length - 1]!]
  return [Math.min(...levels), Math.max(...levels)]
}

/** Does this player play at the level this seat is asking for? */
export function playsAtLevel(playLevels: number[], seekerNtrp: number): boolean {
  return playLevels.includes(snapNtrp(seekerNtrp))
}

/** "3.5" or "3.5, 4.0" or "3.0–4.5" once the list gets long. */
export function formatLevels(levels: number[]): string {
  if (levels.length === 0) return '—'
  if (levels.length <= 3) return levels.map((l) => l.toFixed(1)).join(', ')
  const [lo, hi] = levelSpan(levels)
  return `${lo.toFixed(1)}–${hi.toFixed(1)}`
}

/** Label for a GameSeeker slot, e.g. "GameSeeker 3.5". */
export function seekerLabel(ntrp: number): string {
  return `GameSeeker ${ntrp.toFixed(1)}`
}
