# CLAUDE.md

Working notes for this repo. Read `README.md` first for what the app is and how
to run it; this file is about how it's built, why, and what will bite you.

Picking up mid-project? Start with `HANDOFF.md`.

## Shape of the codebase

```
src/
  db/schema.ts   Drizzle + D1 schema. Single source of truth for the model.
  server/        Business logic. No HTTP, no React. Directly unit-testable.
  fn/            TanStack Start server functions. Validation + auth + shaping.
  components/    Shared UI, including the two time grids.
  routes/        Pages (file-based routing).
  server.ts      Worker entry: Start's fetch handler plus a `scheduled` handler.
```

The layering matters. `src/server/*` never imports from `fn/` or `routes/`, and
holds every rule worth testing. `src/fn/*` is a thin edge: validate input with
zod, resolve the current user, call into `server/`, shape the response. If you
find yourself writing a rule in `fn/`, it belongs one layer down.

## Non-negotiable invariants

**Two races are settled by the database, not by application code.** Don't
"improve" these into read-then-write logic.

1. *One game per court per time.* Courts are held in 30-minute granules in
   `court_slot_locks`, primary key `(court_id, slot_start)`. The locks are
   inserted together with the game's `court_id` in a single D1 `batch()`, which
   is one transaction, so a collision fails the whole thing.

   **This happens when the game fills, not when it is created.** A game holds
   no court while it is still looking for players — it stores the courts its
   host would accept in `game_court_options` and takes one at the moment the
   last seat goes. Holding every candidate up front would block five courts on
   behalf of a game that may never happen. The race did not go away; it moved
   later, and the primary key still settles it. See `src/server/assign.ts`.

   Three consequences worth knowing before changing anything here:

   - `games.court_id` is **nullable**, and every *open* game has a null one.
     Any query that joins courts must use a left join, or the dashboard and
     the game page silently empty out. This has already bitten once.
   - The location day view draws placed games solid and pending ones in
     outline, on the single court each *would* take if it filled right now
     (`projectPlacements`). One ghost per game, not one per candidate court —
     five ghosts would imply five courts are at risk when only one ever is.
     A host offers courts across as many parks as they like — the create form
     lists every location with something free, and ticking one appends its
     courts after their own park's. Two pending games wanting the same court
     are separated by creation order, oldest first. That is a display rule: the real contest is decided by
     whichever game *fills* first, and has to be, or a court would sit blocked
     for a game that never happens.
   - A game can fill and then have nowhere to play. That's `unplaceable` — the
     host is told to move it, never a silent cancellation. The create form
     therefore offers *every* free court as a backup by default: nothing is
     held either way, so more options only makes placement likelier, and a
     host cares far more about the time and level than about which court.
2. *One player, one game at a time.* Players are held in the same 30-minute
   granules in `player_slot_locks`, primary key `(user_id, slot_start)`.
   Written in the same `batch()` as the seat claim, and as part of
   `createGame`'s batch for the host. Two concurrent claims for overlapping
   games can't both pass a read-then-write check, so this is a primary key
   instead. Released on drop-out and cancellation — forget that and the player
   stays blocked from every other game in that window.

   One wrinkle worth knowing: a claim that loses the race for a *seat* has
   already committed its player locks, because the guarded UPDATE only reports
   zero rows after the batch commits. `claimSlot` deletes them on that path. A
   test covers it.

3. *One winner per seat.* Claiming is
   `UPDATE game_slots SET filled_by_user_id = ? WHERE id = ? AND filled_by_user_id IS NULL RETURNING *`.
   Zero rows back means someone else won. A partial unique index also stops one
   player holding two seats in a game from two devices.

Both have tests that fire concurrent requests and assert exactly one succeeds
(`test/games.test.ts`).

**Contact details never leave the server.** `getGame` deliberately does not
select phone or email. A game page is readable by anyone with the link and any
matching player can claim a seat, so "only participants can see it" is not a
real boundary. Phone numbers exist solely to text a player about their own
games. Don't add contact info to a game payload.

## Time

Every *instant* is stored as UTC epoch milliseconds. The one exception is
`availability_rules`, which stores `weekday` + `start_minute`/`end_minute` as
**local wall-clock** — because "Tuesdays at 5pm" has no fixed UTC value; it's
23:00Z in July and 00:00Z in January. Storing it as an instant would shift
everyone's availability by an hour twice a year.

Rules for working here:

- Convert at the edges only: `zonedToUtc` / `parseLocalInput` on the way in,
  `formatDateTime` and friends on the way out. All in `src/server/time.ts`.
- Never step days with `+ 86400000`. Use `addLocalDays` or `localDayRanges`.
  DST days are 23 and 25 hours long, and a fixed day lands an hour off. There
  is a test that pins this exact failure (`test/time.test.ts`).
