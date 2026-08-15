import { beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { courtSlotLocks, gameSlots, games } from '~/db/schema'
import {
  CourtTakenError,
  GameValidationError,
  SlotTakenError,
  cancelGame,
  claimAnyOpenSlot,
  claimSlot,
  countOpenSlots,
  createGame,
  leaveGame,
} from '~/server/games'
import { isCourtFree } from '~/server/booking'
import { HOUR } from '~/server/time'
import { localTime, makeCourt, makeLocation, makeUser, resetDb, testDb } from './helpers'

let locationId: string
let courtId: string
let hostId: string

const START = localTime(2026, 9, 15, 17, 0)
const END = START + 90 * 60_000

beforeEach(async () => {
  await resetDb()
  locationId = await makeLocation()
  courtId = await makeCourt(locationId)
  hostId = await makeUser({ name: 'Host', ntrp: 3.5 })
})

function baseGame(overrides: Partial<Parameters<typeof createGame>[0]> = {}) {
  return {
    hostId,
    hostNtrp: 3.5,
    courtId,
    startsAt: START,
    endsAt: END,
    format: 'singles' as const,
    slots: [{ kind: 'seeker' as const, seekerNtrp: 3.5 }],
    ...overrides,
  }
}

describe('creating a game', () => {
  it('creates the game, its seats, and its court locks together', async () => {
    const game = await createGame(baseGame())

    const slots = await testDb().select().from(gameSlots).where(eq(gameSlots.gameId, game.id))
    expect(slots).toHaveLength(2)
    expect(slots.find((s) => s.kind === 'host')?.filledByUserId).toBe(hostId)
    expect(slots.find((s) => s.kind === 'seeker')?.status).toBe('open')

    // 90 minutes => three 30-minute granules.
    const locks = await testDb()
      .select()
      .from(courtSlotLocks)
      .where(eq(courtSlotLocks.gameId, game.id))
    expect(locks).toHaveLength(3)
  })

  it('creates three open seats for doubles', async () => {
    const game = await createGame(
      baseGame({
        format: 'doubles',
        slots: [
          { kind: 'seeker', seekerNtrp: 3.5 },
          { kind: 'seeker', seekerNtrp: 3.5 },
          { kind: 'seeker', seekerNtrp: 4.0 },
        ],
      }),
    )
    expect(await countOpenSlots(game.id)).toBe(3)
  })

  it('spans the level band across every requested seeker level', async () => {
    const game = await createGame(
      baseGame({
        format: 'doubles',
        slots: [
          { kind: 'seeker', seekerNtrp: 3.0 },
          { kind: 'seeker', seekerNtrp: 3.5 },
          { kind: 'seeker', seekerNtrp: 4.0 },
        ],
      }),
    )
    expect(game.minNtrp).toBe(2.5)
    expect(game.maxNtrp).toBe(4.5)
  })

  it('rejects a second game overlapping the same court', async () => {
    await createGame(baseGame())

    // Starts 30 minutes in — overlaps two of the three held granules.
    await expect(
      createGame(baseGame({ startsAt: START + 30 * 60_000, endsAt: END + 30 * 60_000 })),
    ).rejects.toBeInstanceOf(CourtTakenError)
  })

  it('leaves no orphaned game row when the court is taken', async () => {
    await createGame(baseGame())
    await expect(createGame(baseGame())).rejects.toBeInstanceOf(CourtTakenError)

    // The whole batch rolls back, so exactly one game exists.
    const all = await testDb().select().from(games)
    expect(all).toHaveLength(1)
  })

  it('lets exactly one of two simultaneous bookings win', async () => {
    const otherHost = await makeUser({ name: 'Other', ntrp: 4.0 })

    const results = await Promise.allSettled([
      createGame(baseGame()),
      createGame(baseGame({ hostId: otherHost, hostNtrp: 4.0 })),
    ])

    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(CourtTakenError)
  })

  it('allows a back-to-back booking that only touches free granules', async () => {
    await createGame(baseGame())
    const next = await createGame(baseGame({ startsAt: END, endsAt: END + HOUR }))
    expect(next.id).toBeTruthy()
  })

  it('allows the same time on a different court', async () => {
    await createGame(baseGame())
    const otherCourt = await makeCourt(locationId, 'Court 2')
    const next = await createGame(baseGame({ courtId: otherCourt }))
    expect(next.id).toBeTruthy()
  })

  it('rejects times that are not on a half hour', async () => {
    await expect(
      createGame(baseGame({ startsAt: START + 10 * 60_000, endsAt: END })),
    ).rejects.toBeInstanceOf(GameValidationError)
  })

  it('rejects a game in the past', async () => {
    await expect(
      createGame(baseGame({ startsAt: localTime(2020, 1, 1, 17, 0), endsAt: localTime(2020, 1, 1, 18, 30) })),
    ).rejects.toBeInstanceOf(GameValidationError)
  })

  it('rejects a seat count that does not match the format', async () => {
    await expect(createGame(baseGame({ format: 'doubles' }))).rejects.toBeInstanceOf(
      GameValidationError,
    )
  })
})

describe('claiming a spot', () => {
  it('fills an open seat and marks the game full', async () => {
    const game = await createGame(baseGame())
    const player = { id: await makeUser({ name: 'Claimer', ntrp: 3.5 }), ntrp: 3.5 }

    const result = await claimAnyOpenSlot(game.id, player)
    expect(result.remainingOpen).toBe(0)

    const [row] = await testDb().select().from(games).where(eq(games.id, game.id))
    expect(row?.status).toBe('full')
  })

  it('gives the seat to exactly one of two simultaneous claimants', async () => {
    const game = await createGame(baseGame())
    const a = { id: await makeUser({ name: 'A', ntrp: 3.5 }), ntrp: 3.5 }
    const b = { id: await makeUser({ name: 'B', ntrp: 3.5 }), ntrp: 3.5 }

    const [slot] = await testDb()
      .select()
      .from(gameSlots)
      .where(eq(gameSlots.gameId, game.id))
      .then((rows) => rows.filter((r) => r.kind === 'seeker'))

    const results = await Promise.allSettled([
      claimSlot(slot!.id, a),
      claimSlot(slot!.id, b),
    ])

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
    expect(rejected.reason).toBeInstanceOf(SlotTakenError)
  })

  it('seats two players on two identical open seats', async () => {
    // The point of claiming "any open slot" rather than a specific one: a
    // doubles game with two 3.5 openings should accept both responders.
    const game = await createGame(
      baseGame({
        format: 'doubles',
        slots: [
          { kind: 'seeker', seekerNtrp: 3.5 },
          { kind: 'seeker', seekerNtrp: 3.5 },
          { kind: 'seeker', seekerNtrp: 3.5 },
        ],
      }),
    )
    const a = { id: await makeUser({ name: 'A', ntrp: 3.5 }), ntrp: 3.5 }
    const b = { id: await makeUser({ name: 'B', ntrp: 3.5 }), ntrp: 3.5 }

    const results = await Promise.allSettled([
      claimAnyOpenSlot(game.id, a),
      claimAnyOpenSlot(game.id, b),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2)
    expect(await countOpenSlots(game.id)).toBe(1)
  })

  it('refuses a player outside the level band', async () => {
    const game = await createGame(baseGame())
    const tooStrong = { id: await makeUser({ name: 'Pro', ntrp: 5.0 }), ntrp: 5.0 }
    await expect(claimAnyOpenSlot(game.id, tooStrong)).rejects.toBeInstanceOf(GameValidationError)
  })

  it('refuses a second seat to a player already in the game', async () => {
    const game = await createGame(
      baseGame({
        format: 'doubles',
        slots: [
          { kind: 'seeker', seekerNtrp: 3.5 },
          { kind: 'seeker', seekerNtrp: 3.5 },
          { kind: 'seeker', seekerNtrp: 3.5 },
        ],
      }),
    )
    const player = { id: await makeUser({ ntrp: 3.5 }), ntrp: 3.5 }
    await claimAnyOpenSlot(game.id, player)
    await expect(claimAnyOpenSlot(game.id, player)).rejects.toBeInstanceOf(GameValidationError)
  })

  it('keeps an invited seat for the invited player', async () => {
    const friend = await makeUser({ name: 'Friend', ntrp: 3.5 })
    const stranger = { id: await makeUser({ name: 'Stranger', ntrp: 3.5 }), ntrp: 3.5 }
    const game = await createGame(
      baseGame({ slots: [{ kind: 'invited', invitedUserId: friend }] }),
    )

    await expect(claimAnyOpenSlot(game.id, stranger)).rejects.toBeInstanceOf(SlotTakenError)
    const result = await claimAnyOpenSlot(game.id, { id: friend, ntrp: 3.5 })
    expect(result.slot.invitedUserId).toBe(friend)
  })
})

describe('leaving and cancelling', () => {
  it('reopens a seat when a player drops out', async () => {
    const game = await createGame(baseGame())
    const player = { id: await makeUser({ ntrp: 3.5 }), ntrp: 3.5 }
    await claimAnyOpenSlot(game.id, player)

    await leaveGame(game.id, player.id)

    expect(await countOpenSlots(game.id)).toBe(1)
    const [row] = await testDb().select().from(games).where(eq(games.id, game.id))
    expect(row?.status).toBe('open')
  })

  it('will not let the host leave their own game', async () => {
    const game = await createGame(baseGame())
    await expect(leaveGame(game.id, hostId)).rejects.toBeInstanceOf(GameValidationError)
  })

  it('releases the court when a game is cancelled', async () => {
    const game = await createGame(baseGame())
    expect(await isCourtFree(courtId, START, END)).toBe(false)

    await cancelGame(game.id, hostId)

    expect(await isCourtFree(courtId, START, END)).toBe(true)
    // The freed court can be booked again.
    const replacement = await createGame(baseGame())
    expect(replacement.id).not.toBe(game.id)
  })

  it('only lets the host or an admin cancel', async () => {
    const game = await createGame(baseGame())
    const other = await makeUser({ name: 'Nosy' })
    await expect(cancelGame(game.id, other)).rejects.toBeInstanceOf(GameValidationError)
    await expect(cancelGame(game.id, other, true)).resolves.toMatchObject({ status: 'cancelled' })
  })
})
