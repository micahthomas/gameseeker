# CLAUDE.md

Working notes for this repo. Read `README.md` first for what the app is and how
to run it; this file is about how it's built, why, and what will bite you.

Everything in the original plan is built and deployed. `docs/realtime.md` is
the design that queues and Durable Objects came from — useful history, but it
is a *plan*, and three of its assumptions turned out to be wrong; the
corrections are noted below where each applies.

## Shape of the codebase

```
src/
  db/schema.ts    Drizzle + D1 schema. Single source of truth for the model.
  server/         Business logic. No HTTP, no React. Directly unit-testable.
    assign.ts       Giving a filled game a court.
    batch.ts        batchOf() and violates(), shared by games and clinics.
    clinics.ts      Recurring coached sessions: courts, capacity, signups.
    clinicNotify.ts Who hears about a clinic. Sits above clinics.ts.
    formats.ts      Singles/doubles x mixed, and who plays what.
    markdown.ts     Escape-first Markdown, for clinic descriptions.
    matching.ts     Who hears about a new game, and about a claim.
    media.ts        Signed upload tickets and R2 storage for hero images.
    preferences.ts  Where a player likes to play.
    notify/         Mail and SMS adapters, templates, calendar invites, the
                    queue producer/consumer.
    live/           Durable Objects: PlayerInbox, LocationHub, socket tickets.
  fn/             TanStack Start server functions. Validation + auth + shaping.
  components/     Shared UI, including the two time grids and the bell.
  routes/         Pages (file-based routing).
  server.ts       Worker entry: Start's fetch handler, `scheduled`, `queue`,
                  the /api/live/*, /api/calendar/* and /api/media/* routes,
                  and the DO class exports.
public/           Favicons, apple-touch icon and the web manifest. Copied into
                  the client build, which is the Worker's assets directory —
                  no route serves them, so only e2e/site.spec.ts notices if
                  that wiring breaks.
```

The layering matters. `src/server/*` never imports from `fn/` or `routes/`, and
holds every rule worth testing. `src/fn/*` is a thin edge: validate input with
zod, resolve the current user, call into `server/`, shape the response. If you
find yourself writing a rule in `fn/`, it belongs one layer down.

## Non-negotiable invariants

**Three races are settled by the database, not by application code.** Don't
"improve" any of them into read-then-write logic. Each has a test that fires
concurrent requests and asserts exactly one wins.

1. *One booking per court per time.* Courts are held in 30-minute granules in
   `court_slot_locks`, primary key `(court_id, slot_start)`. The locks are
   inserted together with the game's `court_id` in a single D1 `batch()`, which
   is one transaction, so a collision fails the whole thing.

   **Both lock tables are polymorphic, and must stay one table each.** A row
   carries either a `game_id` or a `clinic_occurrence_id`, never both and never
   neither — there is a CHECK constraint saying so. Clinics book the same
   public courts games do, so they have to be settled by the same primary key;
   a separate `clinic_court_locks` would let a game and a clinic be sent to the
   same court at the same hour, which is the exact failure this table exists to
   prevent. Anything else that books a court in future belongs here too, as a
   third nullable column. `test/clinics.test.ts` pins this in both directions.

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
   - A host offers courts across as many parks as they like. The create form
     lists every location with something free for that window, and ticking one
     appends its courts after their own park's. Widening is what keeps a game
     out of `unplaceable`, and it costs nobody anything, because nothing is
     held until the game fills.
   - The day view draws placed games solid and pending ones in outline, on the
     single court each *would* take if it filled right now
     (`projectPlacements`). One ghost per game, not one per candidate court:
     five ghosts would imply five courts are at risk when only one ever is.
     Two pending games wanting the same court are separated by creation order,
     oldest first — a display rule, not a promise. The real contest is decided
     by whichever game *fills* first, and has to be, or a court would sit
     blocked for a game that never happens.
   - A game can fill and then have nowhere to play. That's `unplaceable` — the
     host is told to move it, never a silent cancellation. The create form
     therefore offers *every* free court as a backup by default: nothing is
     held either way, so more options only makes placement likelier, and a
     host cares far more about the time and level than about which court.