- `parseLocalInput` interprets a `datetime-local` value as *Santa Fe* time, not
  the browser's. A player checking the app from a trip must still pick Santa Fe
  court times.
- The app is single-timezone by design (`TZ = 'America/Denver'`). If that ever
  changes, it's a real project, not a find-and-replace.

## Matching

Level matching is **opt-in set intersection**, not a band around a rating.
Players tick every NTRP level they'll play (`users.play_levels`, JSON array);
a game's open seats each ask for one level. A player matches when the sets
intersect. `games.min_ntrp`/`max_ntrp` are for display and browse filtering
only — never use them as the admission test. Use `playsAtLevel()`.

Availability coverage is shared SQL (`availabilityCoverageSql`) used by both the
single-player check and the bulk candidate query, so the two can't drift. A
window is covered when a recurring rule *or* a one-off available block spans
the whole thing, and no busy block overlaps it. Busy always wins — that's what
makes it usable as a vacation override.

## Formats

A game is a `format` (`singles` | `doubles`) plus an `is_mixed` flag. A player
opts into a **set** of the four combinations in `users.formats`:
`singles | mixed_singles | doubles | mixed_doubles`.

`src/server/formats.ts` is the only place those two representations meet.
`playerFormat(format, isMixed)` names the one player-format a game corresponds
to; ask `playsFormat()` rather than inspecting the set by hand.

Same opt-in rule as levels, and it cuts both ways: **`mixed_doubles` does not
imply `doubles`**, and `doubles` does not imply `mixed_doubles`. Someone may
want only the mixed ones. Inferring either direction would send players games
they never asked for, which is the failure this whole matching model exists to
avoid. The migration backfill honours that too — nobody was auto-enrolled into
`mixed_singles`, because the old `plays_mixed` only ever meant doubles.

Where it is *deliberately* loose:

- **Claiming** gates mixed only, not plain singles/doubles — same as the old
  `plays_mixed` check. Someone who spots a game they can make should be able to
  take it; mixed seats are different because they exist to hold a balance.
- **Browsing and the demand heatmap** match on game shape and ignore mixed, so
  a mixed-doubles-only player still counts as doubles demand.

Mixed uses `game_slots.seeker_gender` to hold the balance: two and two for
doubles, one of each for singles. `users.gender` is optional and `unspecified`
is a first-class answer — it only ever costs you seats that exist to balance a
mixed game. A non-binary or unstated host gets unconstrained seats rather than
being forced into a bracket the format doesn't have, and hosting a mixed game
requires a stated gender because that's what the seats are balanced against.
See `mixedSeatGenders()`.

Availability's `format_pref` stays coarse (`singles | doubles | either`) on
purpose. Availability is about *when* you can play; which formats you want
lives on the profile.

## Location preference

`user_locations(user_id, location_id, rank)`, rank 0 = most preferred. Replaced
`users.home_location_id`, which nothing used for matching.

It is a **soft** preference and must stay one: it orders, it never excludes.
`findCandidates` sorts by rank before level closeness, and `listOpenGamesFor`
sorts by rank before start time, but a player who listed nothing — or listed
somewhere else — still hears about the game. Filtering would be stricter and is
the right call at city scale; at five parks and a couple of hundred players it
risks a small pool going quiet, which is a worse failure than an imperfectly
ordered invitation list.

Unranked sorts as `UNRANKED` (9999) rather than NULL, so "no preference" has a
defined position instead of depending on how SQLite orders nulls.

`setPreferredLocations` rewrites ranks contiguously from 0 on every save, so
stored ranks always match what the player sees and removing one leaves no gap.

## Notifications

Delivery is behind `MailAdapter` / `SmsAdapter` (`src/server/notify/`). The
console adapter is the default and prints to the Worker log, which is what
makes local development work with no accounts and no domain. Resend and Twilio
adapters exist and are switched on with env vars, not code changes.

Failures are collected per recipient, never thrown — one bad address must not
abort a fan-out to twenty other players.

`notifications` has a unique index on `(user_id, game_id)`. Insert the row
*before* enqueueing; that index is what guarantees a player is never alerted
twice about the same game — whether two fan-outs race, or the queue redelivers.

### Sending is queued

Outbound notifications go through **Cloudflare Queues** (`NOTIFY_QUEUE`,
consumed by the `queue` export in `src/server.ts`). The split is:

- **In the request:** find candidates, write notification rows, hand the whole
  set to `enqueueNotifications` in one `sendBatch`. A host posting to twenty
  players waits on one call, not twenty.
- **In the consumer** (`src/server/notify/queue.ts`): re-read state, render,
  send. Failures update the notification row.

Three rules here, each load-bearing:

1. **Messages carry ids, never rendered bodies.** The consumer re-reads the
   game and skips everything except a cancellation if the game has since been
   called off. Enqueuing a finished email would freeze the world at request
   time and cheerfully invite people to a game that isn't happening.
