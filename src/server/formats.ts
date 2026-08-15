import type { GameFormat, PlayerFormat } from '~/db/schema'

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
 * Genders for the open seats of a mixed game, given the host's own.
 *
 * Mixed doubles is two of each, so the host counts toward one side and the
 * three open seats fill the rest. Mixed singles is simply one of each, so the
 * single seat takes the opposite gender.
 *
 * A host who hasn't stated a gender — or is non-binary — leaves the seats
 * unconstrained rather than being forced into a bracket the format doesn't
 * have. They can still set each seat by hand. See the gender note in
 * `src/db/schema.ts`.
 */
export function mixedSeatGenders(
  format: GameFormat,
  hostGender: string,
): Array<'woman' | 'man' | null> {
  if (format === 'singles') {
    if (hostGender === 'woman') return ['man']
    if (hostGender === 'man') return ['woman']
    return [null]
  }
  if (hostGender === 'woman') return ['man', 'man', 'woman']
  if (hostGender === 'man') return ['woman', 'woman', 'man']
  return [null, null, null]
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