2. *One player, one booking at a time.* Players are held in the same 30-minute
   granules in `player_slot_locks`, primary key `(user_id, slot_start)` —
   shared with clinic signups, which is what makes "you can't be in a clinic
   and a game at once" free rather than a rule anyone has to remember.
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

The concurrency tests live in `test/games.test.ts`, `test/assign.test.ts` and
`test/clinics.test.ts`.

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

Mixed uses `game_slots.seeker_division` to hold the balance: two and two for
doubles, one of each for singles. The side a player takes comes from
`users.division` (`mens | womens | unspecified`). See `mixedSeatDivisions()`.

**This is a division, not a gender, and the difference is deliberate.** It
replaced a `users.gender` column (`woman | man | nonbinary | unspecified`) in
migration `0008`. The only question the app ever asked of that column was
"which of a mixed game's two sides can you take?", and deriving it from an
identity was both more personal data than the feature needed and a worse fit:
a mixed game has exactly two sides, so a non-binary player fell to
`unspecified` and silently lost access to balanced seats. A division is a thing
players already state in tennis terms, so they answer it directly — and anyone
can now pick one. Don't reintroduce a gender field to "improve" this.

`unspecified` is still a first-class answer and still only ever narrows: such a
player plays singles and ordinary doubles freely and can take a mixed seat
that isn't held to a side. A host with no division gets unconstrained seats
rather than being assigned one, and hosting a mixed game requires a division
because that's what the seats are balanced against.

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

## Clinics

The other shape of tennis the app knows about: one person committing to a
court on a schedule and taking signups. Cardio tennis, a drills hour, a junior
session. `src/server/clinics.ts` holds every rule; `src/server/clinicNotify.ts`
sits above it and decides who is told.

**A clinic takes its courts when it is created. A game does not.** That looks
like an inconsistency and isn't. A game holds nothing while it fills because it
may never fill, and blocking five courts for a group that never assembles is
worse than losing one to whoever books it first. A clinic has already
assembled — the organizer will be there whether or not anybody signs up — so
holding the court is the entire point of creating one. Everything else about
the race is unchanged: the locks go in `court_slot_locks` under the same
primary key, so a game and a clinic can never be sent to the same court.

Creation is **all or nothing**. The clinic row, every occurrence, and every
30-minute court lock go into one `batch()`, so a single clash anywhere in the
series fails the whole thing — a coach whose week 4 is missing has a different
clinic from the one they asked for. The conflicting dates are read back and
named, so they can move the time rather than guess.

**Occurrences are materialised, not expanded on read.** This is the opposite of
`availability_rules`, and it has to be: a court is held by rows, and those rows
need something to point at. The recurrence itself is still stored as **local
wall-clock** for exactly the reason availability is — "Tuesdays at 6pm" has no
fixed UTC value, and `generateOccurrences` walks days with `addLocalDays` so a
6pm clinic is still 6pm after the clocks change. Series are capped at 26 dates,
which is what keeps that one batch bounded.

**Capacity is a number, not one row per seat.** `game_slots`' shape is right
for 2 or 4 and wrong for 20, and it would freeze the capacity an organizer set
on day one. The race is settled instead by a single guarded statement:

```sql
INSERT INTO clinic_signups (...) SELECT ?, ?, ?, ?
WHERE (SELECT COUNT(*) FROM clinic_signups WHERE occurrence_id = ?) < ?
```

SQLite evaluates that as one statement, so the count and the insert can't
interleave. Zero rows written means it filled. It goes in the same `batch()` as
the player locks, and **the losing path deletes those locks** — the guarded
insert only reports zero rows once the batch has committed, which is the
identical wrinkle `claimSlot` has.

That one statement is the only place in the feature that leaves the query
builder, and it uses the raw `d1()` handle rather than `db()`: drizzle can't
put a *parameterised* raw statement into a `batch()`.

**Organizer access is granted, not claimed.** `users.organizer_status` moves
`none → requested → approved | declined`, decided by an admin under
Admin → Organizers. Holding a public court for eight weeks isn't something the
app can undo on someone else's behalf once players have signed up. An admin is
an organizer implicitly. Declined stays declined rather than resetting, so a
decision isn't quietly re-requestable.

