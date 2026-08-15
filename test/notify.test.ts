import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { availabilityRules, notifications } from '~/db/schema'
import { cancelGame, claimAnyOpenSlot, createGame } from '~/server/games'
import { notifyCandidatesForGame } from '~/server/matching'
import { resolveMailProvider } from '~/server/notify'
import { handleNotifyMessage } from '~/server/notify/queue'
import { DAY, localWeekday } from '~/server/time'
import { newId } from '~/server/tokens'
import {
  localTime,
  makeCourt,
  makeLocation,
  makePlayer,
  makeUser,
  resetDb,
  testDb,
} from './helpers'

/**
 * The queue split: the request path writes rows and enqueues, the consumer
 * renders and sends. These tests cover both halves and, most importantly, the
 * seam between them — the window in which the world can change underneath a
 * message that is already in flight.
 *
 * There is no queue binding in the unit-test worker, so `enqueueNotifications`
 * takes its inline fallback and delivery is observable through the console
 * adapter. That's the same `handleNotifyMessage` the real consumer calls.
 */

const START = localTime(2026, 9, 15, 17, 0) // Tuesday 5:00 PM
const END = START + 90 * 60_000
const WEEKDAY = localWeekday(START)

let courtId: string
let hostId: string
let sent: string[]

beforeEach(async () => {
  await resetDb()
  courtId = await makeCourt(await makeLocation())
  hostId = await makeUser({ name: 'Host', ntrp: 3.5, email: 'host@example.test' })

  sent = []
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    sent.push(args.map(String).join(' '))
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

/** Subject lines of everything the console adapter actually delivered. */
function delivered(): string[] {
  return sent
    .flatMap((entry) => entry.split('\n'))
    .filter((line) => line.startsWith('│ ') && !line.includes('EMAIL →'))
    .map((line) => line.slice(2))
}

function deliveredTo(): string[] {
  return sent
    .flatMap((entry) => entry.split('\n'))
    .filter((line) => line.includes('EMAIL →'))
    .map((line) => line.split('EMAIL → ')[1]!)
}

async function availablePlayer(name: string, email: string) {
  const id = await makeUser({ name, email, ntrp: 3.5 })
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
  return id
}

async function makeGame() {
  return createGame({
    hostId,
    hostNtrp: 3.5,
    courtIds: [courtId],
    startsAt: START,
    endsAt: END,
    format: 'singles',
    slots: [{ kind: 'seeker', seekerNtrp: 3.5 }],
  })
}

describe('choosing a mail adapter', () => {
  it('degrades to the log in development when there is no token', () => {
    // The case that matters: a fresh clone, production config pointed at
    // Resend, and the developer still needs to read a magic link.
    expect(resolveMailProvider('resend', false, true)).toBe('console')
  })

  it('sends for real in development once a token is present', () => {
    expect(resolveMailProvider('resend', true, true)).toBe('resend')
  })

  it('does not degrade in production, however broken the config', () => {
    // A missing token here is a loud failure on the notification row, not a
    // pile of real invitations written to a log nobody reads.
    expect(resolveMailProvider('resend', false, false)).toBe('resend')
  })

  it('leaves an explicit console setting alone', () => {
    expect(resolveMailProvider('console', true, false)).toBe('console')
  })
})

describe('inviting candidates', () => {
  it('writes a notification row per candidate and reports what it invited', async () => {
    await availablePlayer('One', 'one@example.test')
    await availablePlayer('Two', 'two@example.test')
    const game = await makeGame()

    const result = await notifyCandidatesForGame(game.id)
    expect(result).toEqual({ candidates: 2, invited: 2 })

    const rows = await testDb()
      .select()
      .from(notifications)
      .where(eq(notifications.gameId, game.id))
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.status === 'sent')).toBe(true)
    // Every invitation carries its own single-use token.
    expect(new Set(rows.map((r) => r.claimToken)).size).toBe(2)
  })

  it('does not invite the same player twice when two fan-outs race', async () => {
    await availablePlayer('One', 'one@example.test')
    const game = await makeGame()

    const first = await notifyCandidatesForGame(game.id)
    const second = await notifyCandidatesForGame(game.id)

    expect(first.invited).toBe(1)
    // The unique (user_id, game_id) index, not application logic, is what
    // makes the second pass a no-op.
    expect(second.invited).toBe(0)
    const rows = await testDb()
      .select()
      .from(notifications)
      .where(eq(notifications.gameId, game.id))
    expect(rows).toHaveLength(1)
  })

  it('invites nobody for a game that is no longer open', async () => {
    await availablePlayer('One', 'one@example.test')
    const game = await makeGame()
    await cancelGame(game.id, hostId, false)

    expect(await notifyCandidatesForGame(game.id)).toEqual({ candidates: 0, invited: 0 })
  })
})

