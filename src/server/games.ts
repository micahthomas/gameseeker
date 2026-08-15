import { and, asc, desc, eq, gt, inArray, isNull, lt, ne, sql } from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
import { db } from '~/db/client'
import {
  courtSlotLocks,
  courts,
  gameSlots,
  games,
  locations,
  notifications,
  users,
  type Game,
  type GameFormat,
  type GameSlot,
  type User,
} from '~/db/schema'
import { lockSlotsFor } from './booking'
import { DEFAULT_TOLERANCE, levelBand } from './rating'
import { newId } from './tokens'
import { HOUR, MINUTE, SLOT_MS } from './time'
import type { GameBrief } from './notify/templates'

/**
 * Drizzle's batch() wants a non-empty tuple; a plain array literal widens to
 * `Item[]` and fails to match. This preserves the tuple-ness at the call site.
 */
function batchOf<T extends [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]>(...items: T): T {
  return items
}

export class CourtTakenError extends Error {
  constructor() {
    super('That court is already booked for part of this time.')
    this.name = 'CourtTakenError'
  }
}

export class SlotTakenError extends Error {
  constructor() {
    super('Someone just claimed that spot.')
    this.name = 'SlotTakenError'
  }
}

export class GameValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GameValidationError'
  }
}

export const MIN_DURATION = 30 * MINUTE
export const MAX_DURATION = 4 * HOUR

/** Non-host seats: 1 for singles, 3 for doubles. */
export function seatsToFill(format: GameFormat): number {
  return format === 'singles' ? 1 : 3
}

export type NewGameSlotInput =
  | { kind: 'invited'; invitedUserId: string }
  | { kind: 'seeker'; seekerNtrp: number }

export type CreateGameInput = {
  hostId: string
  hostNtrp: number
  courtId: string
  startsAt: number
  endsAt: number
  format: GameFormat
  notes?: string | null
  slots: NewGameSlotInput[]
  tolerance?: number
}

function validate(input: CreateGameInput, now: number) {
  const duration = input.endsAt - input.startsAt
  if (duration < MIN_DURATION) throw new GameValidationError('A game must be at least 30 minutes.')
  if (duration > MAX_DURATION) throw new GameValidationError('A game can be at most 4 hours.')
  if (input.startsAt < now - 5 * MINUTE) {
    throw new GameValidationError('Pick a start time in the future.')
  }
  if (input.startsAt % SLOT_MS !== 0 || input.endsAt % SLOT_MS !== 0) {
    throw new GameValidationError('Start and end times must land on a half hour.')
  }
  const expected = seatsToFill(input.format)
  if (input.slots.length !== expected) {
    throw new GameValidationError(
      `A ${input.format} game needs ${expected} other player${expected === 1 ? '' : 's'}.`,
    )
  }
}

/**
 * Create a game and hold its court, atomically.
 *
 * The game row, its seats, and its 30-minute court locks all go in through a
 * single D1 `batch()`, which runs as one transaction. If any granule of the
 * court is already held, the composite primary key on court_slot_locks rejects
 * the insert and the whole batch rolls back — no orphaned game, no partially
 * held court. Two hosts racing for the same court and time: exactly one wins.
 */