**Who hears about a new clinic** is deliberately *not* `findCandidates`. Level
and format matching exist to fill one specific seat in one specific game; a
clinic is neither level-specific nor format-specific, and running it through
that filter would exclude most of the people it is for. Recipients are players
with `notify_clinics` on whose preferred locations include the clinic's park —
or who listed none, following the same soft-preference rule as everything else.
Rows into `clinic_notifications` before the queue messages, for the same reason
the game path does it.

Publishing happens **once**: `publishClinic` is a guarded UPDATE off `draft`, so
a second call announces nothing.

### Descriptions are escape-first Markdown

`src/server/markdown.ts` HTML-escapes the entire input *before* any formatting
rule runs, and every rule afterwards only matches patterns in the escaped text.
No path exists by which raw input reaches the output, so there is no sanitizer
to get wrong — and a rule added later cannot introduce an injection, because
there is no unescaped input left to inject. **Don't reorder that.** Anything
unrecognised is shown literally rather than stripped, and links are `https?:`
only.

There is no `@tailwindcss/typography` plugin, so the renderer puts classes on
each tag rather than relying on a `prose` wrapper.

### Hero images

`CLINIC_MEDIA`, an R2 bucket, keyed by the SHA-256 of the object's own bytes —
so a re-upload is idempotent and `/api/media/<key>` can be cached forever.

Uploads reuse the **live-ticket pattern** rather than inventing a second one:
`/api/media/upload` runs before Start's handler and so has no session to read,
exactly like the WebSocket upgrade, so an authenticated server function mints a
short-lived HMAC ticket and the raw handler verifies it. The declared content
type is a claim by the client, so the leading bytes are sniffed before anything
is stored — serving an HTML document back from our own origin as `image/png`
is the failure that prevents.

## Calendar invites

The moment a game's last seat goes is the first moment anyone can be told where
it actually is, because a game holds no court until it fills. That moment used
to be nearly silent — the players who claimed earlier were told "court
confirmed once it fills" and never heard again. It now sends `game-on` to
*every* participant, and that is the message carrying the calendar entry.

`src/server/notify/calendar.ts` writes iCalendar by hand: a dependency for a
hundred lines of string formatting would hide the parts that actually break in
real clients. Three of those get their own tests — folding at 75 **octets**
(not characters), TEXT escaping, and a stable UID.

- Instants go out as UTC (`YYYYMMDDTHHMMSSZ`) straight from the epoch
  milliseconds. No `VTIMEZONE`, and therefore no DST arithmetic to get wrong.
- **`ATTENDEE` is the recipient's own address and never the roster.** Telling
  someone their own email is not a disclosure, and it is what lets Google and
  Outlook match a later update to the entry they hold. The copy served from
  `/api/calendar/game/<id>.ics` has no attendee line at all, which is why it
  can be public like the game page.
- `SEQUENCE` comes from `games.calendar_seq` / `clinic_occurrences.calendar_seq`,
  advanced by the cancellation itself. A client ignores an update that doesn't
  advance it, so without the bump a cancelled game sits on everybody's calendar
  forever. The bump is stored rather than computed in the template, so a future
  reschedule advances from it.

Removal-in-place is reliable in Apple Calendar and Outlook and inconsistent in
Google, so the cancellation email says so in words as well. The file is the
convenience; the sentence is the guarantee.

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
`clinic_notifications` is the same idea for clinic announcements, in a separate
table: `notifications` is thoroughly game-shaped (`slot_id`, `seeker_ntrp`, a
single-use `claim_token`) and none of it means anything for a clinic.

`handleNotifyMessage` branches on whether the message carries a `gameId` or a
`clinicId`. Both halves re-read before rendering, and both bail out on anything
except a cancellation once the thing has been called off.

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

**The day or week on screen belongs in the URL**, not only in component state:
`?day=YYYY-MM-DD` on a location, `?week=YYYY-MM-DD` on availability. Open a
Wednesday, tap a game, press back, and you land on that Wednesday. Both derive
their state *from* the search param rather than mirroring it, so the two can't
drift and browser back/forward pages for free, and both navigate with
`replace` so paging a month doesn't leave four history entries behind.

The location view keys its loader on the day, so a link to a date next month
arrives with that week loaded; availability deliberately does **not**, because
those are the viewer's own entries, there's no freshness argument, and keying
it would turn instant paging into a round trip per click.

