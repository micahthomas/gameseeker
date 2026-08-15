# Next up

Queued work. Each item has enough context to start cold.

Read `HANDOFF.md` for current state and the suggested order, and `CLAUDE.md`
for architecture and testing practices.

---

## 1. Queue outbound email, and keep sending over REST

**Decided:** REST, not SMTP. See `docs/realtime.md` for the full design; the
short version is that SMTP from inside a Worker needs `cloudflare:sockets` plus
a hand-rolled client (nodemailer assumes Node's `net`/`tls`), whereas REST is a
plain `fetch` — which `resend.ts` already is. Portability comes from the
`MailAdapter` interface, not the wire protocol.

**Also decided:** notifications go through **Cloudflare Queues** so a host
posting a game doesn't wait on twenty email round trips. Queues joined the free
plan in February 2026 (10,000 operations/day, 24h retention), so this costs
nothing.

**Still open: which provider.**

| | Cost |
|---|---|
| Resend — wired up today | $0 (3,000/mo, 100/day), needs a verified domain |
| [Cloudflare Email Service](https://developers.cloudflare.com/email-service/get-started/send-emails/) | Workers **Paid**: $5/mo, 3,000 included, then $0.35/1,000; domain must be on Cloudflare DNS |

Recommendation: stay on Resend. It's free and already built; the only thing
Cloudflare buys is one fewer vendor, for $5/month. Revisit near the 3,000/month
or 100/day ceiling.

*(Correcting this repo's history: Cloudflare Email Service reached public beta
in April 2026 and does send to arbitrary recipients. The old inbound-only
limitation was Email Routing. The README is already corrected.)*

**Acceptance**
- `postGame` returns without waiting on delivery; the fan-out happens in a
  queue consumer.
- Notification rows are still inserted *before* enqueueing, so the existing
  unique index on `(user_id, game_id)` keeps at-least-once delivery from
  double-sending.
- The consumer re-reads game state before rendering, so a cancelled game can't
  produce a stale invitation.
- Cron reminders enqueue rather than send inline.
- Console adapter still the default; local dev needs no accounts.

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

Phasing, each independently shippable: queue the email → `PlayerInbox` + bell
UI → `LocationHub` + live calendar → heatmap coalescing (cut this first if
scope is tight; a periodic refetch gets most of the value).

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

## 4. Four formats, with mixed as an opt-in inside each

Today: `plays_singles` / `plays_doubles` booleans plus a single `plays_mixed`,
and `games.is_mixed` only valid for doubles.

Target: a player opts into **singles, mixed singles, doubles, mixed doubles**
independently. When creating a game the host picks singles *or* doubles, then
ticks whether mixed players are welcome within that.

**Model.** Replace the three booleans with a set, which also removes the
awkward "mixed only means doubles" special case:

```
users.formats  JSON: ('singles' | 'mixed_singles' | 'doubles' | 'mixed_doubles')[]
games.is_mixed stays; (format, is_mixed) maps onto the four
```

Migration backfills from the existing booleans — a player with
`plays_doubles && plays_mixed` gets `doubles` and `mixed_doubles`.

**Touch points**
- `findCandidates` — the `plays_singles`/`plays_doubles` column check and the
  `plays_mixed` clause collapse into one membership test against `formats`.
- `availability_rules.format_pref` / `availability_blocks.format_pref` are
  currently `singles | doubles | either`. Decide whether availability should
  distinguish mixed too, or stay coarse. Coarse is probably right — availability
  is about *when*, and format preference already lives on the profile.
- `mixedSeatGenders()` needs a singles variant: mixed singles is one of each,
  so the single open seat takes the opposite gender to the host.
- Profile UI: four checkboxes replacing the current three.
- Create-game UI: format toggle, then an "open to mixed" checkbox in both
  branches (today it's hidden for singles).

**Tests.** Extend the existing mixed suites in `test/games.test.ts`,
`test/matching.test.ts` and `e2e/games.spec.ts` — they already cover mixed
doubles, so mirror each for mixed singles.

---

## Smaller things noticed along the way

- `seed.sql` court counts and addresses are inferred from public reporting, not
  verified. Someone local should check them against reality.
- Location coordinates are `NULL`; filling them in would enable a map view and
  distance-based location preferences (item 2).
- No results/score tracking. The schema leaves room (`games.status` already has
  `completed`) but nothing is built.
- `e2e` runs serially by design. If the suite gets slow, the fix is per-worker
  databases, not `fullyParallel`.
