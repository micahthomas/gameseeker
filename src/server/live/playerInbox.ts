import { DurableObject } from 'cloudflare:workers'

/**
 * One player's notification inbox, plus whatever sockets they currently have
 * open across devices.
 *
 * Addressed per player rather than per location: "you were invited to a game"
 * belongs to a person, not a place, and has to survive them being offline.
 * See `docs/realtime.md`.
 *
 * Two rules this class exists inside, both from `CLAUDE.md`:
 *
 * - **Transport and fan-out only.** No business rules here. Nothing in this
 *   file decides who may join a game or what a game means; it stores what the
 *   player should see and pushes it to their open tabs.
 * - **D1 is the source of truth.** This is not the `notifications` table.
 *   That one is a *delivery ledger* — claim tokens, channel, delivery status.
 *   This is *what the player sees in the app*. Different lifecycles, different
 *   access patterns; merging them would couple email delivery to UI state.
 *
 * Sockets use the **Hibernation API** (`acceptWebSocket` plus the
 * `webSocketMessage` / `webSocketClose` / `webSocketError` handlers) rather
 * than `addEventListener`. A Durable Object holding sockets the naive way
 * bills duration continuously; a hibernating one is not billed while idle.
 * This is the single most important detail in the file.
 */

export type InboxEntryInput = {
  kind: string
  gameId?: string | null
  title: string
  body?: string | null
  url?: string | null
}

export type InboxEntry = InboxEntryInput & {
  id: number
  createdAt: number
  readAt: number | null
}

type Row = {
  id: number
  kind: string
  game_id: string | null
  title: string
  body: string | null
  url: string | null
  created_at: number
  read_at: number | null
}

/** Keep the inbox small; a bell dropdown never shows more than a page of it. */
const MAX_ENTRIES = 200
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
const TRIM_EVERY_MS = 24 * 60 * 60 * 1000

function toEntry(row: Row): InboxEntry {
  return {
    id: row.id,
    kind: row.kind,
    gameId: row.game_id,
    title: row.title,
    body: row.body,
    url: row.url,
    createdAt: row.created_at,
    readAt: row.read_at,
  }
}

export class PlayerInbox extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    // blockConcurrencyWhile so no request can observe a half-created schema.
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS inbox (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          kind       TEXT    NOT NULL,
          game_id    TEXT,
          title      TEXT    NOT NULL,
          body       TEXT,
          url        TEXT,
          created_at INTEGER NOT NULL,
          read_at    INTEGER
        )
      `)
    })
  }

  /** Add an entry and tell any open tabs about it. */
  async push(entry: InboxEntryInput, now = Date.now()): Promise<InboxEntry> {
    const rows = this.ctx.storage.sql
      .exec<Row>(
        `INSERT INTO inbox (kind, game_id, title, body, url, created_at, read_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL) RETURNING *`,
        entry.kind,
        entry.gameId ?? null,
        entry.title,
        entry.body ?? null,
        entry.url ?? null,
        now,
      )
      .toArray()

    const created = toEntry(rows[0]!)
    this.broadcast({ type: 'inbox.new', id: created.id, unread: this.unreadCount() })

    // Trim on a daily alarm rather than on every push: the work is the same
    // either way and this keeps the write path to a single insert.
    //
    // Scheduled from real time, never from `now` — that parameter exists so a
    // test can backdate an *entry*, and using it here would schedule an alarm
    // in the past for any backdated push.
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + TRIM_EVERY_MS)
    }
    return created
  }

  /** Recent entries, newest first, plus the unread count for the badge. */
  async list(limit = 30): Promise<{ entries: InboxEntry[]; unread: number }> {
    const rows = this.ctx.storage.sql
      .exec<Row>(`SELECT * FROM inbox ORDER BY id DESC LIMIT ?`, Math.min(limit, MAX_ENTRIES))
      .toArray()
    return { entries: rows.map(toEntry), unread: this.unreadCount() }
  }

  /** Mark specific entries read, or everything when given no ids. */
  async markRead(ids?: number[], now = Date.now()): Promise<{ unread: number }> {
    if (!ids) {
      this.ctx.storage.sql.exec(`UPDATE inbox SET read_at = ? WHERE read_at IS NULL`, now)
    } else if (ids.length > 0) {
      const placeholders = ids.map(() => '?').join(', ')
      this.ctx.storage.sql.exec(
        `UPDATE inbox SET read_at = ? WHERE read_at IS NULL AND id IN (${placeholders})`,
        now,
        ...ids,
      )
    }
    const unread = this.unreadCount()
    this.broadcast({ type: 'inbox.read', unread })
    return { unread }
  }

  private unreadCount(): number {
    const rows = this.ctx.storage.sql
      .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM inbox WHERE read_at IS NULL`)
      .toArray()
    return rows[0]?.n ?? 0
  }

  /**
   * WebSocket upgrade. Only reachable through the Worker, which has already
   * resolved the session — a client never names its own player id, because the
   * id is what addresses this object in the first place.
   */
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected a WebSocket upgrade', { status: 426 })
    }

    const pair = new WebSocketPair()
    const [client, server] = [pair[0], pair[1]]
    this.ctx.acceptWebSocket(server)

    // Send the current badge straight away so a tab that reconnects after
    // being asleep is correct without waiting for the next event.
    server.send(JSON.stringify({ type: 'inbox.read', unread: this.unreadCount() }))

    return new Response(null, { status: 101, webSocket: client })
  }

  /**
   * The protocol is deliberately server-to-client. Outgoing messages are free
   * and incoming ones bill at 20:1, so there are no client heartbeats — the
   * runtime's own protocol pings keep the connection alive for nothing.
   */
  override async webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): Promise<void> {
    // Nothing a client can say changes state. Reads go through the server
    // function, which is authenticated; accepting mutations over the socket
    // would be a second, weaker door into the same data.
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    // Hibernation manages the socket set; closing is all that's needed.
    ws.close()
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    ws.close()
  }

  /** Daily trim: last 200 entries, nothing older than 30 days. */
  override async alarm(): Promise<void> {
    const now = Date.now()
    this.ctx.storage.sql.exec(`DELETE FROM inbox WHERE created_at < ?`, now - MAX_AGE_MS)
    this.ctx.storage.sql.exec(
      `DELETE FROM inbox WHERE id NOT IN (SELECT id FROM inbox ORDER BY id DESC LIMIT ?)`,
      MAX_ENTRIES,
    )

    const remaining = this.ctx.storage.sql
      .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM inbox`)
      .toArray()[0]?.n ?? 0
    // Only keep the daily alarm alive while there's something to trim.
    if (remaining > 0) await this.ctx.storage.setAlarm(now + TRIM_EVERY_MS)
  }

  private broadcast(event: unknown): void {
    const payload = JSON.stringify(event)
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(payload)
      } catch {
        // A socket that has gone away must not stop the others being told.
      }
    }
  }
}
