import { DurableObject } from 'cloudflare:workers'

/**
 * One Durable Object per location, broadcasting calendar changes to whoever is
 * currently looking at that location's day view.
 *
 * Location is the right unit for *broadcast* — many people watching one
 * calendar — in the same way a player is the right unit for *addressed*
 * notifications. A single global hub would work at this scale but would wake
 * every viewer for every event and become the one thing that can't be
 * partitioned later; a DO per court would be too granular, since a viewer of
 * one location would then need five sockets.
 *
 * Entirely **ephemeral**, unlike `PlayerInbox`. It stores nothing: if it is
 * evicted and forgets every subscriber, nothing is lost, because clients
 * reconnect and refetch. That is also why a missed broadcast is survivable —
 * D1 is the source of truth and the loader re-reads it.
 *
 * Hibernation, as ever: `acceptWebSocket` plus the handler methods, never
 * `addEventListener`, or idle sockets bill duration continuously.
 */

export type LiveEvent =
  | { type: 'game.changed'; gameId: string; courtId: string; startsAt: number }
  | { type: 'demand.changed'; dayStart: number }

export class LocationHub extends DurableObject<Env> {
  /** Tell every open viewer that something on this calendar moved. */
  async broadcast(event: LiveEvent): Promise<void> {
    const payload = JSON.stringify(event)
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(payload)
      } catch {
        // One dead socket must not stop the others being told.
      }
    }
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected a WebSocket upgrade', { status: 426 })
    }

    const pair = new WebSocketPair()
    const [client, server] = [pair[0], pair[1]]
    this.ctx.acceptWebSocket(server)
    return new Response(null, { status: 101, webSocket: client })
  }

  override async webSocketMessage(): Promise<void> {
    // Server-to-client only. A viewer has nothing to tell the hub, and
    // anything it did say would not be trusted.
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    ws.close()
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    ws.close()
  }
}
