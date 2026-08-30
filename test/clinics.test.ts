import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { clinicOccurrences, clinicSignups, clinics, courtSlotLocks, playerSlotLocks } from '~/db/schema'
import {
  ClinicFullError,
  ClinicValidationError,
  PlayerBusyError,
  cancelClinic,
  cancelOccurrence,
  createClinic,
  courtsFreeForSeries,
  generateOccurrences,
  getClinic,
  signUpForClinic,
  withdrawFromClinic,
  type CreateClinicInput,
} from '~/server/clinics'
import { claimAnyOpenSlot, createGame } from '~/server/games'
import { localMinutes, localWeekday, zonedParts } from '~/server/time'
import { localTime, makeCourt, makeLocation, makePlayer, makeUser, resetDb, testDb } from './helpers'

/**
 * Clinics, and the thing they must never be allowed to do: take a court a game
 * is on, or be taken by one.
 */

// Tuesday 6:00-7:00 PM Santa Fe.
const TUESDAY = localTime(2026, 9, 15, 18, 0)
const WEEKDAY = localWeekday(TUESDAY)

let locationId: string
let courtId: string
let organizerId: string

beforeEach(async () => {
  await resetDb()
  locationId = await makeLocation('Alto Park')
  courtId = await makeCourt(locationId)
  organizerId = await makeUser({ name: 'Coach', organizerStatus: 'approved' })
})

function baseClinic(overrides: Partial<CreateClinicInput> = {}): CreateClinicInput {
  return {
    organizerId,
    locationId,
    courtId,
    title: 'Cardio Tennis',
    descriptionMd: 'An hour of drills.',
    costNote: '$15 drop-in',
    heroKey: null,
    heroWidth: null,
    heroHeight: null,
    capacity: 8,
    recurrence: {
      weekdays: [WEEKDAY],
      startMinute: 18 * 60,
      endMinute: 19 * 60,
      from: TUESDAY,
      until: TUESDAY + 21 * 24 * 60 * 60_000,
    },
    ...overrides,
  }
}

async function published(overrides: Partial<CreateClinicInput> = {}) {
  const result = await createClinic(baseClinic(overrides))
  if (!result.ok) throw new Error(`create failed: ${result.conflicts.join(', ')}`)
  await testDb().update(clinics).set({ status: 'published' }).where(eq(clinics.id, result.clinic.id))

  const occurrences = await testDb()
    .select()
    .from(clinicOccurrences)
    .where(eq(clinicOccurrences.clinicId, result.clinic.id))
  return { clinic: result.clinic, occurrences: occurrences.sort((a, b) => a.startsAt - b.startsAt) }
}

describe('expanding a recurrence', () => {
  it('produces one date per matching weekday in the range', () => {
    const dates = generateOccurrences({
      weekdays: [WEEKDAY],
      startMinute: 18 * 60,
      endMinute: 19 * 60,
      from: TUESDAY,
      until: TUESDAY + 21 * 24 * 60 * 60_000,
    })
    expect(dates).toHaveLength(4)
  })

  it('handles more than one day a week', () => {
    const dates = generateOccurrences({
      weekdays: [WEEKDAY, (WEEKDAY + 2) % 7],
      startMinute: 18 * 60,
      endMinute: 19 * 60,
      from: TUESDAY,
      until: TUESDAY + 13 * 24 * 60 * 60_000,
    })
    expect(dates).toHaveLength(4)
  })

  /**
   * The reason the recurrence is stored as wall-clock rather than as an
   * instant. Stepping by a fixed 86,400,000 ms would put every date after the
   * change an hour out — the same failure `test/time.test.ts` pins for games.
   */
  it('keeps a 6pm clinic at 6pm across the November clock change', () => {
    // 2026-11-01 is the US fall-back, so this range straddles it.
    const start = localTime(2026, 10, 20, 18, 0)
    const dates = generateOccurrences({
      weekdays: [localWeekday(start)],
      startMinute: 18 * 60,
      endMinute: 19 * 60,
      from: start,
      until: start + 28 * 24 * 60 * 60_000,
    })

    expect(dates.length).toBeGreaterThan(2)
    for (const date of dates) {
      expect(localMinutes(date.startsAt)).toBe(18 * 60)
      expect(localMinutes(date.endsAt)).toBe(19 * 60)
    }
    // And they really are on both sides of the change: one is 25 hours after
    // the previous local midnight in UTC terms.
    const spans = dates.slice(1).map((d, i) => d.startsAt - dates[i]!.startsAt)
    expect(new Set(spans).size).toBe(2)
  })

  it('is capped, so one batch can never be unbounded', () => {
    const dates = generateOccurrences({
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      startMinute: 18 * 60,
      endMinute: 19 * 60,
      from: TUESDAY,
      until: TUESDAY + 365 * 24 * 60 * 60_000,
    })
    expect(dates).toHaveLength(26)
  })
})