export async function createGame(input: CreateGameInput): Promise<Game> {
  const now = Date.now()
  validate(input, now)

  const tolerance = input.tolerance ?? DEFAULT_TOLERANCE
  const seekerLevels = input.slots
    .filter((s): s is Extract<NewGameSlotInput, { kind: 'seeker' }> => s.kind === 'seeker')
    .map((s) => s.seekerNtrp)

  // The accepted band spans every seeker level requested; with no seeker slots
  // it's just the host's own level, so the game still reads sensibly.
  const levels = seekerLevels.length > 0 ? seekerLevels : [input.hostNtrp]
  const bands = levels.map((level) => levelBand(level, tolerance))
  const minNtrp = Math.min(...bands.map(([lo]) => lo))
  const maxNtrp = Math.max(...bands.map(([, hi]) => hi))

  const gameId = newId()
  const gameRow = {
    id: gameId,
    hostId: input.hostId,
    courtId: input.courtId,
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    format: input.format,
    status: 'open' as const,
    minNtrp,
    maxNtrp,
    notes: input.notes ?? null,
    createdAt: now,
    cancelledAt: null,
    remindedAt: null,
    hostNudgedAt: null,
  }

  const slotRows = [
    {
      id: newId(),
      gameId,
      slotIndex: 0,
      kind: 'host' as const,
      invitedUserId: null,
      seekerNtrp: null,
      filledByUserId: input.hostId,
      filledAt: now,
      status: 'filled' as const,
    },
    ...input.slots.map((slot, i) => ({
      id: newId(),
      gameId,
      slotIndex: i + 1,
      kind: slot.kind,
      invitedUserId: slot.kind === 'invited' ? slot.invitedUserId : null,
      seekerNtrp: slot.kind === 'seeker' ? slot.seekerNtrp : null,
      filledByUserId: null,
      filledAt: null,
      status: 'open' as const,
    })),
  ]

  const lockRows = lockSlotsFor(input.startsAt, input.endsAt).map((slotStart) => ({
    courtId: input.courtId,
    slotStart,
    gameId,
  }))

  const database = db()
  try {
    await database.batch(
      batchOf(
        database.insert(games).values(gameRow),
        database.insert(gameSlots).values(slotRows),
        database.insert(courtSlotLocks).values(lockRows),
      ),
    )
  } catch (error) {
    if (isConstraintViolation(error)) throw new CourtTakenError()
    throw error
  }

  return gameRow
}

function isConstraintViolation(error: unknown): boolean {
  const message = String((error as Error)?.message ?? error)
  return /UNIQUE constraint|PRIMARY KEY|constraint failed/i.test(message)
}

/**
 * Take an open seat. First writer wins.
 *
 * The guarded UPDATE is the whole race resolution: `WHERE filled_by_user_id IS
 * NULL` means a second claimant updates zero rows and gets a clean rejection
 * instead of overwriting the winner.
 */
export async function claimSlot(
  slotId: string,
  user: Pick<User, 'id' | 'ntrp'>,
): Promise<{ game: Game; slot: GameSlot; remainingOpen: number }> {
  const now = Date.now()
  const rows = await db()
    .select({ slot: gameSlots, game: games })
    .from(gameSlots)
    .innerJoin(games, eq(games.id, gameSlots.gameId))
    .where(eq(gameSlots.id, slotId))
    .limit(1)

  const found = rows[0]
  if (!found) throw new GameValidationError('That game spot no longer exists.')
  const { game } = found

  if (game.status === 'cancelled') throw new GameValidationError('That game was cancelled.')
  if (game.status === 'completed') throw new GameValidationError('That game already happened.')
  if (game.startsAt <= now) throw new GameValidationError('That game has already started.')
  if (found.slot.status !== 'open' || found.slot.filledByUserId) throw new SlotTakenError()

  if (found.slot.kind === 'invited' && found.slot.invitedUserId !== user.id) {
    throw new GameValidationError('That spot is reserved for a specific player.')
  }
  if (found.slot.kind === 'seeker' && (user.ntrp < game.minNtrp || user.ntrp > game.maxNtrp)) {
    throw new GameValidationError(
      `This game is looking for ${game.minNtrp.toFixed(1)}–${game.maxNtrp.toFixed(1)} players.`,
    )
  }

  const already = await db()
    .select({ id: gameSlots.id })
    .from(gameSlots)
    .where(and(eq(gameSlots.gameId, game.id), eq(gameSlots.filledByUserId, user.id)))
    .limit(1)
  if (already.length > 0) throw new GameValidationError("You're already in this game.")

  let claimed: GameSlot | undefined
  try {
    const updated = await db()
      .update(gameSlots)
      .set({ filledByUserId: user.id, filledAt: now, status: 'filled' })
      .where(and(eq(gameSlots.id, slotId), isNull(gameSlots.filledByUserId)))
      .returning()
    claimed = updated[0]
  } catch (error) {
    // The partial unique index catches a player double-claiming two seats in
    // the same game from two devices at once.
    if (isConstraintViolation(error)) throw new GameValidationError("You're already in this game.")
    throw error
  }

  if (!claimed) throw new SlotTakenError()

  const remainingOpen = await countOpenSlots(game.id)
  if (remainingOpen === 0 && game.status === 'open') {
    await db().update(games).set({ status: 'full' }).where(eq(games.id, game.id))
    game.status = 'full'
  }

  return { game, slot: claimed, remainingOpen }
}

