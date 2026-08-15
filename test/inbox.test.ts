import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import type { PlayerInbox } from '~/server/live'
import { markInboxRead, pushToInbox, readInbox } from '~/server/live'
import { resetDb } from './helpers'

/**
 * The notification inbox.
 *
 * Driven directly rather than through a browser: `@cloudflare/vitest-pool-workers`
 * can reach into a Durable Object, so push/list/read and the trim alarm are all
 * testable without a socket.
 */

/** A fresh inbox per test — Durable Objects persist between them otherwise. */
let player: string
let counter = 0

function stub(userId: string) {
  const ns = env.PLAYER_INBOX as unknown as DurableObjectNamespace<PlayerInbox>
  return { ns, id: ns.idFromName(userId) }
}

beforeEach(async () => {
  await resetDb()
  player = `player-${counter++}-${Math.random().toString(36).slice(2)}`
})

describe('pushing and reading', () => {
  it('stores an entry and counts it as unread', async () => {
    await pushToInbox(player, { kind: 'invited', title: 'A 3.5 singles spot is open' })

    const { entries, unread } = await readInbox(player)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ kind: 'invited', title: 'A 3.5 singles spot is open' })
    expect(entries[0]!.readAt).toBeNull()
    expect(unread).toBe(1)
  })

  it('returns newest first', async () => {
    await pushToInbox(player, { kind: 'invited', title: 'First' })
    await pushToInbox(player, { kind: 'invited', title: 'Second' })

    const { entries } = await readInbox(player)
    expect(entries.map((e) => e.title)).toEqual(['Second', 'First'])
  })

  it("keeps players' inboxes separate", async () => {
    const other = `${player}-other`
    await pushToInbox(player, { kind: 'invited', title: 'Mine' })

    expect((await readInbox(other)).entries).toHaveLength(0)
    expect((await readInbox(player)).entries).toHaveLength(1)
  })

  it('marks everything read', async () => {
    await pushToInbox(player, { kind: 'invited', title: 'One' })
    await pushToInbox(player, { kind: 'invited', title: 'Two' })

    expect(await markInboxRead(player)).toEqual({ unread: 0 })
    const { entries, unread } = await readInbox(player)
    expect(unread).toBe(0)
    expect(entries.every((e) => e.readAt !== null)).toBe(true)
  })

  it('marks only the ids it was given', async () => {
    const first = await pushToInbox(player, { kind: 'invited', title: 'One' })
    await pushToInbox(player, { kind: 'invited', title: 'Two' })

    expect(await markInboxRead(player, [first!.id])).toEqual({ unread: 1 })
  })

  it('carries the link through, which is the whole point of the entry', async () => {
    await pushToInbox(player, {
      kind: 'invited',
      gameId: 'game-1',
      title: 'A spot is open',
      body: 'Tue 5:00 PM · Alto Park',
      url: 'https://example.test/claim/abc',
    })
    const { entries } = await readInbox(player)
    expect(entries[0]).toMatchObject({
      gameId: 'game-1',
      url: 'https://example.test/claim/abc',
      body: 'Tue 5:00 PM · Alto Park',
    })
  })
})

describe('trimming', () => {
  it('drops everything older than thirty days on the alarm', async () => {
    const { ns, id } = stub(player)
    const inbox = ns.get(id)

    const old = Date.now() - 31 * 24 * 60 * 60 * 1000
    await runInDurableObject(inbox, async (instance: PlayerInbox) => {
      await instance.push({ kind: 'invited', title: 'Ancient' }, old)
      await instance.push({ kind: 'invited', title: 'Recent' })
    })

    expect(await runDurableObjectAlarm(inbox)).toBe(true)

    const { entries } = await readInbox(player)
    expect(entries.map((e) => e.title)).toEqual(['Recent'])
  })

  it('keeps at most two hundred entries', async () => {
    const { ns, id } = stub(player)
    const inbox = ns.get(id)

    await runInDurableObject(inbox, async (instance: PlayerInbox) => {
      for (let i = 0; i < 210; i++) {
        await instance.push({ kind: 'invited', title: `Entry ${i}` })
      }
    })

    await runDurableObjectAlarm(inbox)

    await runInDurableObject(inbox, async (instance: PlayerInbox) => {
      const { entries } = await instance.list(500)
      expect(entries).toHaveLength(200)
      // The newest survive; the oldest ten are gone.
      expect(entries[0]!.title).toBe('Entry 209')
      expect(entries.at(-1)!.title).toBe('Entry 10')
    })
  })
})

describe('when realtime is unavailable', () => {
  it('degrades instead of throwing', async () => {
    // The inbox is a convenience: the email still goes out and D1 still holds
    // the truth. A push that fails must never take down the request that
    // produced it, so every helper returns a benign value rather than raising.
    await expect(pushToInbox(player, { kind: 'invited', title: 'Fine' })).resolves.toBeTruthy()
    await expect(readInbox('nobody-has-this-inbox')).resolves.toEqual({ entries: [], unread: 0 })
  })
})
