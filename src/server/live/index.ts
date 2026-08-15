import { env } from 'cloudflare:workers'
import type { InboxEntry, InboxEntryInput, PlayerInbox } from './playerInbox'

export type { InboxEntry, InboxEntryInput }
export { PlayerInbox } from './playerInbox'

/**
 * Talking to a player's inbox.
 *
 * The binding is absent in the unit-test worker, so every function here
 * degrades to a no-op rather than throwing. An inbox entry is a convenience —
 * the email still goes out and D1 still holds the truth — so failing to
 * deliver one must never take down the request that produced it.
 */

type InboxStub = DurableObjectStub<PlayerInbox>

function inboxFor(userId: string): InboxStub | null {
  const ns = (env as Partial<Env>).PLAYER_INBOX
  if (!ns) return null
  // Addressed by player id, which is also why the Durable Object never has to
  // trust a client-supplied identity.
  return ns.getByName(userId) as InboxStub
}

/**
 * Add an entry to a player's inbox.
 *
 * Call this *after* the D1 write it describes. A Durable Object is never
 * authoritative for a game — if this fails, the game still happened.
 */
export async function pushToInbox(
  userId: string,
  entry: InboxEntryInput,
): Promise<InboxEntry | null> {
  const inbox = inboxFor(userId)
  if (!inbox) return null
  try {
    return await inbox.push(entry)
  } catch (error) {
    console.error('inbox push failed for', userId, error)
    return null
  }
}

/** Push to several players. One failure never stops the rest. */
export async function pushToInboxes(
  userIds: string[],
  entry: (userId: string) => InboxEntryInput,
): Promise<void> {
  await Promise.all(userIds.map((userId) => pushToInbox(userId, entry(userId))))
}

export async function readInbox(
  userId: string,
  limit = 30,
): Promise<{ entries: InboxEntry[]; unread: number }> {
  const inbox = inboxFor(userId)
  if (!inbox) return { entries: [], unread: 0 }
  try {
    return await inbox.list(limit)
  } catch (error) {
    console.error('inbox read failed for', userId, error)
    return { entries: [], unread: 0 }
  }
}

export async function markInboxRead(userId: string, ids?: number[]): Promise<{ unread: number }> {
  const inbox = inboxFor(userId)
  if (!inbox) return { unread: 0 }
  try {
    return await inbox.markRead(ids)
  } catch (error) {
    console.error('inbox mark-read failed for', userId, error)
    return { unread: 0 }
  }
}

/**
 * Forward an authenticated WebSocket upgrade to a player's inbox.
 *
 * The Worker resolves the session first; a client never names its own id.
 */
export async function connectToInbox(userId: string, request: Request): Promise<Response> {
  const inbox = inboxFor(userId)
  if (!inbox) return new Response('Realtime is not configured', { status: 503 })
  return inbox.fetch(request)
}