describe('creating a clinic', () => {
  it('holds its court from the moment it is created, unlike a game', async () => {
    const { occurrences } = await published()

    const locks = await testDb().select().from(courtSlotLocks)
    // Four Tuesdays, two 30-minute granules each.
    expect(locks).toHaveLength(8)
    expect(locks.every((l) => l.gameId === null)).toBe(true)
    expect(new Set(locks.map((l) => l.clinicOccurrenceId))).toEqual(
      new Set(occurrences.map((o) => o.id)),
    )
  })

  it('refuses times that are not on the half hour', async () => {
    await expect(
      createClinic(baseClinic({ recurrence: { ...baseClinic().recurrence, startMinute: 18 * 60 + 10 } })),
    ).rejects.toThrow(ClinicValidationError)
  })

  it('refuses a range that contains none of the chosen days', async () => {
    await expect(
      createClinic(
        baseClinic({
          recurrence: { ...baseClinic().recurrence, weekdays: [(WEEKDAY + 1) % 7], until: TUESDAY },
        }),
      ),
    ).rejects.toThrow(ClinicValidationError)
  })

  it('creates nothing at all when one date of the series clashes', async () => {
    await published()

    // A second series wanting the same court on the same Tuesdays.
    const second = await createClinic(baseClinic({ title: 'Drills' }))
    expect(second.ok).toBe(false)
    if (second.ok) throw new Error('unreachable')

    expect(second.conflicts).toHaveLength(4)
    // The whole thing rolled back — no half-created series left behind.
    expect(await testDb().select().from(clinics)).toHaveLength(1)
  })

  it('names the dates that clashed, so the organizer can move them', async () => {
    const { occurrences } = await published()

    const second = await createClinic(baseClinic({ title: 'Drills' }))
    if (second.ok) throw new Error('expected a conflict')
    expect(second.conflicts.sort()).toEqual(occurrences.map((o) => o.startsAt).sort())
  })

  it('offers only courts free for every date of the series', async () => {
    const other = await makeCourt(locationId, 'Court 2')
    await published()

    const free = await courtsFreeForSeries(locationId, baseClinic().recurrence)
    expect(free).toEqual([other])
  })
})

/**
 * The tests this whole feature turns on. Games and clinics compete for the
 * same public courts, so they are settled by one primary key in one table.
 */
describe('clinics and games competing for a court', () => {
  async function gameOnTheCourt() {
    const hostId = await makeUser({ name: 'Host', ntrp: 3.5 })
    return createGame({
      hostId,
      hostNtrp: 3.5,
      courtIds: [courtId],
      startsAt: TUESDAY,
      endsAt: TUESDAY + 60 * 60_000,
      format: 'singles',
      slots: [{ kind: 'seeker', seekerNtrp: 3.5 }],
    })
  }

  it('will not let a clinic take a court a game already holds', async () => {
    const game = await gameOnTheCourt()
    // A game only takes its court when it fills.
    const player = await makePlayer({ name: 'Ann' })
    await claimAnyOpenSlot(game.id, player)

    const result = await createClinic(baseClinic())
    expect(result.ok).toBe(false)
  })

  it('leaves a filling game unplaceable when a clinic already holds its only court', async () => {
    await published()

    const game = await gameOnTheCourt()
    const player = await makePlayer({ name: 'Ann' })
    const claimed = await claimAnyOpenSlot(game.id, player)

    // The court was gone before the last seat went, which is exactly the
    // `unplaceable` case — the players are real, the venue isn't.
    expect(claimed.game.status).toBe('unplaceable')
    expect(claimed.game.courtId).toBeNull()
  })

  it('frees the court for a game once the clinic date is cancelled', async () => {
    const { occurrences } = await published()
    await cancelOccurrence(occurrences[0]!.id)

    const game = await gameOnTheCourt()
    const player = await makePlayer({ name: 'Ann' })
    const claimed = await claimAnyOpenSlot(game.id, player)

    expect(claimed.game.status).toBe('full')
    expect(claimed.game.courtId).toBe(courtId)
  })
})

