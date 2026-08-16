# Next up

Queued work. Each item has enough context to start cold.

Read `HANDOFF.md` for current state and the suggested order, and `CLAUDE.md`
for architecture and testing practices.

---

## 1. Queue outbound email — **done**

Built. `src/server/notify/queue.ts` is the producer and consumer; the `queue`
export in `src/server.ts` wires it up; bindings are in `wrangler.jsonc` (and
repeated under `env.test`, since named environments inherit nothing). Covered by
`test/notify.test.ts`. See the "Sending is queued" section of `CLAUDE.md`.

**Provider decided: Resend.** Free at 3,000/month and 100/day, already
implemented, and the only thing Cloudflare Email Service buys is one fewer
vendor for $5/month. Revisit near either ceiling. The secret is
`RESEND_API_TOKEN` — note the name, Resend's own docs call it an API key.

Still to do before it sends anything for real, all at first deploy:

- `wrangler queues create gameseeker-notifications` and `…-dlq`.
- Verify a sending domain with Resend and set `MAIL_FROM` to an address on it.
- Flip `MAIL_PROVIDER` to `"resend"` in `wrangler.jsonc`, in the same edit that
  sets the real `APP_URL`. It stays `"console"` in the committed config so a
  fresh clone develops without accounts.

*(Correcting this repo's history: Cloudflare Email Service reached public beta
in April 2026 and does send to arbitrary recipients. The old inbound-only
limitation was Email Routing. The README is already corrected.)*

---

## 1b. Realtime — inbox and live calendar done, coalescing optional

Full design in **`docs/realtime.md`**. Phase 2 is built:

**Done — `PlayerInbox` + bell.** One Durable Object per player
(`src/server/live/`), inbox in DO SQLite, WebSocket hibernation, bell in the
header with an unread badge. Pushed at the same call sites that enqueue email:
inbox first (direct, milliseconds), email second (queued, seconds). Covered by
`test/inbox.test.ts` and `e2e/inbox.spec.ts` — the latter parks a host on their
dashboard and asserts the badge appears when someone else claims a seat,
without a reload.

One correction to the design doc: the socket authenticates with a short-lived
signed **ticket**, not the session cookie. `/api/live/inbox` runs before
Start's handler, so it has no request context to read the cookie from. See
"Why the socket uses a ticket" in `CLAUDE.md`.

**Done — `LocationHub` + live calendar.** One ephemeral DO per location
broadcasting `game.changed` on create, claim, drop-out and cancel; the day view
calls `router.invalidate()` and refetches through its existing loader. Both
channels share `useLiveChannel`. Covered by `e2e/inbox.spec.ts`, which parks a
calendar in one browser context and posts a game from another — and that test
was checked against a disabled broadcast to confirm it actually fails without
the feature.

**Done, by not building it — heatmap coalescing.** The day view refetches
demand every 60 seconds while the tab is visible, and on `visibilitychange`.
That was the "cut this first" option and it was the right one: no `demand.changed`
event, no fan-out to every location's hub, no debounce alarm. Revisit only if
someone complains the heatmap is stale, which would be surprising for a number
answering "roughly how many people are free then".

---

## 2. Location preferences — **done**

`user_locations(user_id, location_id, rank)` with `users.home_location_id`
dropped and backfilled as each player's single rank-0 row. Migration
`0005_add_user_locations`; logic in `src/server/preferences.ts`, summarised
under "Location preference" in `CLAUDE.md`.

**Decided: soft preference — sort, don't filter.** `findCandidates` orders by
rank before level closeness and `listOpenGamesFor` orders by rank before start
time, but nothing excludes an unranked player. At five parks and town-scale
numbers, filtering risks a small pool going quiet, which is worse than an
imperfectly ordered invitation list. Revisit if the player base grows enough
that people are getting games too far away to be worth the message.

Not done, deliberately: the heatmap still counts all availability rather than
filtering demand to a location's interested players. It's advisory, and
filtering it would make a quiet park look quieter than it is.

UI is an up/down arrow list rather than drag — keyboard- and screen-reader
friendly, works on a phone at the court, no drag library.

---

## 3. Flexible court assignment — **done**

A host offers several courts; the game holds none of them and takes one when
its last seat fills. Migration `0007_flexible_courts`, logic in
`src/server/assign.ts`, summarised under invariant 1 in `CLAUDE.md`.

**Decided: hold nothing until the game fills**, the middle option of the three
originally listed. The court is assigned in the same single `batch()` that
`createGame` used to run, so the primary key on `court_slot_locks` still
settles the race — it just settles it later.

The failure mode it introduces is a game that fills and then cannot be placed.
That is `unplaceable`: the host is emailed and told to move the time or offer
more courts, and the game keeps its players. It is never silently cancelled.

Mitigation, and worth keeping: the create form ticks **every** other free court
as a backup by default. Nothing is held either way, so a longer list only makes
placement likelier. Without it, two games at the same hour reliably left the
second one unplaceable.

Related, done at the same time: **`player_slot_locks`** stops one player being
in two overlapping games. Nothing prevented that before; the matching query
left already-booked players out of notifications, but claiming and hosting were
unguarded.

Hosts can offer courts across several parks: the create form lists every
location with a free court for that window, and ticking one appends its courts
after the host's own location's. Covered by a browser test that fills both
courts at one park and watches a game fall through to another.

Still open, and deliberately not built:

- The dashboard doesn't group "not yet placed" games separately. They read
  fine as ordinary open games, and every open game is unplaced, so a separate
  list would be noise.
- Other parks are ticked whole, not court by court. Picking individual courts
  at a second location would be more precise and almost certainly not worth
  the interface — a host widening beyond their own park has stopped caring
  which court.

---

## 4. Four formats — **done**

`users.formats` is a JSON set of `singles | mixed_singles | doubles |
mixed_doubles`, replacing `plays_singles` / `plays_doubles` / `plays_mixed`.
Migrations `0003_add_player_formats` (add + backfill) and
`0004_drop_play_booleans`; the rules live in `src/server/formats.ts` and are
summarised under "Formats" in `CLAUDE.md`.

Decisions made along the way:

- **The backfill does not grant `mixed_singles`.** `plays_mixed` only ever
  meant doubles, and this app never opts a player into something they didn't
  say. Verified against 36 real rows in the dev database: nobody received it.
- **Availability's `format_pref` stayed coarse** (`singles | doubles | either`),
  as recommended — availability is about *when*, and format preference already
  lives on the profile.
- **Claiming still gates mixed only**, not plain singles/doubles, preserving the
  old `plays_mixed` behaviour rather than quietly tightening who can join a game.
- **New players start with all four**, matching the old booleans' defaults; they
  narrow it in the profile form.

## Smaller things noticed along the way

- `seed.sql` court counts and addresses are inferred from public reporting, not
  verified. Someone local should check them against reality.
- Location coordinates are `NULL`; filling them in would enable a map view and
  distance-based location preferences (item 2).
- No results/score tracking. The schema leaves room (`games.status` already has
  `completed`) but nothing is built.
- `e2e` runs serially by design. If the suite gets slow, the fix is per-worker
  databases, not `fullyParallel`.