describe('the consumer, against state as it is now', () => {
  it('renders a seeker alert with the claim link from the notification row', async () => {
    const player = await availablePlayer('One', 'one@example.test')
    const game = await makeGame()
    await notifyCandidatesForGame(game.id)

    const row = (
      await testDb().select().from(notifications).where(eq(notifications.userId, player))
    )[0]!

    sent = []
    await handleNotifyMessage({ kind: 'seeker-alert', gameId: game.id, userId: player })

    expect(deliveredTo()).toEqual(['one@example.test'])
    expect(delivered().join('\n')).toContain(`/claim/${row.claimToken}`)
  })

  it('stays silent when the game was cancelled between enqueue and delivery', async () => {
    const player = await availablePlayer('One', 'one@example.test')
    const game = await makeGame()
    await notifyCandidatesForGame(game.id)

    // The message is already in the queue. Now the host calls the game off.
    await cancelGame(game.id, hostId, false)

    sent = []
    await handleNotifyMessage({ kind: 'seeker-alert', gameId: game.id, userId: player })
    await handleNotifyMessage({ kind: 'reminder', gameId: game.id, userId: player })
    await handleNotifyMessage({ kind: 'spot-confirmed', gameId: game.id, userId: player })

    // Nothing cheerful about a game that isn't happening.
    expect(deliveredTo()).toEqual([])
  })

  it('still delivers the cancellation itself for a cancelled game', async () => {
    const player = await availablePlayer('One', 'one@example.test')
    const game = await makeGame()
    await cancelGame(game.id, hostId, false)

    sent = []
    await handleNotifyMessage({
      kind: 'game-cancelled',
      gameId: game.id,
      userId: player,
      reason: 'Rain.',
    })

    expect(deliveredTo()).toEqual(['one@example.test'])
    expect(delivered().join('\n')).toContain('Rain.')
  })

  it('nudges a host whose game is still short', async () => {
    const game = await makeGame()

    sent = []
    await handleNotifyMessage({ kind: 'host-nudge', gameId: game.id, userId: hostId })
    expect(deliveredTo()).toEqual(['host@example.test'])
    expect(delivered().join('\n')).toContain('1 open spot')
  })

  it('drops a host nudge whose game filled up while it waited', async () => {
    const game = await makeGame()

    // The seat goes to someone between the nudge being enqueued and delivered,
    // so by send time there is nothing left to nudge about.
    await claimAnyOpenSlot(game.id, await makePlayer({ name: 'Filler', ntrp: 3.5 }))

    sent = []
    await handleNotifyMessage({ kind: 'host-nudge', gameId: game.id, userId: hostId })
    expect(deliveredTo()).toEqual([])
  })

  it('tells the host when their full game has nowhere to play', async () => {
    // Somebody else takes the only court while this game is filling.
    const rivalHost = await makeUser({ name: 'Rival', ntrp: 3.5, email: 'rival@example.test' })
    const rival = await createGame({
      hostId: rivalHost,
      hostNtrp: 3.5,
      courtIds: [courtId],
      startsAt: START,
      endsAt: END,
      format: 'singles',
      slots: [{ kind: 'seeker', seekerNtrp: 3.5 }],
    })
    await claimAnyOpenSlot(rival.id, await makePlayer({ name: 'Rival filler', ntrp: 3.5 }))

    const game = await makeGame()
    await claimAnyOpenSlot(game.id, await makePlayer({ name: 'Filler', ntrp: 3.5 }))

    sent = []
    await handleNotifyMessage({ kind: 'unplaceable', gameId: game.id, userId: hostId })

    expect(deliveredTo()).toEqual(['host@example.test'])
    const body = delivered().join('\n')
    // Not a cancellation: the game still has its players.
    expect(body).toContain('Everyone you needed has signed up')
    expect(body).not.toContain('cancelled')
  })

  it('says nothing if the host has already moved an unplaceable game', async () => {
    const game = await makeGame()
    sent = []
    await handleNotifyMessage({ kind: 'unplaceable', gameId: game.id, userId: hostId })
    expect(deliveredTo()).toEqual([])
  })

  it('returns quietly for a player who no longer exists', async () => {
    const game = await makeGame()
    await expect(
      handleNotifyMessage({ kind: 'reminder', gameId: game.id, userId: 'nobody' }),
    ).resolves.toBeUndefined()
    expect(deliveredTo()).toEqual([])
  })
})

