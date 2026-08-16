import { and, asc, eq, gte, isNull, lt, ne, sql } from 'drizzle-orm'
import { db } from '~/db/client'
import {
  courtSlotLocks,
  courts,
  gameCourtOptions,
  games,
  locations,
  type Court,
} from '~/db/schema'
import { SLOT_MS, slotStarts } from './time'

/**
 * Court occupancy. Courts are held in 30-minute granules in `court_slot_locks`,
 * whose composite primary key (court_id, slot_start) is what actually prevents
 * two groups from being sent to the same court — see createGame() in games.ts.
 *
 * The app can't reserve a city court with the city; this guarantees only that
 * GameSeeker itself never schedules two of its own games on one court.
 */

export type CourtBusyRange = {
  courtId: string
  startsAt: number
  endsAt: number
  gameId: string
}

/** The 30-minute granules a booking would occupy. */
export function lockSlotsFor(startsAt: number, endsAt: number): number[] {
  return slotStarts(startsAt, endsAt)
}

/**
 * Read-only conflict check, used to grey out unavailable times in the UI
 * before submitting. The authoritative check is the primary-key constraint at
 * insert time — this is a courtesy, not the guard.
 */
export async function isCourtFree(
  courtId: string,
  startsAt: number,
  endsAt: number,
  excludeGameId?: string,
): Promise<boolean> {
  const slots = lockSlotsFor(startsAt, endsAt)
  if (slots.length === 0) return false

  const conflicts = await db()
    .select({ slotStart: courtSlotLocks.slotStart })
    .from(courtSlotLocks)
    .where(
      and(
        eq(courtSlotLocks.courtId, courtId),
        sql`${courtSlotLocks.slotStart} IN ${slots}`,
        excludeGameId ? ne(courtSlotLocks.gameId, excludeGameId) : undefined,
      ),
    )
    .limit(1)

  return conflicts.length === 0
}

/** Merge a court's locked granules into contiguous busy ranges for a calendar. */
export async function courtBusyRanges(
  courtId: string,
  fromMs: number,
  toMs: number,
): Promise<CourtBusyRange[]> {
  const rows = await db()
    .select({ slotStart: courtSlotLocks.slotStart, gameId: courtSlotLocks.gameId })
    .from(courtSlotLocks)
    .where(
      and(
        eq(courtSlotLocks.courtId, courtId),
        gte(courtSlotLocks.slotStart, fromMs),
        lt(courtSlotLocks.slotStart, toMs),
      ),
    )
    .orderBy(asc(courtSlotLocks.slotStart))

  return mergeSlots(courtId, rows)
}

/** All busy ranges at a location, keyed by court. */
export async function locationBusyRanges(
  locationId: string,
  fromMs: number,
  toMs: number,
): Promise<Map<string, CourtBusyRange[]>> {
  const rows = await db()
    .select({
      courtId: courtSlotLocks.courtId,
      slotStart: courtSlotLocks.slotStart,
      gameId: courtSlotLocks.gameId,
    })
    .from(courtSlotLocks)
    .innerJoin(courts, eq(courts.id, courtSlotLocks.courtId))
    .where(
      and(
        eq(courts.locationId, locationId),
        gte(courtSlotLocks.slotStart, fromMs),
        lt(courtSlotLocks.slotStart, toMs),
      ),
    )
    .orderBy(asc(courtSlotLocks.courtId), asc(courtSlotLocks.slotStart))

  const byCourt = new Map<string, Array<{ slotStart: number; gameId: string }>>()
  for (const row of rows) {
    const list = byCourt.get(row.courtId) ?? []
    list.push({ slotStart: row.slotStart, gameId: row.gameId })
    byCourt.set(row.courtId, list)
  }

  const out = new Map<string, CourtBusyRange[]>()
  for (const [courtId, slots] of byCourt) {
    out.set(courtId, mergeSlots(courtId, slots))
  }
  return out
}

function mergeSlots(
  courtId: string,
  slots: Array<{ slotStart: number; gameId: string }>,
): CourtBusyRange[] {
  const ranges: CourtBusyRange[] = []
  for (const slot of slots) {
    const last = ranges[ranges.length - 1]
    if (last && last.gameId === slot.gameId && last.endsAt === slot.slotStart) {
      last.endsAt = slot.slotStart + SLOT_MS
    } else {
      ranges.push({
        courtId,
        startsAt: slot.slotStart,
        endsAt: slot.slotStart + SLOT_MS,
        gameId: slot.gameId,
      })
    }
  }
  return ranges
}

