import { beforeEach, describe, expect, it } from 'vitest'
import { availabilityBlocks, availabilityRules } from '~/db/schema'
import { expandAvailability, userIsAvailable } from '~/server/availability'
import { createGame } from '~/server/games'
import { findCandidates } from '~/server/matching'
import { DAY, HOUR, localMinutes, localWeekday } from '~/server/time'
import { newId } from '~/server/tokens'
import { localTime, makeCourt, makeLocation, makeUser, resetDb, testDb } from './helpers'

const START = localTime(2026, 9, 15, 17, 0) // Tuesday 5:00 PM
const END = START + 90 * 60_000 // 6:30 PM
const WEEKDAY = localWeekday(START)

let courtId: string
let hostId: string

beforeEach(async () => {
  await resetDb()
  courtId = await makeCourt(await makeLocation())
  hostId = await makeUser({ name: 'Host', ntrp: 3.5 })
})

async function addRule(
  userId: string,
  opts: Partial<typeof availabilityRules.$inferInsert> = {},
) {
  await testDb()
    .insert(availabilityRules)
    .values({
      id: newId(),
      userId,
      weekday: WEEKDAY,
      startMinute: 16 * 60,
      endMinute: 20 * 60,
      formatPref: 'either',
      effectiveFrom: START - 30 * DAY,
      effectiveUntil: null,
      isActive: true,
      createdAt: Date.now(),
      ...opts,
    })
}

async function addBlock(
  userId: string,
  opts: Partial<typeof availabilityBlocks.$inferInsert> = {},
) {
  await testDb()
    .insert(availabilityBlocks)
    .values({
      id: newId(),
      userId,
      startsAt: START,
      endsAt: END,
      kind: 'available',
      formatPref: 'either',
      note: null,
      createdAt: Date.now(),
      ...opts,
    })
}

async function makeGame(overrides: Partial<Parameters<typeof createGame>[0]> = {}) {
  return createGame({
    hostId,
    hostNtrp: 3.5,
    courtId,
    startsAt: START,
    endsAt: END,
    format: 'singles',
    slots: [{ kind: 'seeker', seekerNtrp: 3.5 }],
    ...overrides,
  })
}

describe('availability coverage', () => {
  it('matches a recurring rule that spans the whole game', async () => {
    const player = await makeUser({ ntrp: 3.5 })
    await addRule(player)
    expect(await userIsAvailable(player, START, END, 'singles')).toBe(true)
  })

  it('does not match a rule that only partly covers the game', async () => {
    const player = await makeUser({ ntrp: 3.5 })
    await addRule(player, { startMinute: 16 * 60, endMinute: 18 * 60 }) // ends 6:00, game runs to 6:30
    expect(await userIsAvailable(player, START, END, 'singles')).toBe(false)
  })

  it('matches a one-off available block', async () => {
    const player = await makeUser({ ntrp: 3.5 })
    await addBlock(player)
    expect(await userIsAvailable(player, START, END, 'singles')).toBe(true)
  })

  it('lets a busy block override a recurring rule', async () => {
    const player = await makeUser({ ntrp: 3.5 })
    await addRule(player)
    expect(await userIsAvailable(player, START, END, 'singles')).toBe(true)

    // A week away, overlapping the game.
    await addBlock(player, {
      kind: 'busy',
      startsAt: START - DAY,
      endsAt: END + DAY,
      note: 'Out of town',
    })
    expect(await userIsAvailable(player, START, END, 'singles')).toBe(false)
  })

  it('respects a format preference on the rule', async () => {
    const player = await makeUser({ ntrp: 3.5 })
    await addRule(player, { formatPref: 'doubles' })
    expect(await userIsAvailable(player, START, END, 'doubles')).toBe(true)
    expect(await userIsAvailable(player, START, END, 'singles')).toBe(false)
  })

  it('ignores a rule that has not taken effect yet', async () => {
    const player = await makeUser({ ntrp: 3.5 })
    await addRule(player, { effectiveFrom: START + DAY })
    expect(await userIsAvailable(player, START, END, 'singles')).toBe(false)
  })

  it('applies the same weekly rule across a DST boundary', async () => {
    const player = await makeUser({ ntrp: 3.5 })
    // A Tuesday 4-8pm rule, effective from well before either date.
    await addRule(player, { effectiveFrom: localTime(2026, 1, 1, 0, 0) })

    const summerTuesday = localTime(2026, 7, 14, 17, 0)
    const winterTuesday = localTime(2026, 12, 15, 17, 0)
    expect(localWeekday(summerTuesday)).toBe(WEEKDAY)
    expect(localWeekday(winterTuesday)).toBe(WEEKDAY)

    // 5pm local is a different UTC instant in each, but both are covered.
    expect(await userIsAvailable(player, summerTuesday, summerTuesday + 90 * 60_000, 'singles')).toBe(true)
    expect(await userIsAvailable(player, winterTuesday, winterTuesday + 90 * 60_000, 'singles')).toBe(true)
  })
})

