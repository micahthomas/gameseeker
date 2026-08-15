import { describe, expect, it } from 'vitest'
import {
  defaultFormats,
  formatLabel,
  gameFormatOf,
  mixedSeatGenders,
  playerFormat,
  playsFormat,
} from '~/server/formats'

/**
 * The four formats, and the mapping between what a game *is* and what a player
 * opted into. Pure functions, so no database.
 */

describe('mapping a game onto a player format', () => {
  it('names exactly one format per (format, isMixed) pair', () => {
    expect(playerFormat('singles', false)).toBe('singles')
    expect(playerFormat('singles', true)).toBe('mixed_singles')
    expect(playerFormat('doubles', false)).toBe('doubles')
    expect(playerFormat('doubles', true)).toBe('mixed_doubles')
  })

  it('maps back to the shape a format is played in', () => {
    expect(gameFormatOf('mixed_singles')).toBe('singles')
    expect(gameFormatOf('mixed_doubles')).toBe('doubles')
  })
})

describe('opting in', () => {
  it('matches only the exact format', () => {
    const player = ['doubles' as const]
    expect(playsFormat(player, 'doubles', false)).toBe(true)
    expect(playsFormat(player, 'doubles', true)).toBe(false)
    expect(playsFormat(player, 'singles', false)).toBe(false)
  })

  it('does not let mixed imply the plain format, or the reverse', () => {
    // The whole point of four independent opt-ins: someone can want *only*
    // the mixed ones, and inferring otherwise would send them games they
    // never asked for.
    expect(playsFormat(['mixed_doubles'], 'doubles', false)).toBe(false)
    expect(playsFormat(['doubles'], 'doubles', true)).toBe(false)
    expect(playsFormat(['mixed_singles'], 'singles', false)).toBe(false)
  })

  it('treats a missing or empty set as playing nothing', () => {
    expect(playsFormat([], 'singles', false)).toBe(false)
    expect(playsFormat(null, 'singles', false)).toBe(false)
    expect(playsFormat(undefined, 'doubles', false)).toBe(false)
  })

  it('starts a new player on all four', () => {
    expect(defaultFormats()).toHaveLength(4)
    expect(playsFormat(defaultFormats(), 'singles', true)).toBe(true)
  })
})

describe('seat genders for a mixed game', () => {
  it('balances mixed doubles two and two against the host', () => {
    expect(mixedSeatGenders('doubles', 'woman')).toEqual(['man', 'man', 'woman'])
    expect(mixedSeatGenders('doubles', 'man')).toEqual(['woman', 'woman', 'man'])
  })

  it('gives mixed singles one seat of the opposite gender', () => {
    expect(mixedSeatGenders('singles', 'woman')).toEqual(['man'])
    expect(mixedSeatGenders('singles', 'man')).toEqual(['woman'])
  })

  it('leaves seats unconstrained for a host outside the bracket', () => {
    // Non-binary and unstated hosts are not forced into a two-sided format
    // they don't fit; they set seats by hand instead.
    expect(mixedSeatGenders('doubles', 'nonbinary')).toEqual([null, null, null])
    expect(mixedSeatGenders('singles', 'unspecified')).toEqual([null])
  })

  it('always returns one gender per open seat', () => {
    expect(mixedSeatGenders('singles', 'woman')).toHaveLength(1)
    expect(mixedSeatGenders('doubles', 'woman')).toHaveLength(3)
  })
})

describe('labels', () => {
  it('reads the way a player would say it', () => {
    expect(formatLabel('singles', true)).toBe('mixed singles')
    expect(formatLabel('doubles', false)).toBe('doubles')
  })
})
