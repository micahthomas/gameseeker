import { and, asc, desc, eq, gt, inArray, isNull, lt, ne, sql } from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
import { db } from '~/db/client'
import {
  courtSlotLocks,
  courts,
  gameCourtOptions,
  gameSlots,
  games,
  locations,
  notifications,
  playerSlotLocks,
  users,
  type Game,
  type GameFormat,
  type Gender,
  type GameSlot,
  type User,
} from '~/db/schema'
import { assignCourt } from './assign'
import { lockSlotsFor } from './booking'
import { formatLabel, gameFormatOf, playsFormat } from './formats'
import { gameLocationRankSql } from './preferences'
import { levelSpan, playsAtLevel } from './rating'
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

export class AlreadyBookedError extends Error {
  constructor() {
    super("You're already in another game at that time.")
    this.name = 'AlreadyBookedError'
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

/** The 30-minute granules a player is committed for, one row each. */
function playerLockRows(userId: string, gameId: string, startsAt: number, endsAt: number) {
  return lockSlotsFor(startsAt, endsAt).map((slotStart) => ({ userId, slotStart, gameId }))
}

/**
 * Which table a UNIQUE violation came from.
 *
 * Court and player collisions are both primary-key rejections from the same
 * batch, and they mean completely different things to the person who hit them.
 */
function violates(error: unknown, table: string): boolean {
  return new RegExp(table, 'i').test(String((error as Error)?.message ?? error))
}

/** Non-host seats: 1 for singles, 3 for doubles. */
export function seatsToFill(format: GameFormat): number {
  return format === 'singles' ? 1 : 3
}

export type NewGameSlotInput =
  | { kind: 'invited'; invitedUserId: string }
  | { kind: 'seeker'; seekerNtrp: number; seekerGender?: 'woman' | 'man' | null }

export type CreateGameInput = {
  hostId: string
  hostNtrp: number
  /** Acceptable courts, best first. The game holds none of them until it fills. */
  courtIds: string[]
  startsAt: number
  endsAt: number
  format: GameFormat
  isMixed?: boolean
  hostGender?: Gender
  notes?: string | null
  slots: NewGameSlotInput[]
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
  if (input.courtIds.length === 0) {
    throw new GameValidationError('Pick at least one court you could play on.')
  }
  const expected = seatsToFill(input.format)
  if (input.slots.length !== expected) {
    throw new GameValidationError(
      `A ${input.format} game needs ${expected} other player${expected === 1 ? '' : 's'}.`,
    )
  }
  if (input.isMixed) {
    // Mixed applies to both formats now: mixed doubles is two of each, mixed
    // singles is one of each. What both need is a host with a stated gender,
    // because that's what the open seats are balanced against.
    if (!input.hostGender || input.hostGender === 'unspecified') {
      throw new GameValidationError(
        'Add your gender to your profile before hosting a mixed game — it decides which seats need filling.',
      )
    }
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

  const seekerLevels = input.slots
    .filter((s): s is Extract<NewGameSlotInput, { kind: 'seeker' }> => s.kind === 'seeker')
    .map((s) => s.seekerNtrp)

  // min/max describe the game for display and browse filtering. The real
  // admission test is whether a player opted into the exact level a seat asks
  // for -- see playsAtLevel().
  const levels = seekerLevels.length > 0 ? seekerLevels : [input.hostNtrp]
  const [minNtrp, maxNtrp] = levelSpan(levels)

  const gameId = newId()
  const gameRow = {
    id: gameId,
    hostId: input.hostId,
    // Deliberately unplaced. The court is chosen when the last seat is taken;
    // see assignCourt.
    courtId: null,
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    format: input.format,
    isMixed: input.isMixed ?? false,
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
      seekerGender: null,
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
      seekerGender: slot.kind === 'seeker' ? (slot.seekerGender ?? null) : null,
      filledByUserId: null,
      filledAt: null,
      status: 'open' as const,
    })),
  ]

  const optionRows = [...new Set(input.courtIds)].map((courtId, rank) => ({
    gameId,
    courtId,
    rank,
  }))

  // The host takes a seat in their own game, so they're committed for this
  // window exactly like anyone who claims one. Their *time* is held from the
  // start even though no court is.
  const hostLocks = playerLockRows(input.hostId, gameId, input.startsAt, input.endsAt)

