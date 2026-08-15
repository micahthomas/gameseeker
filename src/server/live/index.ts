import { env } from 'cloudflare:workers'
import { eq } from 'drizzle-orm'
import { db } from '~/db/client'
import { courts, games } from '~/db/schema'
import type { LiveEvent, LocationHub } from './locationHub'
import type { InboxEntry, InboxEntryInput, PlayerInbox } from './playerInbox'

export type { InboxEntry, InboxEntryInput }
export type { LiveEvent } from './locationHub'
export { PlayerInbox } from './playerInbox'
export { LocationHub } from './locationHub'

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


// --- Location hubs ----------------------------------------------------------

type HubStub = DurableObjectStub<LocationHub>

function hubFor(locationId: string): HubStub | null {
  const ns = (env as Partial<Env>).LOCATION_HUB
  if (!ns) return null
  return ns.getByName(locationId) as HubStub
}

/**
 * Tell everyone watching a location's calendar that a game moved.
 *
 * Call after the D1 write, never instead of it. A dropped broadcast costs a
 * viewer a stale screen until their next refetch; a missing row costs a game.
 */
export async function broadcastToLocation(locationId: string, event: LiveEvent): Promise<void> {
  const hub = hubFor(locationId)
  if (!hub) return
  try {
    await hub.broadcast(event)
  } catch (error) {
    console.error('location broadcast failed for', locationId, error)
  }
}

/** Forward an authenticated upgrade to a location's hub. */
export async function connectToLocation(locationId: string, request: Request): Promise<Response> {
  const hub = hubFor(locationId)
  if (!hub) return new Response('Realtime is not configured', { status: 503 })
  return hub.fetch(request)
}


/**
 * Announce that a game changed to whoever is watching its location.
 *
 * Resolves the location through the game's court so callers only have to know
 * the game. Best-effort by design — a viewer who misses this refetches on
 * their next interaction, and D1 was already written.
 */
export async function announceGameChanged(gameId: string): Promise<void> {
  try {
    const rows = await db()
      .select({
        courtId: games.courtId,
        startsAt: games.startsAt,
        locationId: courts.locationId,
      })
      .from(games)
      .leftJoin(courts, eq(courts.id, games.courtId))
      .where(eq(games.id, gameId))
      .limit(1)

    const row = rows[0]
    // A game still looking for players holds no court, so it isn't on any
    // calendar to update. It appears when it fills and gets assigned.
    if (!row?.courtId || !row.locationId) return
    await broadcastToLocation(row.locationId, {
      type: 'game.changed',
      gameId,
      courtId: row.courtId,
      startsAt: row.startsAt,
    })
  } catch (error) {
    console.error('announceGameChanged failed for', gameId, error)
  }
}
