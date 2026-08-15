# Plan: queued notifications and realtime updates

Design for two related pieces of work:

1. Move outbound email off the request path onto **Cloudflare Queues**.
2. Add **realtime UI updates** and an in-app notification inbox using
   **Durable Objects**.

Nothing here is built yet. Read `CLAUDE.md` first — particularly the layering
rule, which this plan does not change.

---

## Cost: this all stays free

Worth stating up front, because "free to operate" was the original constraint
and it survives intact.

| | Free plan | Notes |
|---|---|---|
| **Queues** | Yes, since Feb 2026 | 10,000 operations/day; 24h retention (14d on Paid) |
| **Durable Objects** | Yes | ~3M requests/mo, 390K GB-s/mo; SQLite-backed DOs incur no storage charge on Free |
| **WebSockets** | Yes | Incoming messages bill 20:1; outgoing messages and protocol pings are free |
| **Email via Resend** | Yes | 3,000/mo, 100/day |
| **Email via Cloudflare Email Service** | **No** | Requires Workers Paid ($5/mo) |

So the only thing that would push this onto a paid plan is choosing Cloudflare
for email delivery. Everything in this document is free-tier.

A budget note that shapes the design: 10,000 queue operations/day sounds
generous, but a single notification costs roughly three (write, read, delete).
Fan-out is per-recipient, so a doubles game reaching 20 players is ~60
operations. Fine at town scale; worth not being careless with.

---

## Part 1 — Queues for outbound notifications

### Why

`postGame` currently awaits `notifyCandidatesForGame`, which sends an email per
candidate inside the request. A host posting to twenty available players waits
for twenty HTTP round trips before seeing their game. That's the wrong place
for slow, retryable, third-party work.

### Email transport: REST, not SMTP

Confirmed decision. SMTP from inside a Worker means `connect()` from
`cloudflare:sockets` plus an SMTP client built on that primitive — nodemailer
and friends assume Node's `net`/`tls` and don't run on workerd. REST is a
normal `fetch`, which is what `resend.ts` already does.

Portability is preserved by the `MailAdapter` interface rather than by the wire
protocol. Swapping Resend for Cloudflare Email Service (or SES, or Postmark)
means one new file in `src/server/notify/` and an env var.

**Recommendation: stay on Resend for now.** It's free, already implemented, and
the only reason to move is consolidating vendors — which costs $5/month.
Revisit if volume approaches 3,000/month or 100/day.

### Shape

```jsonc
// wrangler.jsonc
"queues": {
  "producers": [
    { "queue": "gameseeker-notifications", "binding": "NOTIFY_QUEUE" }
  ],
  "consumers": [
    {
      "queue": "gameseeker-notifications",
      "max_batch_size": 10,
      "max_batch_timeout": 5,
      "max_retries": 3,
      "dead_letter_queue": "gameseeker-notifications-dlq"
    }
  ]
}
```

The consumer is a third export in `src/server.ts`, alongside `fetch` and
`scheduled`:

```ts
export default {
  fetch,
  scheduled,
  async queue(batch: MessageBatch<NotifyMessage>, _env: Env, _ctx: ExecutionContext) {
    for (const message of batch.messages) {
      try {
        await handleNotifyMessage(message.body)
        message.ack()
      } catch {
        message.retry()
      }
    }
  },
}
```

Ack and retry per message, not per batch — one bad address must not force
nineteen good ones to be redelivered.

### Messages carry ids, not rendered content

```ts
type NotifyMessage =
  | { kind: 'seeker-alert'; gameId: string; userId: string }
  | { kind: 'spot-confirmed'; gameId: string; userId: string }
  | { kind: 'host-filled'; gameId: string; userId: string; playerName: string }
  | { kind: 'game-cancelled'; gameId: string; userId: string; reason?: string }
  | { kind: 'reminder'; gameId: string; userId: string }
```

The consumer re-reads current state before sending. A game cancelled between
enqueue and delivery must not produce a cheerful "come play tomorrow" email.
This is the main reason not to enqueue pre-rendered bodies.

### Idempotency

Queues guarantee at-least-once delivery, so retries can double-send. The
existing `notifications` table already solves this for seeker alerts: the unique
index on `(user_id, game_id)` plus the insert-before-send ordering in
`notifyCandidatesForGame`. **Keep that ordering** when moving the send into the
consumer — insert the row in the request path, enqueue, and let the consumer
send. That way the dedupe happens before the message exists.