describe('signing up', () => {
  it('takes a place and holds the player for that hour', async () => {
    const { occurrences } = await published()
    const player = await makeUser({ name: 'Ann' })

    await signUpForClinic(occurrences[0]!.id, player)

    expect(await testDb().select().from(clinicSignups)).toHaveLength(1)
    const locks = await testDb()
      .select()
      .from(playerSlotLocks)
      .where(eq(playerSlotLocks.userId, player))
    expect(locks).toHaveLength(2)
    expect(locks.every((l) => l.gameId === null)).toBe(true)
  })

  it('lets exactly one player take the last place when two race for it', async () => {
    const { occurrences } = await published({ capacity: 1 })
    const a = await makeUser({ name: 'Ann' })
    const b = await makeUser({ name: 'Ben' })

    const results = await Promise.allSettled([
      signUpForClinic(occurrences[0]!.id, a),
      signUpForClinic(occurrences[0]!.id, b),
    ])

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(await testDb().select().from(clinicSignups)).toHaveLength(1)
  })

  it('leaves no player locks behind for whoever lost the race', async () => {
    const { occurrences } = await published({ capacity: 1 })
    const a = await makeUser({ name: 'Ann' })
    const b = await makeUser({ name: 'Ben' })

    await Promise.allSettled([
      signUpForClinic(occurrences[0]!.id, a),
      signUpForClinic(occurrences[0]!.id, b),
    ])

    // The guarded insert only reports zero rows after the batch has already
    // committed the locks, so the losing path has to clean them up. Without
    // that, the loser is blocked from an hour they are entirely free for.
    expect(await testDb().select().from(playerSlotLocks)).toHaveLength(2)
  })

  it('refuses once the session is full', async () => {
    const { occurrences } = await published({ capacity: 1 })
    await signUpForClinic(occurrences[0]!.id, await makeUser({ name: 'Ann' }))

    await expect(
      signUpForClinic(occurrences[0]!.id, await makeUser({ name: 'Ben' })),
    ).rejects.toThrow(ClinicFullError)
  })

  it('refuses a player already in a game at that hour', async () => {
    const { occurrences } = await published()
    const otherCourt = await makeCourt(locationId, 'Court 2')

    const hostId = await makeUser({ name: 'Host', ntrp: 3.5 })
    const game = await createGame({
      hostId,
      hostNtrp: 3.5,
      courtIds: [otherCourt],
      startsAt: TUESDAY,
      endsAt: TUESDAY + 60 * 60_000,
      format: 'singles',
      slots: [{ kind: 'seeker', seekerNtrp: 3.5 }],
    })
    const player = await makePlayer({ name: 'Ann' })
    await claimAnyOpenSlot(game.id, player)

    await expect(signUpForClinic(occurrences[0]!.id, player.id)).rejects.toThrow(PlayerBusyError)
  })

  it('refuses a game seat to a player already in a clinic at that hour', async () => {
    const { occurrences } = await published()
    const otherCourt = await makeCourt(locationId, 'Court 2')
    const player = await makePlayer({ name: 'Ann' })
    await signUpForClinic(occurrences[0]!.id, player.id)

    const hostId = await makeUser({ name: 'Host', ntrp: 3.5 })
    const game = await createGame({
      hostId,
      hostNtrp: 3.5,
      courtIds: [otherCourt],
      startsAt: TUESDAY,
      endsAt: TUESDAY + 60 * 60_000,
      format: 'singles',
      slots: [{ kind: 'seeker', seekerNtrp: 3.5 }],
    })

    await expect(claimAnyOpenSlot(game.id, player)).rejects.toThrow()
  })

  it('lets a player sign up for a later date they are free for', async () => {
    const { occurrences } = await published()
    const player = await makeUser({ name: 'Ann' })

    await signUpForClinic(occurrences[0]!.id, player)
    await signUpForClinic(occurrences[1]!.id, player)

    expect(await testDb().select().from(clinicSignups)).toHaveLength(2)
  })
})

