import { and, asc, eq, sql } from 'drizzle-orm'
import { db } from '~/db/client'
import { courtSlotLocks, courts, gameCourtOptions, games, type Game } from '~/db/schema'
import { lockSlotsFor } from './booking'
import { gameParticipants } from './games'
import { UNRANKED } from './preferences'

/**
 * Giving a filled game a court.
 *
 * A game holds no court while it is looking for players. Holding every court a
 * host would accept would block five courts for everyone else on behalf of a
 * game that may never happen — unacceptable in a town with five parks. So the
 * court is assigned at the moment the last seat is taken.
 *
 * The race did not go away, it moved. Assignment is the same single `batch()`
 * that `createGame` used to run: insert the 30-minute court locks and set
 * `court_id` together, and let the composite primary key on
 * `court_slot_locks` reject a collision. Two games filling at the same instant
 * and wanting the same last court: exactly one gets it.
 *
 * The new failure mode is a game that fills and then cannot be placed, because
 * every court the host offered went while they were waiting. That is
 * `unplaceable` — a state the host is told about, not a silent cancellation.
 * The players are real and willing; only the venue is missing, and moving the
 * time or adding a location fixes it.
 */

export type AssignmentResult =
  | { placed: true; game: Game; courtId: string }
  | { placed: false; game: Game }

/**
 * Rank each candidate court by how well it suits the people actually playing.
 *
 * Lower is better. A court's score is the sum of every participant's
 * preference rank for its location, so a court two people put first beats one
 * that only the host did. Players with no stated preference contribute
 * `UNRANKED` uniformly and therefore don't skew the comparison. The host's own
 * ordering breaks ties.
 */
async function rankCandidates(gameId: string): Promise<Array<{ courtId: string }>> {
  const participants = await gameParticipants(gameId)
  const participantIds = participants.map((p) => p.id)

  const rows = await db()
    .select({
      courtId: gameCourtOptions.courtId,
      hostRank: gameCourtOptions.rank,
      locationId: courts.locationId,
    })
    .from(gameCourtOptions)
    .innerJoin(courts, eq(courts.id, gameCourtOptions.courtId))
    .where(and(eq(gameCourtOptions.gameId, gameId), eq(courts.isActive, true)))
    .orderBy(asc(gameCourtOptions.rank))

  if (rows.length === 0 || participantIds.length === 0) {
    return rows.map((r) => ({ courtId: r.courtId }))
  }

  const preferences = await db().all<{ userId: string; locationId: string; rank: number }>(sql`
    SELECT user_id AS userId, location_id AS locationId, rank
    FROM user_locations
    WHERE user_id IN ${participantIds}
  `)

  const rankFor = (userId: string, locationId: string) =>
    preferences.find((p) => p.userId === userId && p.locationId === locationId)?.rank ?? UNRANKED

  return rows
    .map((row) => ({
      courtId: row.courtId,
      hostRank: row.hostRank,
      score: participantIds.reduce((total, id) => total + rankFor(id, row.locationId), 0),
    }))
    .sort((a, b) => a.score - b.score || a.hostRank - b.hostRank)
    .map((row) => ({ courtId: row.courtId }))
}

/**
 * Place a filled game on the best court still free.
 *
 * Tries candidates in order and takes the first that commits. A rejection here
 * is expected traffic, not an error: it means somebody else booked that court
 * a moment ago, so we move to the next one.
 */
export async function assignCourt(gameId: string): Promise<AssignmentResult> {
  const rows = await db().select().from(games).where(eq(games.id, gameId)).limit(1)
  const game = rows[0]
  if (!game) throw new Error(`No such game: ${gameId}`)
  if (game.courtId) return { placed: true, game, courtId: game.courtId }

  const candidates = await rankCandidates(gameId)
  const slots = lockSlotsFor(game.startsAt, game.endsAt)
  const database = db()

  for (const { courtId } of candidates) {
    try {
      await database.batch([
        database
          .insert(courtSlotLocks)
          .values(slots.map((slotStart) => ({ courtId, slotStart, gameId }))),
        database
          .update(games)
          .set({ courtId, status: 'full' })
          .where(and(eq(games.id, gameId), sql`${games.courtId} IS NULL`)),
      ])
      return { placed: true, game: { ...game, courtId, status: 'full' }, courtId }
    } catch {
      // Court taken since the host offered it. Try the next one.
    }
  }

  await db()
    .update(games)
    .set({ status: 'unplaceable' })
    .where(and(eq(games.id, gameId), sql`${games.courtId} IS NULL`))

  return { placed: false, game: { ...game, status: 'unplaceable' } }
}

/**
 * Courts a host could still offer for a window, across every location.
 *
 * Advisory only — the authoritative check is the primary key at assignment
 * time. It exists so the create form doesn't offer a court that is already
 * obviously gone.
 */
export async function freeCourtIdsAt(startsAt: number, endsAt: number): Promise<string[]> {
  const slots = lockSlotsFor(startsAt, endsAt)
  const rows = await db().all<{ id: string }>(sql`
    SELECT c.id AS id
    FROM courts c
    WHERE c.is_active = 1
      AND NOT EXISTS (
        SELECT 1 FROM court_slot_locks l
        WHERE l.court_id = c.id AND l.slot_start IN ${slots}
      )
  `)
  return rows.map((r) => r.id)
}