**A relative step must be resolved against the search the router currently
holds, not the one the render closed over.** `navigate` is async, so a second
click arriving before React re-renders would otherwise compute from the
*previous* day or week and skip one — press Next, Previous, Next quickly on the
availability calendar and you land two weeks out. Both paging helpers therefore
pass a function to `navigate({ search: (prev) => ... })` and derive the current
value from `prev`. Absolute jumps ("Today", the date picker) pass a number and
skip that. Each grid has a test that clicks three times inside one task via
`page.evaluate`, which is deterministic where Playwright's own click waits for
actionability between calls and so reproduced this only about one run in ten.

One consequence for tests: paging is now a router update rather than a
synchronous `setState`, so reading `textContent()` straight after the click
races it. Use an auto-waiting assertion, or assert on the URL — which pins the
exact dates anyway.

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
- **Four places hard-code a table list**, and a new table has to reach all
  four or its rows survive a reset: `resetDb()` in `test/helpers.ts`,
  `drizzle/reset.sql`, `drizzle/reset-facilities.sql`, and the cleanup in
  `e2e/global-setup.ts`. A leftover clinic occurrence keeps a court booked for
  every test that follows.
- **`e2e/clinics.spec.ts` books Atalaya Park and nothing else does.** A clinic
  holds its court for every date in the series, so sharing a park with the
  games specs would take courts out from under them for weeks at a time.
- `getByText('approved')` is a substring match and matched the *Approve*
  button, letting a test race past the update it was meant to wait for. Assert
  on the control that disappears instead.

### The `database_id` trap

Local D1 is keyed by **`database_id`, not by database name**. Giving two
environments the same id — including the same placeholder — silently puts them
in one SQLite file. That cost a session: the test suite was wiping the
development database on every run, destroying demo data and signing the user
out. If you touch `wrangler.jsonc`, keep the ids distinct.

## Demo data

`npm run db:demo` — 36 players (four at every level, with availability posted)
and roughly 38 games across the coming week, deterministic from a fixed seed.
It includes **today**, because the location page opens on today and a demo
whose first screen is empty looks broken. It clears players and games first.

Demo games are written already placed, with a court and its locks, which is a
state the app itself only reaches once a game fills. That is deliberate: a day
view of nothing but outlines would misrepresent what the app looks like in use.
The seeder respects `player_slot_locks` too, so no demo player is ever in two
games at once.

It also seeds one published clinic — Tuesdays and Thursdays at 6am, ahead of
every game hour so it shares a court without colliding — and makes the first
player at each level an approved organizer. Same argument as including today: a
feature that never appears on the first screen reads as missing rather than
unused.

The SQL goes to a temp file rather than `--command`. The whole seed is one
argument that way, and adding the clinic pushed it past the operating system's
argument-length cap — which fails as an opaque exit code, not as anything
about SQL.

## Operating it

Live at `https://gameseeker.app`. `.github/workflows/ci.yml` owns deployment:
push to `main` runs typecheck, unit tests, browser tests and the build, then
applies D1 migrations, then deploys. Pull requests run the same gate and stop
short of deploying.

**Migrations run before the deploy, and that ordering is the point.** Code that
expects a column the remote database hasn't got takes production down until the
migration lands, so CI never lets the deploy get there first. This used to be a
rule you had to remember (`npm run db:migrate:remote && git push`) because
Cloudflare Workers Builds deployed on push and knew nothing about migrations.
**Workers Builds must stay disconnected** — with both on, every push deploys
twice and the Workers Builds one lands first, untested and ahead of its
migrations.

The hazard CI can't remove is the reverse one: a **destructive** migration
breaks the running code from the moment it applies until the new deploy
finishes a minute or two later — dropping a column the deployed Worker still
reads is a live outage for that window. Migration `0008` did exactly this. When
the window matters, split it across two releases: ship code tolerating both
shapes, drop the column later.

Two more traps in `wrangler.jsonc`:

- **Named environments inherit nothing.** A binding added at the top level has
  to be repeated under `env.test`, or the browser suite runs against a
  differently-shaped Worker than production — which is exactly how you get a
  feature that passes its tests and is broken live.
- The custom domain lives in the Cloudflare dashboard, not in `wrangler.jsonc`,
  so a deploy from a clean checkout would not reproduce it.

