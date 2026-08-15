# Next up

Handoff notes. Each item has enough context to start cold — read `CLAUDE.md`
first for architecture and testing practices.

---

## 1. Send email through Cloudflare Email Service, over SMTP

**Correction to an earlier claim in this repo's history:** Cloudflare *can* now
send outbound email to arbitrary recipients. [Cloudflare Email Service](https://developers.cloudflare.com/email-service/get-started/send-emails/)
went to public beta in April 2026 and offers three interfaces — a Workers
`send_email` binding, a REST API, and authenticated SMTP. The old limitation
(Email Routing being inbound-only, the `send_email` binding only reaching
pre-verified addresses) no longer applies. Earlier commit messages and any
stale README wording should be corrected as part of this work.

**Cost — decide this first.** It is not free, and "free to operate" was the
original constraint:

| | Cost |
|---|---|
| Cloudflare Email Service | Workers **Paid** required: $5/mo, 3,000 emails included, then $0.35/1,000 |
| Resend (wired up today) | $0 — 3,000/mo, 100/day, needs a verified domain |

At small-town volume both cover the traffic. Cloudflare buys you one vendor and
one dashboard; Resend stays at zero. Worth a conscious decision rather than
drifting onto the paid plan.

**Requirements**
- The sending domain must use **Cloudflare DNS** and be onboarded in the
  dashboard before sending. Propagation is typically 5–15 minutes.
- SMTP endpoint is `smtps://smtp.mx.cloudflare.net:465`, authenticating with an
  API token carrying the **Email Sending: Edit** permission.

**Do it as an SMTP adapter, per the stated preference for portability.** The
existing `MailAdapter` interface (`src/server/notify/types.ts`) already gives
code-level swappability, so this adds *protocol*-level portability: an SMTP
adapter works against Cloudflare, Resend, SES, Postmark or a local Mailpit with
only credentials changing.

**One real wrinkle to plan for.** Workers can't open arbitrary TCP sockets the
way Node can. SMTP from inside a Worker means `connect()` from
`cloudflare:sockets` plus an SMTP client that works on that primitive — there
is no built-in one, and most npm SMTP libraries (nodemailer et al) assume Node
`net`/`tls` and won't run on workerd. Options, in order of pragmatism:

1. **SMTP adapter over `cloudflare:sockets`** — true portability, most work.
   Verify TLS-on-connect (implicit TLS on 465) is supported by the runtime
   before committing; `startTls()` exists on the socket API for STARTTLS on 587.
2. **Cloudflare `send_email` binding** — least code, but Cloudflare-specific,
   which is exactly what the SMTP preference is trying to avoid.
3. **REST adapter** — a near-copy of `resend.ts`; portable-ish, still per-vendor.

Suggest spiking (1) behind the existing interface and keeping `resend.ts` as
the fallback until it's proven.

**Acceptance**
- `MAIL_PROVIDER=smtp` with host/port/user/pass config sends real mail.
- Console adapter still the default, so local dev needs no accounts.
- Existing notify tests pass unchanged; add one asserting the adapter is
  selected from config.
- README's "Turning on real email" section rewritten, including the cost table.

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