For the other kinds, add a `dedupe_key` column or accept that a rare duplicate
reminder is harmless. Prefer the former for cancellations.

### Producing without blocking

```ts
import { waitUntil } from 'cloudflare:workers'

waitUntil(env.NOTIFY_QUEUE.sendBatch(messages))
```

`waitUntil` is exported from `cloudflare:workers` (confirmed in the generated
types), so a server function can hand work to the runtime without holding the
response.

### Cron

The hourly reminder job should enqueue rather than send inline, for the same
reason. `runHourly` becomes a producer.

---

## Part 2 — Durable Objects for realtime

### Topology: two classes, not one

The instinct that a DO per location makes sense is right — for half of it.
Location is the correct unit for *broadcast* (many people watching one
calendar). It's the wrong unit for *addressed* notifications: "you were invited
to a game" belongs to a person, not a place, and must survive them being
offline.

So:

**`LocationHub` — one per location.** `env.LOCATION_HUB.getByName(locationId)`.
Holds WebSocket subscribers currently viewing that location's day view.
Broadcasts topic events. Entirely ephemeral: if it forgets everything on
eviction, nothing is lost, because clients refetch on reconnect.

**`PlayerInbox` — one per player.** `env.PLAYER_INBOX.getByName(userId)`.
Holds that player's live sockets across devices *and* a durable notification
queue in DO SQLite. This is what backs the in-app bell.

**Alternatives considered.** A single global hub would work at 50–200 players
and is simpler, but it makes every viewer wake for every event and becomes the
one thing that can't be partitioned later; location DOs cost nothing extra and
shard naturally. A DO per *court* is too granular — a viewer of one location
would open five sockets.

### Events describe what changed, not how

```ts
type LiveEvent =
  | { type: 'game.changed'; gameId: string; courtId: string; startsAt: number }
  | { type: 'demand.changed'; dayStart: number }
  | { type: 'inbox.new'; id: number; unread: number }
```

Clients react by calling `router.invalidate()` and refetching through the
loaders that already exist. **Do not send state diffs.** Refetching is a few
lines of client code, always correct, and cannot drift from the server. The
payload exists only so a client can decide whether it cares.

### Write path

Order matters, and D1 stays the source of truth:

1. Write to D1 (existing atomic guarantees unchanged).
2. `waitUntil(hub.broadcast(event))` — direct DO call, milliseconds.
3. `waitUntil(queue.sendBatch(messages))` — email, seconds, retryable.

Realtime deliberately does **not** go through the queue. Queues batch with a
timeout measured in seconds; a calendar that updates five seconds late feels
broken. Email is the thing that's slow and needs retries, so email is the thing
that gets queued.

### WebSocket hibernation is mandatory

Use the Hibernation API — `state.acceptWebSocket(server)` with
`webSocketMessage` / `webSocketClose` / `webSocketError` handlers — not
`addEventListener`. A DO holding sockets the naive way bills duration
continuously; a hibernating one isn't billed while idle. This is the single
most important implementation detail in this document.

It follows that the protocol should be server-to-client heavy: outgoing
messages are free, incoming bill at 20:1. No client heartbeats — the runtime's
protocol pings are free and already keep the connection alive.

### Authentication

A browser cannot set headers on `new WebSocket()`, but **cookies are sent on
the upgrade request** for same-origin connections. So the existing session
cookie works:

1. Worker route `/api/live/*` validates the session with `getCurrentUser()`.
2. On success, forwards the upgrade to the DO with the resolved user id in an
   internal header.
3. The DO trusts that header, because it is only reachable through the Worker.

Never let a client name its own user id.

### Routing around TanStack Start

`src/server.ts` currently delegates everything to Start's fetch handler. The
live endpoint has to be checked first:

```ts
async fetch(request, env, ctx) {
  const url = new URL(request.url)
  if (url.pathname.startsWith('/api/live/')) return handleLive(request, env)
  return startFetch(request, env, ctx)
}
```

### DO migrations

SQLite-backed classes need a migration entry:

```jsonc
"migrations": [
  { "tag": "v1", "new_sqlite_classes": ["LocationHub", "PlayerInbox"] }
]
```

### The inbox table

Inside `PlayerInbox`:

```sql
CREATE TABLE IF NOT EXISTS inbox (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT    NOT NULL,
  game_id    TEXT,
  title      TEXT    NOT NULL,
  body       TEXT,
  url        TEXT,
  created_at INTEGER NOT NULL,
  read_at    INTEGER
);
```

Methods: `push(entry)` (insert, then broadcast to live sockets), `list(sinceId)`
for backlog on reconnect, `markRead(ids)`, and an alarm that trims to the last
200 entries or 30 days.

**Keep this separate from the D1 `notifications` table.** That one is a
*delivery ledger* — claim tokens, channel, delivery status. This one is *what
the player sees in the app*. Different lifecycles, different access patterns,
and merging them would couple email delivery to UI state.

### Client

One hook:

```ts
useLiveUpdates({ location: locationId })  // location day view
useLiveUpdates({ inbox: true })           // mounted in the root layout
```

Opens the socket, reconnects with exponential backoff and jitter, and on
reconnect sends `lastSeenId` so the inbox can replay anything missed while the
tab was closed. On any event, `router.invalidate()`.

UI surface: a bell in the header with an unread count, a dropdown listing recent
entries, click-through to the game.

---

## Mapping to the three requirements

**A game is set up or updated → the calendar updates.**
`LocationHub(locationId)` broadcasts `game.changed` on create, claim, cancel,
and drop-out. Viewers of that location's day view invalidate. The availability
week view doesn't need this — it shows only your own times.

**You're invited, or a game fills or is created for you.**
`PlayerInbox(userId).push(...)` alongside the existing email. Live toast if the
tab is open, persisted badge if not. This is the highest-value piece: it makes
the app worth leaving open.

**Availability changes → the heatmap updates.**
The weakest case, and the honest thing to say is so. Availability changes are
infrequent and the heatmap is advisory — nobody is harmed by it being a minute
stale. Two consequences:

- **Coalesce.** A player editing a week of availability would otherwise fire
  twenty events. The DO should debounce `demand.changed` with `setAlarm`, at
  most one broadcast per ~10 seconds.
- **Fan-out is awkward today.** Availability isn't location-scoped, so a change
  has to reach every `LocationHub` (~7 — cheap, but conceptually wrong). This
  gets clean once players pick preferred locations (`TODO.md` item 2), after
  which a change only touches that player's locations.

If this needs cutting for scope, cut it first. A periodic refetch while the page
is visible would deliver most of the value for none of the machinery.

---

## Suggested phasing

Each phase is independently shippable and useful on its own.

1. **Queue the email.** No DOs. Removes the fan-out from the request path —
   the clearest win for the least new machinery.
2. **`PlayerInbox` + bell UI.** Highest user value; makes the app worth keeping
   open.
3. **`LocationHub` + live calendar.** Nice, and the natural payoff of the
   shared grid components.
4. **Demand coalescing for the heatmap.** Only if 1–3 have earned it.

---

## Testing

- `@cloudflare/vitest-pool-workers` can drive Durable Objects directly
  (`runInDurableObject`, `runDurableObjectAlarm`), so inbox push/list/trim and
  the coalescing alarm are unit-testable without a browser.
- Queue consumers are plain functions over a `MessageBatch` — test
  `handleNotifyMessage` directly, including the "game was cancelled between
  enqueue and send" case.
- Playwright earns its keep here: two browser contexts, one claims a seat,
  assert the other's bell increments **without a reload**. That is the whole
  feature in one assertion.
- Existing suites should keep passing untouched. If queueing the email breaks
  `postGame`'s reach count, note that the count now means *enqueued*, not
  *delivered*, and rename it.

## Gotchas to carry forward

- Hibernation, as above. Easy to get wrong and invisible until the bill.
- **Keep business rules out of DOs.** They are transport and fan-out. Rules stay
  in `src/server/*`, per the layering rule in `CLAUDE.md`.
- DOs and D1 are separate consistency domains. Always write D1 first; never
  treat a DO as the source of truth for a game.
- A DO is single-threaded. Don't do slow work (email!) inside one — that's what
  the queue is for.
- Local dev: `@cloudflare/vite-plugin` runs DOs and queue consumers in
  miniflare, but the browser-test environment (`CLOUDFLARE_ENV=test`) will need
  the same bindings declared, or the e2e suite breaks on startup.