/**
 * Claim any seat in a game this player qualifies for.
 *
 * A doubles game can have three identical "GameSeeker 3.5" seats. Notifications
 * point at the game rather than one specific seat, so two people responding at
 * the same moment should both get in — they just land on different seats. Each
 * attempt is the same guarded UPDATE, walked in order until one takes.
 */
export async function claimAnyOpenSlot(
  gameId: string,
  user: Pick<User, 'id' | 'ntrp'>,
): Promise<{ game: Game; slot: GameSlot; remainingOpen: number }> {
  const open = await db()
    .select()
    .from(gameSlots)
    .where(and(eq(gameSlots.gameId, gameId), eq(gameSlots.status, 'open')))
    .orderBy(asc(gameSlots.slotIndex))

  // Seats explicitly reserved for this player come first, then generic ones.
  const eligible = open
    .filter((slot) =>
      slot.kind === 'invited' ? slot.invitedUserId === user.id : slot.kind === 'seeker',
    )
    .sort((a, b) => (a.kind === 'invited' ? -1 : 0) - (b.kind === 'invited' ? -1 : 0))

  if (eligible.length === 0) throw new SlotTakenError()

  let lastError: unknown
  for (const slot of eligible) {
    try {
      return await claimSlot(slot.id, user)
    } catch (error) {
      if (error instanceof SlotTakenError) {
        lastError = error
        continue
      }
      throw error
    }
  }
  throw lastError instanceof Error ? lastError : new SlotTakenError()
}

export async function countOpenSlots(gameId: string): Promise<number> {
  const rows = await db()
    .select({ count: sql<number>`count(*)` })
    .from(gameSlots)
    .where(and(eq(gameSlots.gameId, gameId), eq(gameSlots.status, 'open')))
  return Number(rows[0]?.count ?? 0)
}

/** Give up a seat. Reopens it so the slot can be filled again. */
export async function leaveGame(gameId: string, userId: string): Promise<void> {
  const rows = await db().select().from(games).where(eq(games.id, gameId)).limit(1)
  const game = rows[0]
  if (!game) throw new GameValidationError('Game not found.')
  if (game.hostId === userId) {
    throw new GameValidationError('The host cannot leave; cancel the game instead.')
  }

  await db()
    .update(gameSlots)
    .set({ filledByUserId: null, filledAt: null, status: 'open' })
    .where(and(eq(gameSlots.gameId, gameId), eq(gameSlots.filledByUserId, userId)))

  if (game.status === 'full') {
    await db().update(games).set({ status: 'open' }).where(eq(games.id, gameId))
  }
}

/**
 * Cancel a game and release the court. Deleting the lock rows is what lets
 * somebody else book that court and time immediately.
 */
