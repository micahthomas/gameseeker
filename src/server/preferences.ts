import { asc, eq, sql, type SQL } from 'drizzle-orm'
import { db } from '~/db/client'
import { userLocations } from '~/db/schema'

/**
 * Where a player prefers to play.
 *
 * Deliberately a **soft** preference. Nothing in this file filters anybody
 * out — it only supplies an ordering. A player who hasn't listed a location
 * still hears about games there, they just come after the players who did.
 *
 * The alternative, filtering candidates to players who listed the location,
 * is stricter and would be right at city scale. At town scale it risks a
 * small pool going quiet: five parks and a couple of hundred players means
 * the difference between "a game happens" and "nobody was asked".
 */

/** Sorts after every real rank, so unranked players come last but still come. */
export const UNRANKED = 9999

/** A player's locations, most preferred first. */
export async function getPreferredLocationIds(userId: string): Promise<string[]> {
  const rows = await db()
    .select({ locationId: userLocations.locationId })
    .from(userLocations)
    .where(eq(userLocations.userId, userId))
    .orderBy(asc(userLocations.rank))
  return rows.map((r) => r.locationId)
}

/**
 * Replace a player's list wholesale.
 *
 * Ranks are rewritten contiguously from 0 in the order given, so the stored
 * ranks always match what the player sees, and a removed entry never leaves a
 * gap. Duplicates are dropped rather than rejected — the primary key would
 * fail the whole write, and a repeated location in a reorder UI is a slip,
 * not something worth erroring over.
 */
export async function setPreferredLocations(
  userId: string,
  locationIds: string[],
): Promise<string[]> {
  const ordered = [...new Set(locationIds)]

  await db().delete(userLocations).where(eq(userLocations.userId, userId))
  if (ordered.length > 0) {
    await db()
      .insert(userLocations)
      .values(ordered.map((locationId, rank) => ({ userId, locationId, rank })))
  }
  return ordered
}

/**
 * How highly a candidate ranks the location a game is at, as a sortable
 * scalar. `u` is the users alias in the surrounding query.
 */
export function candidateLocationRankSql(locationId: string | null | undefined): SQL {
  if (!locationId) return sql`${UNRANKED}`
  return sql`COALESCE((
    SELECT ul.rank FROM user_locations ul
    WHERE ul.user_id = u.id AND ul.location_id = ${locationId}
  ), ${UNRANKED})`
}

/**
 * How highly *this* player ranks where a game will be played, for ordering a
 * list of games.
 *
 * Two sources, in order. A placed game resolves through its assigned court.
 * A game still looking for players has no court yet — which is *every* open
 * game under flexible booking — so it falls back to the best rank across the
 * courts the host said they'd accept. Without that second branch the
 * dashboard's preference ordering would silently stop working the moment
 * courts stopped being held at creation.
 */
export function gameLocationRankSql(userId: string): SQL {
  return sql`COALESCE(
    (
      SELECT ul.rank
      FROM user_locations ul
      JOIN courts c ON c.id = games.court_id
      WHERE ul.user_id = ${userId} AND ul.location_id = c.location_id
    ),
    (
      SELECT MIN(ul.rank)
      FROM game_court_options gco
      JOIN courts c ON c.id = gco.court_id
      JOIN user_locations ul ON ul.location_id = c.location_id
      WHERE gco.game_id = games.id AND ul.user_id = ${userId}
    ),
    ${UNRANKED}
  )`
}