  const database = db()
  try {
    await database.batch(
      batchOf(
        database.insert(games).values(gameRow),
        database.insert(gameSlots).values(slotRows),
        database.insert(gameCourtOptions).values(optionRows),
        database.insert(playerSlotLocks).values(hostLocks),
      ),
    )
  } catch (error) {
    if (violates(error, 'player_slot_locks')) throw new AlreadyBookedError()
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
  user: Pick<User, 'id' | 'ntrp' | 'playLevels' | 'gender' | 'formats'>,
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
  if (
    found.slot.kind === 'seeker' &&
    !playsAtLevel(user.playLevels, found.slot.seekerNtrp ?? game.minNtrp)
  ) {
    throw new GameValidationError(
      `That spot is for ${(found.slot.seekerNtrp ?? game.minNtrp).toFixed(1)} players. Add that level to your profile if you'd like to play it.`,
    )
  }

  if (found.slot.seekerGender && user.gender !== found.slot.seekerGender) {
    throw new GameValidationError(
      `That spot is held for a ${found.slot.seekerGender} to keep the game mixed.`,
    )
  }
  // Only mixed is gated here, which is what the old `plays_mixed` check did.
  // Claiming stays deliberately permissive about plain singles/doubles for the
  // same reason browsing ignores availability: someone who spots a game they
  // can make should be able to take it. Mixed is different — those seats exist
  // to keep a specific balance, so filling one has to be a choice.
  if (game.isMixed && !playsFormat(user.formats, game.format, true)) {
    throw new GameValidationError(
      `You haven't opted into ${formatLabel(game.format, true)} in your profile.`,
    )
  }

  const already = await db()
    .select({ id: gameSlots.id })
    .from(gameSlots)
    .where(and(eq(gameSlots.gameId, game.id), eq(gameSlots.filledByUserId, user.id)))
    .limit(1)
  if (already.length > 0) throw new GameValidationError("You're already in this game.")

  let claimed: GameSlot | undefined
  const database = db()
  try {
    // One transaction. The player locks go in first so that "you're already
    // booked then" is settled by the primary key rather than by a
    // read-then-write check two concurrent claims could both pass.
    const [, updated] = await database.batch(
      batchOf(
        database
          .insert(playerSlotLocks)
          .values(playerLockRows(user.id, game.id, game.startsAt, game.endsAt)),
        database
          .update(gameSlots)
          .set({ filledByUserId: user.id, filledAt: now, status: 'filled' })
          .where(and(eq(gameSlots.id, slotId), isNull(gameSlots.filledByUserId)))
          .returning(),
      ),
    )
    claimed = (updated as GameSlot[])[0]
  } catch (error) {
    if (violates(error, 'player_slot_locks')) throw new AlreadyBookedError()
    // The partial unique index catches a player double-claiming two seats in
    // the same game from two devices at once.
    if (isConstraintViolation(error)) throw new GameValidationError("You're already in this game.")
    throw error
  }

  if (!claimed) {
    // Somebody else took the seat between the lock and the update. The batch
    // committed the locks anyway, so release them — otherwise this player
    // would look booked for a game they aren't in.
    await db()
      .delete(playerSlotLocks)
      .where(and(eq(playerSlotLocks.userId, user.id), eq(playerSlotLocks.gameId, game.id)))
    throw new SlotTakenError()
  }

  const remainingOpen = await countOpenSlots(game.id)
  if (remainingOpen === 0 && game.status === 'open') {
    // The last seat just went, so this is the moment the court is decided.
    const result = await assignCourt(game.id)
    game.status = result.game.status
    game.courtId = result.game.courtId
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
  user: Pick<User, 'id' | 'ntrp' | 'playLevels' | 'gender' | 'formats'>,
): Promise<{ game: Game; slot: GameSlot; remainingOpen: number }> {
  const open = await db()
    .select()
    .from(gameSlots)
    .where(and(eq(gameSlots.gameId, gameId), eq(gameSlots.status, 'open')))
    .orderBy(asc(gameSlots.slotIndex))

  // Seats explicitly reserved for this player come first, then generic ones.
  const eligible = open
    .filter((slot) =>
      slot.kind === 'invited'
        ? slot.invitedUserId === user.id
        : slot.kind === 'seeker' &&
          playsAtLevel(user.playLevels, slot.seekerNtrp ?? 0) &&
          (!slot.seekerGender || slot.seekerGender === user.gender),
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

  const database = db()
  await database.batch(
    batchOf(
      database
        .update(gameSlots)
        .set({ filledByUserId: null, filledAt: null, status: 'open' })
        .where(and(eq(gameSlots.gameId, gameId), eq(gameSlots.filledByUserId, userId))),
      // Free the player's time as well as the seat, or they stay blocked from
      // every other game in that window.
      database
        .delete(playerSlotLocks)
        .where(and(eq(playerSlotLocks.gameId, gameId), eq(playerSlotLocks.userId, userId))),
    ),
  )

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
      database.delete(playerSlotLocks).where(eq(playerSlotLocks.gameId, gameId)),
    ),
  )

  return { ...game, status: 'cancelled', cancelledAt: Date.now() }
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export type GameDetail = {
  game: Game
  /** Null until the game fills and a court is assigned. */
  court: { id: string; name: string; surface: string; hasLights: boolean } | null
  location: {
    id: string
    name: string
    address: string | null
    lat: number | null
    lng: number | null
  } | null
  /** Where it might end up, while it has no court. Best first. */
  courtOptions: Array<{ courtId: string; courtName: string; locationName: string }>
  host: { id: string; name: string; ntrp: number }
  slots: Array<{
    slot: GameSlot
    /**
     * Deliberately no phone or email. A game page is readable by anyone with
     * the link, and even limiting contact details to participants hands out a
     * player's number to whoever else claims a seat. Coordination happens
     * through the notifications the app already sends.
     */
    player: { id: string; name: string; ntrp: number } | null
    invited: { id: string; name: string } | null
  }>
}

export async function getGame(gameId: string): Promise<GameDetail | null> {
  const rows = await db()
    .select({ game: games, court: courts, location: locations, host: users })
    .from(games)
    // Left, not inner: an open game holds no court, and its page still has to
    // render — it's the page every invitation links to.
    .leftJoin(courts, eq(courts.id, games.courtId))
    .leftJoin(locations, eq(locations.id, courts.locationId))
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

  // Only worth fetching while the game has no court of its own.
  const courtOptions = row.court
    ? []
    : await db()
        .select({
          courtId: gameCourtOptions.courtId,
          courtName: courts.name,
          locationName: locations.name,
        })
        .from(gameCourtOptions)
        .innerJoin(courts, eq(courts.id, gameCourtOptions.courtId))
        .innerJoin(locations, eq(locations.id, courts.locationId))
        .where(eq(gameCourtOptions.gameId, gameId))
        .orderBy(asc(gameCourtOptions.rank))

  return {
    game: row.game,
    court: row.court
      ? {
          id: row.court.id,
          name: row.court.name,
          surface: row.court.surface,
          hasLights: row.court.hasLights,
        }
      : null,
    location: row.location
      ? {
          id: row.location.id,
          name: row.location.name,
          address: row.location.address,
          lat: row.location.lat,
          lng: row.location.lng,
        }
      : null,
    courtOptions,
    host: { id: row.host.id, name: row.host.name, ntrp: row.host.ntrp },
    slots: slotRows.map((r) => ({
      slot: r.slot,
      player: r.player
        ? { id: r.player.id, name: r.player.name, ntrp: r.player.ntrp }
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
    // Left, not inner: a game that is still looking for players has no court
    // yet, and it very much still needs invitations sent about it.
    .leftJoin(courts, eq(courts.id, games.courtId))
    .leftJoin(locations, eq(locations.id, courts.locationId))
    .innerJoin(users, eq(users.id, games.hostId))
    .where(eq(games.id, gameId))
    .limit(1)

  const brief = rows[0]
  if (!brief) return null
  if (brief.courtName) return { ...brief, candidateLocations: [] }

  // Not placed yet, so tell people where it *might* be. "Come and play tennis
  // somewhere" is not an invitation anyone can act on.
  const options = await db()
    .selectDistinct({ name: locations.name })
    .from(gameCourtOptions)
    .innerJoin(courts, eq(courts.id, gameCourtOptions.courtId))
    .innerJoin(locations, eq(locations.id, courts.locationId))
    .where(eq(gameCourtOptions.gameId, gameId))

  return { ...brief, candidateLocations: options.map((o) => o.name) }
}

export type GameListItem = {
  game: Game
  /** Null while the game is still filling and has no court. */
  courtName: string | null
  locationName: string | null
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

/**
 * Left joins on court and location, not inner.
 *
 * Under flexible booking a game holds no court until it fills, so *every* open
 * game is unplaced. An inner join here would empty the dashboard.
 */
function listFrom() {
  return db()
    .select(listSelection)
    .from(games)
    .leftJoin(courts, eq(courts.id, games.courtId))
    .leftJoin(locations, eq(locations.id, courts.locationId))
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
  user: Pick<User, 'id' | 'playLevels' | 'formats'>,
  now = Date.now(),
  limit = 50,
): Promise<GameListItem[]> {
  const formats = [...new Set((user.formats ?? []).map(gameFormatOf))]
  if (formats.length === 0 || user.playLevels.length === 0) return []

  // Mixed is not filtered here. Opting into mixed doubles means you play
  // doubles-shaped games, and a mixed game a player can't fill a seat in is
  // still worth seeing in a browse list.
  return listFrom()
    .where(
      and(
        eq(games.status, 'open'),
        gt(games.startsAt, now),
        inArray(games.format, formats),
        sql`NOT EXISTS (SELECT 1 FROM game_slots gs WHERE gs.game_id = ${games.id} AND gs.filled_by_user_id = ${user.id})`,
        // An open seat asking for a level this player actually opted into.
        openSeatAtOneOfSql(user.playLevels),
        // Not a game they're already committed against. Browsing still ignores
        // *posted availability* on purpose — someone who spots a game they can
        // make should be able to grab it — but a game that collides with one
        // they're already in is one the claim would refuse anyway.
        sql`NOT EXISTS (
          SELECT 1 FROM player_slot_locks psl
          WHERE psl.user_id = ${user.id}
            AND psl.slot_start >= ${games.startsAt}
            AND psl.slot_start < ${games.endsAt}
        )`,
      ),
    )
    // Their preferred courts first, then soonest. Preference only reorders —
    // a game at a location they never listed is still in the list.
    .orderBy(gameLocationRankSql(user.id), asc(games.startsAt))
    .limit(limit)
}

/**
 * SQL fragment: does this game have an open seeker seat at one of `levels`?
 *
 * Levels are interpolated as bound parameters rather than pulled from the
 * user's JSON column, because this is called with a known list in hand and an
 * IN (...) is clearer than a json_each join here.
 */
function openSeatAtOneOfSql(levels: number[]) {
  return sql`EXISTS (
    SELECT 1 FROM game_slots gs
    WHERE gs.game_id = ${games.id}
      AND gs.status = 'open'
      AND gs.kind = 'seeker'
      AND gs.seeker_ntrp IN ${levels}
  )`
}

/** Every upcoming game, for the community calendar. */
export async function listUpcomingGames(now = Date.now(), limit = 100): Promise<GameListItem[]> {
  return listFrom()
    .where(and(gt(games.endsAt, now), ne(games.status, 'cancelled')))
    .orderBy(asc(games.startsAt))
    .limit(limit)
}

/**
 * Player names and open-seat counts for a set of games, in two queries rather
 * than two per game. Used by the location day view, where a busy evening can
 * easily be a dozen games.
 */
export async function gameRosters(
  gameIds: string[],
): Promise<Map<string, { players: string[]; openSlots: number }>> {
  const result = new Map<string, { players: string[]; openSlots: number }>()
  if (gameIds.length === 0) return result

  const rows = await db()
    .select({
      gameId: gameSlots.gameId,
      status: gameSlots.status,
      slotIndex: gameSlots.slotIndex,
      name: users.name,
    })
    .from(gameSlots)
    .leftJoin(users, eq(users.id, gameSlots.filledByUserId))
    .where(inArray(gameSlots.gameId, gameIds))
    .orderBy(asc(gameSlots.gameId), asc(gameSlots.slotIndex))

  for (const row of rows) {
    const entry = result.get(row.gameId) ?? { players: [], openSlots: 0 }
    if (row.status === 'filled' && row.name) entry.players.push(row.name)
    else if (row.status === 'open') entry.openSlots += 1
    result.set(row.gameId, entry)
  }
  return result
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
