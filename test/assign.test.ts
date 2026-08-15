import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { courtSlotLocks, games } from '~/db/schema'
import { isCourtFree } from '~/server/booking'
import { claimAnyOpenSlot, createGame } from '~/server/games'
import { setPreferredLocations } from '~/server/preferences'
import { localTime, makeCourt, makeLocation, makePlayer, makeUser, resetDb, testDb } from './helpers'

/**
 * Assigning a court at the moment a game fills.
 *
 * A game holds nothing while it looks for players, so the contest for a court
 * happens later than it used to — but it is still settled by the primary key
 * on `court_slot_locks`, not by application logic. These tests are mostly
 * about that, and about the failure mode it introduces: a game that fills and
 * then has nowhere to play.
 */

const START = localTime(2026, 9, 15, 17, 0)
const END = START + 90 * 60_000

let hostId: string
let alto: string
let salvador: string
let altoCourt: string
let salvadorCourt: string

beforeEach(async () => {
  await resetDb()
  alto = await makeLocation('Alto Park')
  salvador = await makeLocation('Salvador Perez Park')
  altoCourt = await makeCourt(alto)
  salvadorCourt = await makeCourt(salvador)
  hostId = await makeUser({ name: 'Host', ntrp: 3.5 })
})

async function gameOffering(courtIds: string[], host = hostId) {
  return createGame({
    hostId: host,
    hostNtrp: 3.5,
    courtIds,
    startsAt: START,
    endsAt: END,
    format: 'singles',
    slots: [{ kind: 'seeker', seekerNtrp: 3.5 }],
  })
}

async function reload(gameId: string) {
  const rows = await testDb().select().from(games).where(eq(games.id, gameId))
  return rows[0]!
}

describe('placing a game when its last seat fills', () => {
  it('takes a court only once the game is full', async () => {
    const game = await gameOffering([altoCourt])
    expect(game.courtId).toBeNull()
    expect(await isCourtFree(altoCourt, START, END)).toBe(true)

    await claimAnyOpenSlot(game.id, await makePlayer({ name: 'Filler', ntrp: 3.5 }))

    const placed = await reload(game.id)
    expect(placed.courtId).toBe(altoCourt)
    expect(placed.status).toBe('full')
    expect(await isCourtFree(altoCourt, START, END)).toBe(false)
  })

  it('holds every granule of the window, as creation used to', async () => {
    const game = await gameOffering([altoCourt])
    await claimAnyOpenSlot(game.id, await makePlayer({ name: 'Filler', ntrp: 3.5 }))

    // 90 minutes => three 30-minute granules.
    const locks = await testDb()
      .select()
      .from(courtSlotLocks)
      .where(eq(courtSlotLocks.gameId, game.id))
    expect(locks).toHaveLength(3)
  })

  it('falls through to the next option when the first is taken', async () => {
    // Somebody else takes Alto in the meantime.
    const rival = await gameOffering([altoCourt], await makeUser({ name: 'Rival', ntrp: 3.5 }))
    await claimAnyOpenSlot(rival.id, await makePlayer({ name: 'Rival filler', ntrp: 3.5 }))

    const game = await gameOffering([altoCourt, salvadorCourt])
    await claimAnyOpenSlot(game.id, await makePlayer({ name: 'Filler', ntrp: 3.5 }))

    const placed = await reload(game.id)
    expect(placed.courtId).toBe(salvadorCourt)
    expect(placed.status).toBe('full')
  })

  it('marks a game unplaceable when every court it offered has gone', async () => {
    const rival = await gameOffering([altoCourt], await makeUser({ name: 'Rival', ntrp: 3.5 }))
    await claimAnyOpenSlot(rival.id, await makePlayer({ name: 'Rival filler', ntrp: 3.5 }))

    const game = await gameOffering([altoCourt])
    await claimAnyOpenSlot(game.id, await makePlayer({ name: 'Filler', ntrp: 3.5 }))

    const stuck = await reload(game.id)
    // Not cancelled: the players are real and willing, only the venue is
    // missing. The host is told and can move it.
    expect(stuck.status).toBe('unplaceable')
    expect(stuck.courtId).toBeNull()
  })

  it('gives the last free court to exactly one of two games filling at once', async () => {
    const otherHost = await makeUser({ name: 'Other', ntrp: 3.5 })
    const first = await gameOffering([altoCourt])
    const second = await gameOffering([altoCourt], otherHost)

    await Promise.all([
      claimAnyOpenSlot(first.id, await makePlayer({ name: 'A', ntrp: 3.5 })),
      claimAnyOpenSlot(second.id, await makePlayer({ name: 'B', ntrp: 3.5 })),
    ])

    const statuses = [(await reload(first.id)).status, (await reload(second.id)).status].sort()
    expect(statuses).toEqual(['full', 'unplaceable'])
  })
})

describe('choosing between courts', () => {
  it('prefers the court whose location the players actually chose', async () => {
    const player = await makePlayer({ name: 'Picky', ntrp: 3.5 })
    await setPreferredLocations(player.id, [salvador])
    await setPreferredLocations(hostId, [salvador, alto])

    // Alto is offered first, but both players rank Salvador higher.
    const game = await gameOffering([altoCourt, salvadorCourt])
    await claimAnyOpenSlot(game.id, player)

    expect((await reload(game.id)).courtId).toBe(salvadorCourt)
  })

  it("falls back to the host's own order when nobody has a preference", async () => {
    const game = await gameOffering([salvadorCourt, altoCourt])
    await claimAnyOpenSlot(game.id, await makePlayer({ name: 'Easy', ntrp: 3.5 }))

    expect((await reload(game.id)).courtId).toBe(salvadorCourt)
  })
})