describe('withdrawing and cancelling', () => {
  it('releases the player locks on withdrawal', async () => {
    const { occurrences } = await published()
    const player = await makeUser({ name: 'Ann' })
    await signUpForClinic(occurrences[0]!.id, player)

    await withdrawFromClinic(occurrences[0]!.id, player)

    expect(await testDb().select().from(clinicSignups)).toHaveLength(0)
    expect(await testDb().select().from(playerSlotLocks)).toHaveLength(0)
  })

  it('frees the place for somebody else', async () => {
    const { occurrences } = await published({ capacity: 1 })
    const a = await makeUser({ name: 'Ann' })
    const b = await makeUser({ name: 'Ben' })

    await signUpForClinic(occurrences[0]!.id, a)
    await withdrawFromClinic(occurrences[0]!.id, a)
    await signUpForClinic(occurrences[0]!.id, b)

    expect(await testDb().select().from(clinicSignups)).toHaveLength(1)
  })

  it('releases both the court and every attendee on a cancelled date', async () => {
    const { occurrences } = await published()
    await signUpForClinic(occurrences[0]!.id, await makeUser({ name: 'Ann' }))
    await signUpForClinic(occurrences[0]!.id, await makeUser({ name: 'Ben' }))

    await cancelOccurrence(occurrences[0]!.id)

    expect(await testDb().select().from(playerSlotLocks)).toHaveLength(0)
    const locks = await testDb()
      .select()
      .from(courtSlotLocks)
      .where(eq(courtSlotLocks.clinicOccurrenceId, occurrences[0]!.id))
    expect(locks).toHaveLength(0)
    // The other three dates are untouched.
    expect(await testDb().select().from(courtSlotLocks)).toHaveLength(6)
  })

  it('advances the calendar sequence so the invite can be withdrawn', async () => {
    const { occurrences } = await published()
    await cancelOccurrence(occurrences[0]!.id)

    const after = await testDb()
      .select()
      .from(clinicOccurrences)
      .where(eq(clinicOccurrences.id, occurrences[0]!.id))
    expect(after[0]!.calendarSeq).toBe(1)
  })

  it('cancelling the series releases every upcoming date', async () => {
    await published()
    const [clinic] = await testDb().select().from(clinics)

    await cancelClinic(clinic!.id, 'Coach is unwell.')

    expect(await testDb().select().from(courtSlotLocks)).toHaveLength(0)
    const after = await testDb().select().from(clinics)
    expect(after[0]!.status).toBe('cancelled')
  })
})

describe('reading a clinic back', () => {
  it('reports how many places have gone on each date', async () => {
    const { clinic, occurrences } = await published()
    const player = await makeUser({ name: 'Ann' })
    await signUpForClinic(occurrences[0]!.id, player)

    const detail = await getClinic(clinic.id, player)
    expect(detail?.occurrences[0]?.taken).toBe(1)
    expect(detail?.occurrences[0]?.viewerSignedUp).toBe(true)
    expect(detail?.occurrences[1]?.viewerSignedUp).toBe(false)
  })

  it('says nothing about a viewer who is signed out', async () => {
    const { clinic, occurrences } = await published()
    await signUpForClinic(occurrences[0]!.id, await makeUser({ name: 'Ann' }))

    const detail = await getClinic(clinic.id)
    expect(detail?.occurrences[0]?.taken).toBe(1)
    expect(detail?.occurrences[0]?.viewerSignedUp).toBe(false)
  })
})
