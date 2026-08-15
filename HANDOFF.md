# Handoff

Start here. This orients a new session; the detail lives in the documents it
points at.

## Read in this order

1. **`README.md`** — what the app is, how to run it, how to deploy.
2. **`CLAUDE.md`** — architecture, invariants that must not be "improved",
   testing practices. Read before touching code.
3. **`TODO.md`** — the queued work, each item with enough context to start cold.
4. **`docs/realtime.md`** — full design for queues + Durable Objects. Read
   before writing any of item 1 or 1b.

## Where things stand

Working and verified as of commit `84ccc07`:

- Sign-in by magic link, profiles with opt-in NTRP levels, gender and mixed
  preferences.
- Drag-select availability calendar (Monday-start, real dates, repeat / one-off
  / time off).
- Game hosting with atomic court locking, level matching, claiming, cancelling,
  mixed doubles with balanced seats.
- Location day view: a column per court, games labelled by who's playing,
  drag-to-host, and an availability heatmap.
- Admin screens for locations, courts, and promoting admins.
- Cron: day-before reminders, short-handed-host nudges, cleanup.

**64 unit tests + 39 browser tests + typecheck + build all pass.** Run all four
before and after any change:

```bash
npm test && npm run test:e2e && npm run typecheck && npm run build
```

Working tree is clean, everything is committed, nothing is deployed.

## Local environment

Two separate local D1 databases, and they must stay separate — see the
`database_id` trap in `CLAUDE.md`:

| Database | Used by | Currently holds |
|---|---|---|
| `gameseeker` | `npm run dev` | 38 players, 36 games, 8 locations, 26 courts |
| `gameseeker-test` | `npm run test:e2e` | reset and reseeded on every run |

`npm run db:demo` refills the dev database with demo players and games. It
clears players and games first, so don't run it when you care about local data.

Useful scripts: `dev`, `test`, `test:e2e`, `test:e2e:ui`, `typecheck`, `build`,
`db:setup`, `db:demo`, `db:reset:local`, `db:generate`, `deploy`.

## Not done yet

**Never deployed.** `wrangler.jsonc` line 20 still has
`"database_id": "REPLACE_WITH_YOUR_D1_DATABASE_ID"`. Before a first deploy:

```bash
npx wrangler d1 create gameseeker      # paste the id into wrangler.jsonc
npm run db:migrate:remote
npm run db:seed:remote
npx wrangler secret put SESSION_SECRET # 32+ random characters
npm run deploy
```

Then set `APP_URL` in `wrangler.jsonc` to the real URL — magic-link and claim
links are built from it in production — and redeploy.

**Seeded court data is unverified.** Counts and addresses were inferred from
public reporting about Santa Fe's tennis inventory. Someone local should check
them; they're editable under Admin → Courts.

## Suggested order of work

The items in `TODO.md` aren't independent. This ordering avoids rework:

1. **Item 1 — queue the email.** Self-contained, no Durable Objects, and it
   removes the fan-out from the request path. Best first move.
2. **Item 4 — four formats.** Touches the same matching query as everything
   else, and it's cheaper to change before more depends on it.
3. **Item 2 — location preferences.** Item 3 needs it for scoring, and it makes
   the heatmap's fan-out story clean.
4. **Item 1b phases 2–3 — `PlayerInbox` then `LocationHub`.** Highest user
   value; the inbox is what makes the app worth leaving open.
5. **Item 3 — flexible court assignment.** Largest, and it changes the booking
   invariant. Do it last, with items 2 and 4 already in place.
6. **Item 1b phase 4 — heatmap coalescing.** Only if it's earned its keep.

## Decisions the next session must make

Each is flagged in context in `TODO.md`; collected here so none get missed.

- **Email provider.** Resend ($0, already built) or Cloudflare Email Service
  ($5/mo, one fewer vendor). Recommendation: stay on Resend until volume nears
  3,000/month.
- **Location preference: filter or sort?** Filtering candidates to players who
  listed the location is stricter but risks a small pool going quiet. A soft
  preference (sort, don't filter) is probably right at town scale.
- **Court holding strategy for flexible games.** Three options in `TODO.md`
  item 3. Recommendation: hold nothing until the game fills, then lock
  atomically — it keeps the database-level guarantee and doesn't block courts
  while a game is still filling. Needs a defined "filled but unplaceable" path.
- **Does availability need a mixed distinction?** Probably not — availability is
  about *when*, and format preference already lives on the profile.

## Things that will bite you

All of these cost time already; they're in `CLAUDE.md` in more detail.

- Local D1 is keyed by `database_id`, not name. Same id = same file = the test
  suite wipes your dev data.
- Durable Objects must use the WebSocket **Hibernation API**, or idle sockets
  bill duration continuously.
- Never step days with `+ 86400000`. DST days are 23 and 25 hours.
- Anything clickable inside a time grid needs `data-entry`, or the drag handler
  eats its click.
- Treat browser-test flakes as bugs. Every one so far has been a real defect —
  most recently, the create form could be submitted mid-refetch and book a court
  at the wrong location.
