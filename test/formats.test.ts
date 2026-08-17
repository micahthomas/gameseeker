import { describe, expect, it } from 'vitest'
import {
  defaultFormats,
  formatLabel,
  gameFormatOf,
  divisionLabel,
  mixedSeatDivisions,
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

describe('seat divisions for a mixed game', () => {
  it('balances mixed doubles two and two against the host', () => {
    expect(mixedSeatDivisions('doubles', 'womens')).toEqual(['mens', 'mens', 'womens'])
    expect(mixedSeatDivisions('doubles', 'mens')).toEqual(['womens', 'womens', 'mens'])
  })

  it('gives mixed singles one seat on the other side', () => {
    expect(mixedSeatDivisions('singles', 'womens')).toEqual(['mens'])
    expect(mixedSeatDivisions('singles', 'mens')).toEqual(['womens'])
  })

  it('leaves seats unconstrained for a host who has not said', () => {
    // Nothing to balance against, so the host sets seats by hand rather than
    // being assigned a side. This is the only state that behaves this way now
    // — a player who would once have been 'nonbinary' picks a division like
    // anyone else, and gets balanced seats from it.
    expect(mixedSeatDivisions('doubles', 'unspecified')).toEqual([null, null, null])
    expect(mixedSeatDivisions('singles', 'unspecified')).toEqual([null])
  })

  it('always returns one division per open seat', () => {
    expect(mixedSeatDivisions('singles', 'womens')).toHaveLength(1)
    expect(mixedSeatDivisions('doubles', 'womens')).toHaveLength(3)
  })

  it('labels a held seat the way a player reads it', () => {
    expect(divisionLabel('womens')).toBe("a women's player")
    expect(divisionLabel('mens')).toBe("a men's player")
  })
})

describe('labels', () => {
  it('reads the way a player would say it', () => {
    expect(formatLabel('singles', true)).toBe('mixed singles')
    expect(formatLabel('doubles', false)).toBe('doubles')
  })
})
