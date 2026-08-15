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

## 1b. Realtime updates and an in-app notification inbox

Full design in **`docs/realtime.md`**. Summary:

- Two Durable Object classes: `LocationHub` (one per location, broadcasts
  calendar changes to viewers) and `PlayerInbox` (one per player, durable
  notification queue plus that player's live sockets across devices).
- Events say *what changed*, not how; clients call `router.invalidate()` and
  refetch through existing loaders.
- WebSocket **Hibernation API** is mandatory or idle sockets bill duration
  continuously.
- Realtime goes direct to the DO, not through the queue — queues batch in
  seconds and a laggy calendar feels broken. Email is what gets queued.
- Both Durable Objects and Queues are on the free tier, so this doesn't change
  the operating cost.

Phasing, each independently shippable: ~~queue the email~~ (done, item 1) →
`PlayerInbox` + bell UI → `LocationHub` + live calendar → heatmap coalescing
(cut this first if scope is tight; a periodic refetch gets most of the value).

---

## 2. Players pick multiple preferred locations, in priority order

Today a player has one optional `home_location_id` and it isn't used for
matching at all.

**Model.** New table rather than a JSON column, because ordering and joins both
matter here:

```
user_locations(user_id, location_id, rank)   -- PK (user_id, location_id)
```

`rank` 0 = most preferred. Drop `users.home_location_id` (migration should
backfill it as the single rank-0 row).

**Where it's used**
- `findCandidates` — either filter to players who listed the location, or keep
  notifying everyone and sort by rank so nearest-preference players are
  messaged first. Decide which; filtering is stricter but risks a small pool
  going quiet, so a **soft** preference (sort, don't filter) is probably right
  for a town this size. Make it explicit either way.
- The dashboard's "open at your level" list should sort by preference.
- The heatmap could filter demand to a location's interested players.

**UI.** Profile section with a drag-to-reorder list. `useColumnDrag` isn't the
right tool; a simple up/down arrow list is honest and accessible, and avoids a
drag library.

**Tests.** Unit: candidate ordering respects rank. E2E: set two locations, check
the dashboard ordering.

---

## 3. Flexible game creation: several locations/courts, assign on fill

Today a host picks exactly one court up front and it's locked immediately.
The goal: pick *several* acceptable locations/courts, and once the game fills,
assign the actual court from what everyone prefers and what's still free.

This is the largest item here and it changes the booking invariant, so plan it
before coding.

**The hard part.** The current guarantee is that creating a game holds its court
atomically (see `CLAUDE.md`). If a game no longer holds a court at creation
time, two filling games can converge on the last free court. Options:

- **Hold every candidate court, release the losers on assignment.** Keeps the
  existing lock mechanism and stays race-free, but a host offering five courts
  blocks all five for everyone else until the game fills. Unacceptable at a
  five-park town scale.
- **Hold nothing until assignment, then lock atomically.** Assignment is the
  same `batch()` insert that exists today, so the race is still settled by the
  primary key — it just moves later. Risk: a game fills and then *can't* be
  placed because every candidate court went. Needs a defined fallback (notify
  host, offer alternatives, or auto-widen).
- **Soft hold with expiry.** A `court_holds` table with a TTL, swept by the
  existing cron. Most forgiving, most moving parts.

Recommend the second, with an explicit unplaceable path. It preserves the
database-level guarantee and keeps courts available while a game is still
filling — which is the common case.

**Model sketch**
```
games.court_id            -> nullable; set at assignment
game_court_options(game_id, court_id, rank)
games.status              -> add 'filling' / 'unplaceable'
```

**Assignment.** On the claim that fills the last seat: score each candidate
court by summed participant location preference (item 2), filter to still-free,
pick the best, insert locks + set `court_id` in one `batch()`. On failure,
fall to `unplaceable` and notify the host.

**Knock-on work:** `CourtDayGrid` and the location day view assume a game has a
court; unassigned games need somewhere to live (a "not yet placed" list on the
dashboard is probably enough). Notification templates mention the court, so
they need a pre-assignment variant.

**Tests.** Concurrent fills competing for one remaining court → exactly one
placed, the other `unplaceable`. Preference scoring picks the right court.

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
