import type { GameFormat, PlayerFormat, SeatDivision } from '~/db/schema'

/**
 * Formats, and who plays them.
 *
 * A game is a `format` ('singles' | 'doubles') plus an `is_mixed` flag. A
 * player opts into a *set* of the four combinations. These functions are the
 * only place the two representations meet — everywhere else should be asking
 * `playsFormat`, never inspecting the set by hand.
 *
 * This replaced `plays_singles` / `plays_doubles` / `plays_mixed`, where mixed
 * was a modifier that only legally applied to doubles. Four independent
 * choices remove that special case and let a player take mixed singles without
 * also taking ordinary singles.
 */

/** The single player-format a game corresponds to. */
export function playerFormat(format: GameFormat, isMixed: boolean): PlayerFormat {
  if (format === 'singles') return isMixed ? 'mixed_singles' : 'singles'
  return isMixed ? 'mixed_doubles' : 'doubles'
}

/**
 * Does this player play this kind of game?
 *
 * Opt-in intersection, exactly like `playsAtLevel`. Playing 'mixed_doubles'
 * does not imply playing 'doubles' — someone may want only the mixed ones, and
 * inferring otherwise would send them games they never asked for.
 */
export function playsFormat(
  formats: PlayerFormat[] | null | undefined,
  format: GameFormat,
  isMixed: boolean,
): boolean {
  return (formats ?? []).includes(playerFormat(format, isMixed))
}

/** The game shape a player-format is played in. */
export function gameFormatOf(format: PlayerFormat): GameFormat {
  return format === 'singles' || format === 'mixed_singles' ? 'singles' : 'doubles'
}

/** Human-readable, for messages a player reads. */
export function formatLabel(format: GameFormat, isMixed: boolean): string {
  return isMixed ? `mixed ${format}` : format
}

/**
 * Divisions for the open seats of a mixed game, given the host's own.
 *
 * Mixed doubles is two of each, so the host counts toward one side and the
 * three open seats fill the rest. Mixed singles is simply one of each, so the
 * single seat takes the other side.
 *
 * A host who hasn't stated a division leaves the seats unconstrained rather
 * than being forced into a side. They can still set each seat by hand. See the
 * division note in `src/db/schema.ts`.
 */
export function mixedSeatDivisions(
  format: GameFormat,
  hostDivision: string,
): Array<SeatDivision | null> {
  if (format === 'singles') {
    if (hostDivision === 'womens') return ['mens']
    if (hostDivision === 'mens') return ['womens']
    return [null]
  }
  if (hostDivision === 'womens') return ['mens', 'mens', 'womens']
  if (hostDivision === 'mens') return ['womens', 'womens', 'mens']
  return [null, null, null]
}

/** Human-readable, for a seat held to one side of a mixed game. */
export function divisionLabel(division: SeatDivision): string {
  return division === 'womens' ? "a women's player" : "a men's player"
}

/**
 * The same seat, phrased as something a player *does* rather than is.
 *
 * Reads correctly after "…and play": "and play women's tennis". `divisionLabel`
 * is the noun form for naming a seat; this is the verb form for describing who
 * gets messaged about it.
 */
export function divisionPlayLabel(division: SeatDivision): string {
  return division === 'womens' ? "women's tennis" : "men's tennis"
}

/**
 * What a brand-new player starts with in the profile form.
 *
 * All four, matching the old defaults (singles + doubles + mixed all began
 * checked). This is a form default someone is actively looking at and can
 * untick — unlike the migration backfill, which deliberately only carried over
 * what existing players had actually said.
 */
export function defaultFormats(): PlayerFormat[] {
  return ['singles', 'mixed_singles', 'doubles', 'mixed_doubles']
}