describe('finding candidates for a game', () => {
  it('notifies an available, level-matched player', async () => {
    const player = await makeUser({ name: 'Match', ntrp: 3.5 })
    await addRule(player)
    const game = await makeGame()

    const candidates = await findCandidates(game, [3.5])
    expect(candidates.map((c) => c.id)).toEqual([player])
  })

  it('skips a player who never opted into that level', async () => {
    const tooStrong = await makeUser({ name: 'Pro', ntrp: 5.0 })
    await addRule(tooStrong)
    const game = await makeGame()
    expect(await findCandidates(game, [3.5])).toHaveLength(0)
  })

  it('reaches players who opted into the level from either direction', async () => {
    // A 3.0 willing to play up and a 4.0 willing to play down both hear about
    // a 3.5 game. Their own rating is irrelevant — the opt-in is what counts.
    await addRule(await makeUser({ name: 'Plays up', ntrp: 3.0, playLevels: [3.0, 3.5] }))
    await addRule(await makeUser({ name: 'Plays down', ntrp: 4.0, playLevels: [3.5, 4.0] }))
    const game = await makeGame()
    expect(await findCandidates(game, [3.5])).toHaveLength(2)
  })

  it('does not stretch a player who kept to their own level', async () => {
    // Same ratings as above, but neither opted into 3.5, so neither is asked.
    await addRule(await makeUser({ name: 'Strict 3.0', ntrp: 3.0, playLevels: [3.0] }))
    await addRule(await makeUser({ name: 'Strict 4.0', ntrp: 4.0, playLevels: [4.0] }))
    const game = await makeGame()
    expect(await findCandidates(game, [3.5])).toHaveLength(0)
  })

  it('matches a doubles game asking for several levels at once', async () => {
    const three = await makeUser({ name: 'Three', ntrp: 3.0, playLevels: [3.0] })
    const four = await makeUser({ name: 'Four', ntrp: 4.0, playLevels: [4.0] })
    const five = await makeUser({ name: 'Five', ntrp: 5.0, playLevels: [5.0] })
    for (const id of [three, four, five]) await addRule(id)

    const game = await makeGame({
      format: 'doubles',
      slots: [
        { kind: 'seeker', seekerNtrp: 3.0 },
        { kind: 'seeker', seekerNtrp: 4.0 },
        { kind: 'seeker', seekerNtrp: 4.0 },
      ],
    })
    const found = await findCandidates(game, [3.0, 4.0])
    expect(found.map((c) => c.id).sort()).toEqual([three, four].sort())
  })

  it('skips players who do not play the format', async () => {
    const doublesOnly = await makeUser({ ntrp: 3.5, playsSingles: false })
    await addRule(doublesOnly)
    const game = await makeGame()
    expect(await findCandidates(game, [3.5])).toHaveLength(0)
  })

  it('skips players with no availability posted', async () => {
    await makeUser({ name: 'Silent', ntrp: 3.5 })
    const game = await makeGame()
    expect(await findCandidates(game, [3.5])).toHaveLength(0)
  })

  it('skips players who turned every channel off', async () => {
    const unreachable = await makeUser({ ntrp: 3.5, notifyEmail: false, notifySms: false })
    await addRule(unreachable)
    const game = await makeGame()
    expect(await findCandidates(game, [3.5])).toHaveLength(0)
  })

  it('skips the host', async () => {
    await addRule(hostId)
    const game = await makeGame()
    expect(await findCandidates(game, [3.5])).toHaveLength(0)
  })

  it('skips a player already booked in an overlapping game', async () => {
    const player = await makeUser({ name: 'Busy', ntrp: 3.5 })
    await addRule(player)

    // Same time, different court, and they're already the host there.
    const otherCourt = await makeCourt(await makeLocation('Elsewhere'))
    await createGame({
      hostId: player,
      hostNtrp: 3.5,
      courtId: otherCourt,
      startsAt: START,
      endsAt: END,
      format: 'singles',
      slots: [{ kind: 'seeker', seekerNtrp: 3.5 }],
    })

    const game = await makeGame()
    expect(await findCandidates(game, [3.5])).toHaveLength(0)
  })

  it('still notifies a player whose other game is at a different time', async () => {
    const player = await makeUser({ name: 'Free later', ntrp: 3.5 })
    await addRule(player)

    const otherCourt = await makeCourt(await makeLocation('Elsewhere'))
    await createGame({
      hostId: player,
      hostNtrp: 3.5,
      courtId: otherCourt,
      startsAt: START + 4 * HOUR,
      endsAt: END + 4 * HOUR,
      format: 'singles',
      slots: [{ kind: 'seeker', seekerNtrp: 3.5 }],
    })

    const game = await makeGame()
    expect(await findCandidates(game, [3.5])).toHaveLength(1)
  })
})

