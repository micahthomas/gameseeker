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
import { localTime, makeCourt, makeLocation, makePlayer, makeUser, resetDb, testDb } from './helpers'

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

  it('spans min/max across exactly the requested seeker levels', async () => {
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
    expect(game.minNtrp).toBe(3.0)
    expect(game.maxNtrp).toBe(4.0)
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
    const player = await makePlayer({ name: 'Claimer', ntrp: 3.5 })

    const result = await claimAnyOpenSlot(game.id, player)
    expect(result.remainingOpen).toBe(0)

    const [row] = await testDb().select().from(games).where(eq(games.id, game.id))
    expect(row?.status).toBe('full')
  })

  it('gives the seat to exactly one of two simultaneous claimants', async () => {
    const game = await createGame(baseGame())
    const a = await makePlayer({ name: 'A', ntrp: 3.5 })
    const b = await makePlayer({ name: 'B', ntrp: 3.5 })

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
    const a = await makePlayer({ name: 'A', ntrp: 3.5 })
    const b = await makePlayer({ name: 'B', ntrp: 3.5 })

    const results = await Promise.allSettled([
      claimAnyOpenSlot(game.id, a),
      claimAnyOpenSlot(game.id, b),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2)
    expect(await countOpenSlots(game.id)).toBe(1)
  })

  it('refuses a player who did not opt into that level', async () => {
    const game = await createGame(baseGame())
    const tooStrong = await makePlayer({ name: 'Pro', ntrp: 5.0 })
    await expect(claimAnyOpenSlot(game.id, tooStrong)).rejects.toBeInstanceOf(SlotTakenError)
  })

  it('lets a player who opted into a level claim a seat at it', async () => {
    // A 3.0 who said they'll also play 3.5 can take a 3.5 seat.
    const game = await createGame(baseGame())
    const playsUp = await makePlayer({ name: 'Ambitious', ntrp: 3.0, playLevels: [3.0, 3.5] })
    const result = await claimAnyOpenSlot(game.id, playsUp)
    expect(result.slot.seekerNtrp).toBe(3.5)
  })

  it('refuses a same-rated player who did not opt into that level', async () => {
    // Rating alone is not consent: a 3.5 who only plays 3.5 is fine here...
    const game = await createGame(baseGame({ slots: [{ kind: 'seeker', seekerNtrp: 4.0 }] }))
    const staysHome = await makePlayer({ name: 'Homebody', ntrp: 3.5, playLevels: [3.5] })
    // ...but this seat wants 4.0, which they never opted into.
    await expect(claimAnyOpenSlot(game.id, staysHome)).rejects.toBeInstanceOf(SlotTakenError)
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
    const player = await makePlayer({ ntrp: 3.5 })
    await claimAnyOpenSlot(game.id, player)
    await expect(claimAnyOpenSlot(game.id, player)).rejects.toBeInstanceOf(GameValidationError)
  })

  it('keeps an invited seat for the invited player', async () => {
    const friend = await makePlayer({ name: 'Friend', ntrp: 3.5 })
    const stranger = await makePlayer({ name: 'Stranger', ntrp: 3.5 })
    const game = await createGame(
      baseGame({ slots: [{ kind: 'invited', invitedUserId: friend.id }] }),
    )

    await expect(claimAnyOpenSlot(game.id, stranger)).rejects.toBeInstanceOf(SlotTakenError)
    const result = await claimAnyOpenSlot(game.id, friend)
    expect(result.slot.invitedUserId).toBe(friend.id)
  })
})

describe('mixed doubles', () => {
  function mixedGame(overrides = {}) {
    return baseGame({
      format: 'doubles' as const,
      isMixed: true,
      hostGender: 'man' as const,
      slots: [
        { kind: 'seeker' as const, seekerNtrp: 3.5, seekerGender: 'woman' as const },
        { kind: 'seeker' as const, seekerNtrp: 3.5, seekerGender: 'woman' as const },
        { kind: 'seeker' as const, seekerNtrp: 3.5, seekerGender: 'man' as const },
      ],
      ...overrides,
    })
  }

  it('holds each seat for the gender that keeps the game mixed', async () => {
    const game = await createGame(mixedGame())
    const woman = await makePlayer({ name: 'W', ntrp: 3.5, gender: 'woman' })
    const result = await claimAnyOpenSlot(game.id, woman)
    expect(result.slot.seekerGender).toBe('woman')
  })

  it('refuses a player whose gender does not fit any open seat', async () => {
    const game = await createGame(
      baseGame({
        format: 'doubles',
        isMixed: true,
        hostGender: 'man',
        slots: [
          { kind: 'seeker', seekerNtrp: 3.5, seekerGender: 'woman' },
          { kind: 'seeker', seekerNtrp: 3.5, seekerGender: 'woman' },
          { kind: 'seeker', seekerNtrp: 3.5, seekerGender: 'woman' },
        ],
      }),
    )
    const man = await makePlayer({ name: 'M', ntrp: 3.5, gender: 'man' })
    await expect(claimAnyOpenSlot(game.id, man)).rejects.toBeInstanceOf(SlotTakenError)
  })

  it('refuses a player who turned mixed off', async () => {
    const game = await createGame(mixedGame())
    const optedOut = await makePlayer({
      name: 'No mixed',
      ntrp: 3.5,
      gender: 'woman',
      playsMixed: false,
    })
    await expect(claimAnyOpenSlot(game.id, optedOut)).rejects.toBeInstanceOf(GameValidationError)
  })

  it('will not mark a singles game as mixed', async () => {
    await expect(
      createGame(baseGame({ isMixed: true, hostGender: 'man' })),
    ).rejects.toBeInstanceOf(GameValidationError)
  })

  it('will not let a host without a stated gender create one', async () => {
    await expect(
      createGame(mixedGame({ hostGender: 'unspecified' })),
    ).rejects.toBeInstanceOf(GameValidationError)
  })

  it('fills to two and two', async () => {
    const game = await createGame(mixedGame())
    const a = await makePlayer({ name: 'A', ntrp: 3.5, gender: 'woman' })
    const b = await makePlayer({ name: 'B', ntrp: 3.5, gender: 'woman' })
    const c = await makePlayer({ name: 'C', ntrp: 3.5, gender: 'man' })
    for (const player of [a, b, c]) await claimAnyOpenSlot(game.id, player)
    expect(await countOpenSlots(game.id)).toBe(0)
  })
})

describe('leaving and cancelling', () => {
  it('reopens a seat when a player drops out', async () => {
    const game = await createGame(baseGame())
    const player = await makePlayer({ ntrp: 3.5 })
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