/** Courts at a location that have no conflicting booking for a window. */
export async function freeCourtsAt(
  locationId: string,
  startsAt: number,
  endsAt: number,
): Promise<Court[]> {
  const slots = lockSlotsFor(startsAt, endsAt)
  const all = await db()
    .select()
    .from(courts)
    .where(and(eq(courts.locationId, locationId), eq(courts.isActive, true)))
    .orderBy(asc(courts.sortOrder), asc(courts.name))

  if (slots.length === 0) return []

  const taken = await db()
    .select({ courtId: courtSlotLocks.courtId })
    .from(courtSlotLocks)
    .innerJoin(courts, eq(courts.id, courtSlotLocks.courtId))
    .where(and(eq(courts.locationId, locationId), sql`${courtSlotLocks.slotStart} IN ${slots}`))

  const takenIds = new Set(taken.map((t) => t.courtId))
  return all.filter((court) => !takenIds.has(court.id))
}

export async function listLocations() {
  return db()
    .select()
    .from(locations)
    .where(eq(locations.isActive, true))
    .orderBy(asc(locations.name))
}

export async function listCourts(locationId: string) {
  return db()
    .select()
    .from(courts)
    .where(and(eq(courts.locationId, locationId), eq(courts.isActive, true)))
    .orderBy(asc(courts.sortOrder), asc(courts.name))
}

export async function getLocationWithCourts(locationId: string) {
  const rows = await db().select().from(locations).where(eq(locations.id, locationId)).limit(1)
  const location = rows[0]
  if (!location) return null
  return { location, courts: await listCourts(locationId) }
}

/** Games occupying a location's courts in a window, for the calendar view. */
/**
 * Games that could still land at this location: open, unplaced, and offering
 * at least one court here.
 *
 * A game can offer courts at several locations, so the same pending game may
 * legitimately appear on two locations' calendars. Both are true — it will
 * only take one of them.
 */
export async function pendingGamesAtLocation(locationId: string, fromMs: number, toMs: number) {
  return db()
    .selectDistinct({ game: games })
    .from(games)
    .innerJoin(gameCourtOptions, eq(gameCourtOptions.gameId, games.id))
    .innerJoin(courts, eq(courts.id, gameCourtOptions.courtId))
    .where(
      and(
        eq(courts.locationId, locationId),
        isNull(games.courtId),
        eq(games.status, 'open'),
        gte(games.startsAt, fromMs),
        lt(games.startsAt, toMs),
      ),
    )
    .orderBy(asc(games.startsAt))
}

/** Games actually booked here. Unplaced games hold nothing, so they aren't included. */
export async function gamesAtLocation(locationId: string, fromMs: number, toMs: number) {
  return db()
    .select({
      game: games,
      court: courts,
    })
    .from(games)
    .innerJoin(courts, eq(courts.id, games.courtId))
    .where(
      and(
        eq(courts.locationId, locationId),
        gte(games.startsAt, fromMs),
        lt(games.startsAt, toMs),
        ne(games.status, 'cancelled'),
      ),
    )
    .orderBy(asc(games.startsAt))
}


export type FreeCourtsByLocation = {
  locationId: string
  locationName: string
  courts: Array<{ id: string; name: string }>
}

/**
 * Every free court in a window, grouped by location.
 *
 * A game can offer courts across several parks — it holds none of them until
 * it fills, so a wider net costs nobody anything and only makes the game
 * likelier to happen. The create form needs the whole town's availability to
 * offer that, not one location's.
 *
 * Advisory, like `freeCourtsAt`: the authoritative check is the primary key on
 * `court_slot_locks` at assignment time. This just avoids offering a court
 * that is already obviously gone.
 */
export async function freeCourtsEverywhere(
  startsAt: number,
  endsAt: number,
): Promise<FreeCourtsByLocation[]> {
  const slots = lockSlotsFor(startsAt, endsAt)
  if (slots.length === 0) return []

  const all = await db()
    .select({
      courtId: courts.id,
      courtName: courts.name,
      sortOrder: courts.sortOrder,
      locationId: locations.id,
      locationName: locations.name,
    })
    .from(courts)
    .innerJoin(locations, eq(locations.id, courts.locationId))
    .where(and(eq(courts.isActive, true), eq(locations.isActive, true)))
    .orderBy(asc(locations.name), asc(courts.sortOrder), asc(courts.name))

  const taken = await db()
    .select({ courtId: courtSlotLocks.courtId })
    .from(courtSlotLocks)
    .where(sql`${courtSlotLocks.slotStart} IN ${slots}`)
  const takenIds = new Set(taken.map((t) => t.courtId))

  const byLocation = new Map<string, FreeCourtsByLocation>()
  for (const row of all) {
    if (takenIds.has(row.courtId)) continue
    let group = byLocation.get(row.locationId)
    if (!group) {
      group = { locationId: row.locationId, locationName: row.locationName, courts: [] }
      byLocation.set(row.locationId, group)
    }
    group.courts.push({ id: row.courtId, name: row.courtName })
  }
  // Locations with nothing free are simply absent rather than listed empty.
  return [...byLocation.values()]
}