describe('mixed doubles matching', () => {
  it('only reaches players who opted into mixed', async () => {
    const keen = await makeUser({ name: 'Keen', ntrp: 3.5, gender: 'woman', playsMixed: true })
    const notKeen = await makeUser({ name: 'Not', ntrp: 3.5, gender: 'woman', playsMixed: false })
    for (const id of [keen, notKeen]) await addRule(id)

    const game = await makeGame({
      format: 'doubles',
      isMixed: true,
      hostGender: 'man',
      slots: [
        { kind: 'seeker', seekerNtrp: 3.5, seekerGender: 'woman' },
        { kind: 'seeker', seekerNtrp: 3.5, seekerGender: 'woman' },
        { kind: 'seeker', seekerNtrp: 3.5, seekerGender: 'man' },
      ],
    })
    const found = await findCandidates(game, [3.5], ['woman', 'man'])
    expect(found.map((c) => c.id)).toEqual([keen])
  })

  it('only reaches the genders the open seats are held for', async () => {
    const woman = await makeUser({ name: 'W', ntrp: 3.5, gender: 'woman' })
    const man = await makeUser({ name: 'M', ntrp: 3.5, gender: 'man' })
    const unstated = await makeUser({ name: 'U', ntrp: 3.5, gender: 'unspecified' })
    for (const id of [woman, man, unstated]) await addRule(id)

    const game = await makeGame({
      format: 'doubles',
      isMixed: true,
      hostGender: 'man',
      slots: [
        { kind: 'seeker', seekerNtrp: 3.5, seekerGender: 'woman' },
        { kind: 'seeker', seekerNtrp: 3.5, seekerGender: 'woman' },
        { kind: 'seeker', seekerNtrp: 3.5, seekerGender: 'woman' },
      ],
    })
    // Only the two women's seats are open, so the man and the player who
    // hasn't said are both left alone.
    const found = await findCandidates(game, [3.5], ['woman'])
    expect(found.map((c) => c.id)).toEqual([woman])
  })

  it('leaves ordinary doubles open to everyone regardless of gender', async () => {
    const woman = await makeUser({ name: 'W', ntrp: 3.5, gender: 'woman' })
    const unstated = await makeUser({ name: 'U', ntrp: 3.5, gender: 'unspecified', playsMixed: false })
    for (const id of [woman, unstated]) await addRule(id)

    const game = await makeGame({
      format: 'doubles',
      slots: [
        { kind: 'seeker', seekerNtrp: 3.5 },
        { kind: 'seeker', seekerNtrp: 3.5 },
        { kind: 'seeker', seekerNtrp: 3.5 },
      ],
    })
    expect(await findCandidates(game, [3.5])).toHaveLength(2)
  })
})

describe('expanding availability for the calendar', () => {
  it('turns a weekly rule into one window per matching day', () => {
    const rule = {
      id: 'r1',
      userId: 'u1',
      weekday: WEEKDAY,
      startMinute: 17 * 60,
      endMinute: 19 * 60,
      formatPref: 'either' as const,
      effectiveFrom: START - 30 * DAY,
      effectiveUntil: null,
      isActive: true,
      createdAt: 0,
    }
    const windows = expandAvailability([rule], [], START - 3 * DAY, START + 11 * DAY)
    expect(windows).toHaveLength(2) // two Tuesdays in a 14-day span
    expect(windows.every((w) => localMinutes(w.startsAt) === 17 * 60)).toBe(true)
  })

  it('splits a window around a busy block in the middle of it', () => {
    const block = {
      id: 'b1',
      userId: 'u1',
      startsAt: START,
      endsAt: START + 4 * HOUR,
      kind: 'available' as const,
      formatPref: 'either' as const,
      note: null,
      createdAt: 0,
    }
    const busy = {
      ...block,
      id: 'b2',
      kind: 'busy' as const,
      startsAt: START + HOUR,
      endsAt: START + 2 * HOUR,
    }

    const windows = expandAvailability([], [block, busy], START - DAY, START + DAY)
    expect(windows).toHaveLength(2)
    expect(windows[0]).toMatchObject({ startsAt: START, endsAt: START + HOUR })
    expect(windows[1]).toMatchObject({ startsAt: START + 2 * HOUR, endsAt: START + 4 * HOUR })
  })
})