2. **Rows before messages.** See the unique index above.
3. **Ack and retry per message, not per batch.** One bad address must not force
   redelivery of nineteen good ones.

Magic-link sign-in is *not* queued and shouldn't be. It's one email that a
person is actively waiting on, and queue latency would be felt as a broken
login. Note that `requestLogin` awaits `sendEmail` *before* returning the
dev-only link the login page renders — so a mail adapter that throws takes
sign-in down with it. That's why `resolveMailProvider` exists: the committed
config points at Resend for production, and without a dev fallback to the
console adapter every fresh clone would be unable to log in.

If `NOTIFY_QUEUE` isn't bound, `enqueueNotifications` delivers inline through
the same `handleNotifyMessage` and warns once. That keeps the unit-test worker
and any un-queued environment working, and because both paths share the render
step they cannot drift. A warning in production means the binding is missing.

### Realtime: the notification inbox

`PlayerInbox` (`src/server/live/playerInbox.ts`) is one Durable Object per
player, holding their inbox in DO SQLite plus whatever sockets they have open
across devices. The bell in the header is its client.

Rules that constrain anything added here:

- Business rules stay in `src/server/*`. Durable Objects are transport and
  fan-out only.
- D1 is the source of truth. Write it first, then push. A Durable Object is
  never authoritative for a game.
- Realtime does **not** go through the queue. Queues batch on a timeout
  measured in seconds; a bell five seconds late feels broken. Email is what's
  slow and retryable, so email is what gets queued. Both happen at the same
  call site: push first, enqueue second.
- **Hibernation is mandatory.** `ctx.acceptWebSocket` plus the
  `webSocketMessage` / `webSocketClose` / `webSocketError` handlers, never
  `addEventListener`. A DO holding sockets the naive way bills duration
  continuously.
- Events say *what changed*, never state. The client refetches through
  `fetchInbox`. One authenticated path to the data, and it cannot drift.
- The protocol is server-to-client. Outgoing messages are free, incoming bill
  at 20:1, and nothing a client says is trusted anyway — no heartbeats, the
  runtime's protocol pings already keep the socket alive.

**Every inbox helper degrades to a no-op** if the binding is missing or the DO
throws. The inbox is a convenience; the email still goes out and D1 still holds
the truth, so a failed push must never take down the request that produced it.

#### Why the socket uses a ticket, not the cookie

`docs/realtime.md` assumed the session cookie would authenticate the upgrade.
Cookies *are* sent on a same-origin upgrade, but reading ours needs TanStack
Start's request context, and `/api/live/inbox` is handled **before** Start's
handler — Start claims every path, and a 101 response would not survive it.
Outside that context `useSession` throws `No StartEvent found in
AsyncLocalStorage`.

So the client calls an ordinary authenticated server function for a 30-second
HMAC-signed ticket and presents it on the upgrade URL
(`src/server/live/ticket.ts`). The player id comes out of the signature, so a
client still never names its own id. Stateless deliberately: a table would add
single-use semantics, but the ticket is short-lived, obtained over TLS from an
already-authenticated call, and opens nothing but that player's own socket.

### Realtime: the live calendar

`LocationHub` (`src/server/live/locationHub.ts`) is one Durable Object per
location, broadcasting `game.changed` to whoever is viewing that day view.
Location is the right unit for *broadcast* in the same way a player is the
right unit for *addressed* notifications — a global hub would wake every viewer
for every event, and a hub per court would need five sockets per viewer.

Unlike `PlayerInbox` it is **entirely ephemeral**: it stores nothing, and
losing every subscriber on eviction costs nothing because clients reconnect and
refetch. That is also why a dropped broadcast is survivable — D1 was already
written, and the loader re-reads it.

`announceGameChanged(gameId)` resolves the location through the game's court,
so call sites only have to know the game. It runs on create, claim, drop-out
and cancel — every path that changes what the day view shows.

Both channels share one client implementation, `useLiveChannel`. If you add a
third, extend that hook rather than copying it — the ticket handshake, the
backoff and the teardown are the parts that bite.

Subscribing to a location requires a signed-in ticket even though the day view
itself is public. That adds no unauthenticated socket surface, and a signed-out
visitor gets exactly the static page they get today. The ticket proves "a
player", not "a player entitled to this location" — the calendar is already
visible to anyone with the link.

**Durable Object migrations are append-only.** `v1` created `PlayerInbox` and
is deployed; `LocationHub` needed a new `v2` entry. Never edit a tag that has
shipped.

#### The heatmap refreshes on a timer, not over a socket