export async function cancelGame(gameId: string, userId: string, isAdmin = false): Promise<Game> {
  const rows = await db().select().from(games).where(eq(games.id, gameId)).limit(1)
  const game = rows[0]
  if (!game) throw new GameValidationError('Game not found.')
  if (game.hostId !== userId && !isAdmin) {
    throw new GameValidationError('Only the host can cancel this game.')
  }
  if (game.status === 'cancelled') return game

  const database = db()
  await database.batch(
    batchOf(
      database
        .update(games)
        .set({ status: 'cancelled', cancelledAt: Date.now() })
        .where(eq(games.id, gameId)),
      database.delete(courtSlotLocks).where(eq(courtSlotLocks.gameId, gameId)),
    ),
  )

  return { ...game, status: 'cancelled', cancelledAt: Date.now() }
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export type GameDetail = {
  game: Game
  court: { id: string; name: string; surface: string; hasLights: boolean }
  location: { id: string; name: string; address: string | null; lat: number | null; lng: number | null }
  host: { id: string; name: string; ntrp: number }
  slots: Array<{
    slot: GameSlot
    player: { id: string; name: string; ntrp: number; phone: string | null; email: string } | null
    invited: { id: string; name: string } | null
  }>
}

export async function getGame(gameId: string): Promise<GameDetail | null> {
  const rows = await db()
    .select({ game: games, court: courts, location: locations, host: users })
    .from(games)
    .innerJoin(courts, eq(courts.id, games.courtId))
    .innerJoin(locations, eq(locations.id, courts.locationId))
    .innerJoin(users, eq(users.id, games.hostId))
    .where(eq(games.id, gameId))
    .limit(1)

  const row = rows[0]
  if (!row) return null

  const slotRows = await db()
    .select({ slot: gameSlots, player: users })
    .from(gameSlots)
    .leftJoin(users, eq(users.id, gameSlots.filledByUserId))
    .where(eq(gameSlots.gameId, gameId))
    .orderBy(asc(gameSlots.slotIndex))

  const invitedIds = slotRows
    .map((r) => r.slot.invitedUserId)
    .filter((id): id is string => Boolean(id))
  const invitedUsers =
    invitedIds.length > 0
      ? await db()
          .select({ id: users.id, name: users.name })
          .from(users)
          .where(inArray(users.id, invitedIds))
      : []
  const invitedById = new Map(invitedUsers.map((u) => [u.id, u]))

  return {
    game: row.game,
    court: {
      id: row.court.id,
      name: row.court.name,
      surface: row.court.surface,
      hasLights: row.court.hasLights,
    },
    location: {
      id: row.location.id,
      name: row.location.name,
      address: row.location.address,
      lat: row.location.lat,
      lng: row.location.lng,
    },
    host: { id: row.host.id, name: row.host.name, ntrp: row.host.ntrp },
    slots: slotRows.map((r) => ({
      slot: r.slot,
      player: r.player
        ? {
            id: r.player.id,
            name: r.player.name,
            ntrp: r.player.ntrp,
            phone: r.player.phone,
            email: r.player.email,
          }
        : null,
      invited: r.slot.invitedUserId ? (invitedById.get(r.slot.invitedUserId) ?? null) : null,
    })),
  }
}

/** Compact shape used by notification templates. */
export async function getGameBrief(gameId: string): Promise<GameBrief | null> {
  const rows = await db()
    .select({
      id: games.id,
      startsAt: games.startsAt,
      endsAt: games.endsAt,
      format: games.format,
      notes: games.notes,
      locationName: locations.name,
      locationAddress: locations.address,
      courtName: courts.name,
      hostName: users.name,
    })
    .from(games)
    .innerJoin(courts, eq(courts.id, games.courtId))
    .innerJoin(locations, eq(locations.id, courts.locationId))
    .innerJoin(users, eq(users.id, games.hostId))
    .where(eq(games.id, gameId))
    .limit(1)
  return rows[0] ?? null
}

export type GameListItem = {
  game: Game
  courtName: string
  locationName: string
  hostName: string
  openSlots: number
  filledSlots: number
}

const listSelection = {
  game: games,
  courtName: courts.name,
  locationName: locations.name,
  hostName: users.name,
  openSlots: sql<number>`(SELECT COUNT(*) FROM game_slots gs WHERE gs.game_id = ${games.id} AND gs.status = 'open')`,
  filledSlots: sql<number>`(SELECT COUNT(*) FROM game_slots gs WHERE gs.game_id = ${games.id} AND gs.status = 'filled')`,
}

function listFrom() {
  return db()
    .select(listSelection)
    .from(games)
    .innerJoin(courts, eq(courts.id, games.courtId))
    .innerJoin(locations, eq(locations.id, courts.locationId))
    .innerJoin(users, eq(users.id, games.hostId))
}

/** Games the player is in (hosting or playing), soonest first. */
export async function listMyGames(userId: string, now = Date.now()): Promise<GameListItem[]> {
  return listFrom()
    .where(
      and(
        gt(games.endsAt, now),
        ne(games.status, 'cancelled'),
        sql`EXISTS (SELECT 1 FROM game_slots gs WHERE gs.game_id = ${games.id} AND gs.filled_by_user_id = ${userId})`,
      ),
    )
    .orderBy(asc(games.startsAt))
}

/** Past games the player took part in. */
export async function listPastGames(
  userId: string,
  limit = 20,
  now = Date.now(),
): Promise<GameListItem[]> {
  return listFrom()
    .where(
      and(
        lt(games.endsAt, now),
        sql`EXISTS (SELECT 1 FROM game_slots gs WHERE gs.game_id = ${games.id} AND gs.filled_by_user_id = ${userId})`,
      ),
    )
    .orderBy(desc(games.startsAt))
    .limit(limit)
}

/**
 * Open games this player could join: right level band, a format they play, and
 * they aren't already in it. Deliberately does NOT filter on their posted
 * availability — availability drives who gets notified, but anyone should be
 * able to browse and grab a game they happen to be free for.
 */
export async function listOpenGamesFor(
  user: Pick<User, 'id' | 'ntrp' | 'playsSingles' | 'playsDoubles'>,
  now = Date.now(),
  limit = 50,
): Promise<GameListItem[]> {
  const formats: GameFormat[] = []
  if (user.playsSingles) formats.push('singles')
  if (user.playsDoubles) formats.push('doubles')
  if (formats.length === 0) return []

  return listFrom()
    .where(
      and(
        eq(games.status, 'open'),
        gt(games.startsAt, now),
        inArray(games.format, formats),
        lt(games.minNtrp, user.ntrp + 0.001),
        gt(games.maxNtrp, user.ntrp - 0.001),
        sql`NOT EXISTS (SELECT 1 FROM game_slots gs WHERE gs.game_id = ${games.id} AND gs.filled_by_user_id = ${user.id})`,
        sql`EXISTS (SELECT 1 FROM game_slots gs WHERE gs.game_id = ${games.id} AND gs.status = 'open' AND gs.kind = 'seeker')`,
      ),
    )
    .orderBy(asc(games.startsAt))
    .limit(limit)
}

/** Every upcoming game, for the community calendar. */
export async function listUpcomingGames(now = Date.now(), limit = 100): Promise<GameListItem[]> {
  return listFrom()
    .where(and(gt(games.endsAt, now), ne(games.status, 'cancelled')))
    .orderBy(asc(games.startsAt))
    .limit(limit)
}

/** Everyone holding a seat, for reminders and cancellation notices. */
export async function gameParticipants(gameId: string): Promise<User[]> {
  const rows = await db()
    .select({ user: users })
    .from(gameSlots)
    .innerJoin(users, eq(users.id, gameSlots.filledByUserId))
    .where(and(eq(gameSlots.gameId, gameId), eq(gameSlots.status, 'filled')))
  return rows.map((r) => r.user)
}

/** Mark a claim link as spent so the notification list reads accurately. */
export async function markNotificationClaimed(slotId: string, userId: string): Promise<void> {
  await db()
    .update(notifications)
    .set({ status: 'claimed', respondedAt: Date.now() })
    .where(and(eq(notifications.slotId, slotId), eq(notifications.userId, userId)))
}

/** Resolve a claim token from a notification link to its slot. */
export async function resolveClaimToken(
  token: string,
): Promise<{ slotId: string; gameId: string; userId: string } | null> {
  const rows = await db()
    .select({
      slotId: notifications.slotId,
      gameId: notifications.gameId,
      userId: notifications.userId,
    })
    .from(notifications)
    .where(eq(notifications.claimToken, token))
    .limit(1)
  const row = rows[0]
  if (!row || !row.slotId) return null
  return { slotId: row.slotId, gameId: row.gameId, userId: row.userId }
}