**Adding a binding can mean adding a permission to the deploy token**, and
that failure lands in the worst possible place. `wrangler deploy` resolves each
binding by fetching the resource, so a token missing the permission fails
*after* `d1 migrations apply` has already run — leaving the database ahead of
the code until someone edits the token. It surfaced as
`Authentication error [code: 10000]` against `/accounts/…/r2/buckets/…`, which
says nothing about tokens. The R2 bucket also has to exist first:
`npx wrangler r2 bucket create gameseeker-media`. The four permissions the
token needs are listed in `.github/workflows/ci.yml`.

Like the queues, the binding is repeated under `env.test` — named environments
inherit nothing. `gameseeker-media-test` is local-only and created on demand,
so it needs nothing in the dashboard.

Secrets are `SESSION_SECRET` and `RESEND_API_TOKEN` (note the name — Resend's
own docs call it an API key). `mise run secrets:push` and `secrets:session` set
them; the Resend token comes out of 1Password.

## The repository is public

MIT, at `github.com/micahthomas/gameseeker`. Two consequences worth holding on
to:

- **Nothing secret may enter the tree.** Secrets are Worker secrets and GitHub
  Actions secrets only. The production `database_id` in `wrangler.jsonc` is an
  identifier rather than a credential — it opens nothing without account
  API credentials — but treat anything new with the same suspicion.
- **Pull requests from forks run the full gate and get no credentials.** That
  works because the test job needs none: local D1, console mail adapter. Keep
  it that way. A test that requires a real API token would silently fail for
  every outside contributor, and moving the workflow to `pull_request_target`
  to "fix" that would hand fork code the deploy token.

`/support` links to Ko-fi for running costs. The costs are honest and worth
keeping accurate: Cloudflare's free tier covers everything at this scale, so
the domain is the only standing cost, and SMS is the thing that would change
that — which is why `SMS_PROVIDER` is still `none`. Nothing in the app is ever
gated behind a donation.

## Known gaps

Deliberate, not forgotten:

- **Seeded courts are public city parks only** — 17 courts across five parks,
  each count checked against aerial imagery rather than taken from a listing.
  Schools and private clubs are excluded because access isn't the app's to
  promise. `drizzle/seed.sql` records what was excluded and why, including the
  three sources that disagreed; read it before "correcting" a count back.
- **No map view yet**, though the data is now there for one: every seeded
  location carries a lat/lng aimed at its *courts* rather than the park
  centroid, each checked against the aerial. Distance-based preferences are
  the other thing those unlock.
- **No results or score tracking.** `games.status` already has `completed`, so
  the schema leaves room, but nothing is built.
- **A clinic session can't be rescheduled**, only cancelled and recreated.
  Moving one means rewriting court locks *and* fanning out a calendar update,
  and it is the one path that could strand a player lock. `calendar_seq` is
  already stored so the calendar half is ready when it's worth building.
- **No waitlist for a full clinic.** Full is just full.
- **Clinics carry a cost note, not a payment.** `cost_note` is prose and money
  is settled at the court. Taking payment would mean a PCI surface, refunds and
  payouts to organizers — a different project, and a standing cost the app
  doesn't have.
- **Calendar invites are ICS only.** No Google OAuth: a `.ics` serves Apple and
  Outlook users too, and needs no consent screen, client secret or refresh
  tokens.
- **Other parks are offered whole, not court by court.** A host widening beyond
  their own park has stopped caring which court, and the precision isn't worth
  the interface.
- **The dashboard doesn't separate "not yet placed" games.** Every open game is
  unplaced, so a separate list would be noise rather than information.
- **The e2e suite runs serially by design.** If it gets slow, the fix is
  per-worker databases, not `fullyParallel` — court bookings are global state.

## Judgement calls worth preserving

- Cron *nudges* a host whose game is short rather than auto-cancelling it.
  Three players with an empty doubles seat usually still play, and silently
  deleting someone's game isn't software's call.
- Courts deactivate rather than delete, so a resurfacing closure keeps its
  history rather than erasing the games played there.
- The app never claims to reserve a court with the city. Public park courts are
  first come, first served; the guarantee is only that GameSeeker doesn't send
  two of its own games to one court.