`docs/realtime.md` planned a `demand.changed` broadcast with alarm-based
coalescing. It isn't built, and shouldn't be without a reason: availability
changes are infrequent, the heatmap is advisory, and a 60-second refetch while
the tab is visible buys nearly all of the value for none of the machinery —
no fan-out to every location's hub, no debounce alarm so one player editing a
week doesn't fire twenty events. The poll pauses in a background tab and
catches up on `visibilitychange`.

Game changes *are* pushed, because a calendar that is five seconds stale about
a booking feels broken in a way a slightly stale heatmap does not.

#### Testing Durable Objects

`isolatedStorage` is **off** in `vitest.config.ts`. Driving a DO directly
(`runInDurableObject`, `runDurableObjectAlarm`) leaves state the per-test
storage stack can't unwind, and it fails the whole run. Nothing depends on it:
every suite resets D1 in `beforeEach`, and the inbox tests address a fresh
player id per test.

In a browser test, **close pages before their contexts**. A page holding an
open WebSocket that is torn down with its context wedges the single-worker dev
server for whatever runs next.

## Auth

Magic link only. Tokens are stored SHA-256 hashed; redemption is a guarded
`UPDATE ... RETURNING` so a link works exactly once (email scanners prefetch).
Sessions are a server-side row plus an encrypted cookie, so deleting the row
logs a device out immediately.

`APP_URL` resolves differently by environment on purpose: in dev it uses the
request origin so the app works on any port; in production it always uses the
configured value. **Don't "simplify" that** — trusting the request Host header
in production would let a forged header mint a sign-in link pointing at an
attacker's domain.

## UI conventions

Both calendars share `src/components/timeGrid.tsx`: geometry constants, the
`useColumnDrag` hook, `GridPopover`, and the drag/pending block visuals.
`WeekCalendar` has days as columns; `CourtDayGrid` has courts as columns. If
you add a third grid, extend that module rather than copying.

Two things that will silently break drag interactions:

- Anything clickable rendered *inside* a grid needs `data-entry` (or
  `data-popover`), or `useColumnDrag`'s `preventDefault` swallows its click and
  starts a selection on top of it.
- A container with `overflow-hidden` around a grid clips the popover. Put the
  scroll/clip on an inner wrapper.

Mobile-first: this is used from a phone at the court. Inputs are 16px minimum
so iOS doesn't zoom on focus.

## Testing

Two suites, and they test different things.

**`npm test`** — Vitest inside workerd against a real D1 (`@cloudflare/vitest-pool-workers`).
This is where business rules live. Migrations are read on the Node side and
applied via a binding because the worker has no filesystem. Don't mock D1: the
guarantees this app leans on *are* database behavior, and mocking them tests the
mock.

**`npm run test:e2e`** — Playwright through the real UI on port 3100, with
`CLOUDFLARE_ENV=test`. Covers what unit tests can't: hydration, cookies, CSRF,
serialization, route wiring.

Hard-won practices — every one of these came from a real failure:

- **Wait for hydration.** The root sets `data-hydrated` after mount; the `goto`
  helper waits for it. Clicking before then submits forms natively and silently
  does nothing.
- **Never compute pixel coordinates.** Grid cells carry `data-slot="col:minute"`;
  the drag helpers target those so Playwright scrolls and waits for stability.
  Coordinate maths against a shifting layout was the single biggest flake source.
- **The suite shares one database.** Court bookings are global state, so tests
  run serially, and each test books its **own hour, spaced two hours apart** —
  games default to 90 minutes, so consecutive hours overlap and eat each other's
  courts.
- **Scope assertions to your own data.** A day view shows every game that day,
  including other tests'. Filter by player name; don't count elements globally.
- **Fix flakes, don't retry them.** Every "flake" here turned out to be a real
  bug — most recently, submitting the create form while the court list was
  refetching posted the game onto the previous location's court.

### The `database_id` trap

Local D1 is keyed by **`database_id`, not by database name**. Giving two
environments the same id — including the same placeholder — silently puts them
in one SQLite file. That cost a session: the test suite was wiping the
development database on every run, destroying demo data and signing the user
out. If you touch `wrangler.jsonc`, keep the ids distinct.

## Demo data

`npm run db:demo` — 36 players (four at every level, with availability posted)
and a game on every court across the coming week, deterministic from a fixed
seed. It includes **today**, because the location page opens on today and a demo
whose first screen is empty looks broken. It clears players and games first.

## Judgement calls worth preserving

- Cron *nudges* a host whose game is short rather than auto-cancelling it.
  Three players with an empty doubles seat usually still play, and silently
  deleting someone's game isn't software's call.
- Seeded courts are a starting point from public reporting, not gospel. Courts
  deactivate rather than delete, so a resurfacing closure keeps its history.
- Coordinates are left `NULL` rather than guessed.
- The app never claims to reserve a court with the city. Public park courts are
  first come, first served; the guarantee is only that GameSeeker doesn't send
  two of its own games to one court.
