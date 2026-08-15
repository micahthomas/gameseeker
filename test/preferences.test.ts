import { beforeEach, describe, expect, it } from 'vitest'
import { availabilityRules, userLocations } from '~/db/schema'
import { createGame, listOpenGamesFor } from '~/server/games'
import { findCandidates } from '~/server/matching'
import { defaultFormats } from '~/server/formats'
import { getPreferredLocationIds, setPreferredLocations } from '~/server/preferences'
import { DAY, localWeekday } from '~/server/time'
import { newId } from '~/server/tokens'
import { localTime, makeCourt, makeLocation, makeUser, resetDb, testDb } from './helpers'

/**
 * Location preference is a *soft* signal: it orders, it never excludes. These
 * tests are mostly about proving the second half of that — an unranked player
 * still turns up, just later.
 */

const START = localTime(2026, 9, 15, 17, 0) // Tuesday 5:00 PM
const END = START + 90 * 60_000
const WEEKDAY = localWeekday(START)

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

async function availableAt(name: string, locationIds: string[]) {
  const id = await makeUser({ name, ntrp: 3.5 })
  await testDb().insert(availabilityRules).values({
    id: newId(),
    userId: id,
    weekday: WEEKDAY,
    startMinute: 16 * 60,
    endMinute: 20 * 60,
    formatPref: 'either',
    effectiveFrom: START - 30 * DAY,
    effectiveUntil: null,
    isActive: true,
    createdAt: Date.now(),
  })
  if (locationIds.length > 0) await setPreferredLocations(id, locationIds)
  return id
}

async function gameAt(courtId: string, startsAt = START) {
  return createGame({
    hostId,
    hostNtrp: 3.5,
    courtId,
    startsAt,
    endsAt: startsAt + 90 * 60_000,
    format: 'singles',
    slots: [{ kind: 'seeker', seekerNtrp: 3.5 }],
  })
}

describe('storing a preference list', () => {
  it('keeps the order it was given', async () => {
    const player = await makeUser({ ntrp: 3.5 })
    await setPreferredLocations(player, [salvador, alto])
    expect(await getPreferredLocationIds(player)).toEqual([salvador, alto])
  })

  it('rewrites ranks contiguously so removing one leaves no gap', async () => {
    const player = await makeUser({ ntrp: 3.5 })
    await setPreferredLocations(player, [salvador, alto])
    await setPreferredLocations(player, [alto])

    const rows = await testDb().select().from(userLocations)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ locationId: alto, rank: 0 })
  })

  it('drops a duplicate rather than failing the whole write', async () => {
    // The primary key would reject the batch outright, and a repeated entry
    // from a reorder UI is a slip, not something to error over.
    const player = await makeUser({ ntrp: 3.5 })
    expect(await setPreferredLocations(player, [alto, salvador, alto])).toEqual([alto, salvador])
  })

  it('replaces the list wholesale', async () => {
    const player = await makeUser({ ntrp: 3.5 })
    await setPreferredLocations(player, [alto, salvador])
    await setPreferredLocations(player, [salvador])
    expect(await getPreferredLocationIds(player)).toEqual([salvador])
  })
})

describe('candidate ordering', () => {
  it('messages players who listed the location first', async () => {
    const listed = await availableAt('Listed', [alto])
    const other = await availableAt('Other', [salvador])
    const game = await gameAt(altoCourt)

    const found = await findCandidates({ ...game, locationId: alto }, [3.5])
    expect(found.map((c) => c.id)).toEqual([listed, other])
  })

  it('still reaches players who listed nothing at all', async () => {
    // The whole point of soft preference. A hard filter here would let a
    // small pool go quiet.
    const unranked = await availableAt('Unranked', [])
    const listed = await availableAt('Listed', [alto])
    const game = await gameAt(altoCourt)

    const found = await findCandidates({ ...game, locationId: alto }, [3.5])
    expect(found.map((c) => c.id)).toEqual([listed, unranked])
    expect(found).toHaveLength(2)
  })

  it('respects rank order, not merely presence', async () => {
    const first = await availableAt('First', [alto, salvador])
    const second = await availableAt('Second', [salvador, alto])
    const game = await gameAt(altoCourt)

    // Both listed Alto; only the ranks separate them.
    const found = await findCandidates({ ...game, locationId: alto }, [3.5])
    expect(found.map((c) => c.id)).toEqual([first, second])
  })

  it('falls back to level closeness when no location is known', async () => {
    const a = await availableAt('A', [alto])
    const b = await availableAt('B', [])
    const game = await gameAt(altoCourt)

    const found = await findCandidates({ ...game, locationId: null }, [3.5])
    expect(found.map((c) => c.id).sort()).toEqual([a, b].sort())
  })
})

/** listOpenGamesFor wants the shape, not just the id. */
async function browser() {
  const id = await makeUser({ name: 'Browser', ntrp: 3.5 })
  return { id, playLevels: [3.5], formats: defaultFormats() }
}

describe('the open games list', () => {
  it('puts games at preferred locations first, then soonest', async () => {
    const player = await browser()
    await setPreferredLocations(player.id, [alto])

    // The Salvador game is sooner, but Alto is where they said they play.
    await gameAt(salvadorCourt, START)
    await gameAt(altoCourt, START + 4 * 60 * 60_000)

    const open = await listOpenGamesFor(player, START - DAY)
    expect(open).toHaveLength(2)
    expect(open[0]!.locationName).toBe('Alto Park')
    expect(open[1]!.locationName).toBe('Salvador Perez Park')
  })

  it('orders by start time when nothing is preferred', async () => {
    const player = await browser()
    await gameAt(salvadorCourt, START)
    await gameAt(altoCourt, START + 4 * 60 * 60_000)

    const open = await listOpenGamesFor(player, START - DAY)
    expect(open.map((g) => g.locationName)).toEqual(['Salvador Perez Park', 'Alto Park'])
  })
})
