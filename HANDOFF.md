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

Working and verified:

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
- Outbound notifications on Cloudflare Queues (`TODO.md` item 1, done). Sign-in
  email is deliberately still sent inline.
- Four opt-in formats — singles, mixed singles, doubles, mixed doubles
  (`TODO.md` item 4, done). Mixed is no longer doubles-only.
- Ordered location preferences (`TODO.md` item 2, done). A soft signal: it
  sorts candidates and game lists, it never filters anyone out.
- In-app notification inbox on a Durable Object per player, with a live bell
  in the header, and a live location day view on a Durable Object per location
  (`TODO.md` item 1b phases 2 and 3, done).

**109 unit tests + 46 browser tests + typecheck + build all pass.** Run all four
before and after any change:

```bash
npm test && npm run test:e2e && npm run typecheck && npm run build
# or, with mise: mise run check
```

Deployed and live at https://gameseeker.app.

## Local environment

`mise.toml` pins Node and puts `node_modules/.bin` on PATH, so `wrangler` works
without `npx` once you've run `mise trust`. Wrangler is deliberately *not* a
mise tool — it's pinned in `package.json` and loaded in-process by
`@cloudflare/vite-plugin`, and a second copy on PATH would eventually disagree
with the one building the app.

Two separate local D1 databases, and they must stay separate — see the
`database_id` trap in `CLAUDE.md`:

| Database | Used by | Currently holds |
|---|---|---|
| `gameseeker` | `npm run dev` | demo data, re-seeded 2026-08-15 |
| `gameseeker-test` | `npm run test:e2e` | reset and reseeded on every run |

Setting the real remote `database_id` re-keyed **local** storage as well — local
D1 is keyed by id, so `npm run dev` began pointing at a fresh, unmigrated file
and every query failed. Fixed by running `npm run db:setup && npm run db:demo`
against the new id. The pre-existing local data is still on disk under the old
placeholder id, just not addressed any more. Nothing in either test suite
catches this: unit tests use in-memory D1 and the browser suite has its own id.

`npm run db:demo` refills the dev database with demo players and games. It
clears players and games first, so don't run it when you care about local data.

Useful scripts: `dev`, `test`, `test:e2e`, `test:e2e:ui`, `typecheck`, `build`,
`db:setup`, `db:demo`, `db:reset:local`, `db:generate`, `deploy`.

## Not done yet

**Deployed.** Cloudflare Workers Builds is connected to the repo and deploys on
push to `main`; the custom domain is configured in the Cloudflare dashboard
rather than in `wrangler.jsonc`, so a deploy from a clean checkout would not
reproduce the `gameseeker.app` binding. Remote D1 is migrated and seeded, both
queues exist, `SESSION_SECRET` and `RESEND_API_TOKEN` are set, and sign-in by
email is confirmed working in production.

**Apply migrations remotely before pushing schema-dependent code.** Workers
Builds deploys on push, so a push whose code needs a column the remote database
doesn't have takes production down until the migration lands. All migrations through 0005 are
applied remotely; apply any new one before pushing the code that needs it.

Production config is `APP_URL=https://gameseeker.app`, `MAIL_PROVIDER=resend`,
`MAIL_FROM=noreply@gameseeker.app`. Local dev doesn't use those values:

- `resolveAppUrl` uses the request origin in dev, so the app still works on any
  port.
- `resolveMailProvider` degrades to the console adapter in dev when there's no
  `RESEND_API_TOKEN`, so a fresh clone still signs in by reading the magic link
  off the page. Production deliberately does not degrade — silently logging real
  invitations is worse than a loud failure.

**Seeded court data is unverified.** Counts and addresses were inferred from
public reporting about Santa Fe's tennis inventory. Someone local should check
them; they're editable under Admin → Courts.

## Suggested order of work

The items in `TODO.md` aren't independent. This ordering avoids rework:

1. ~~**Item 1 — queue the email.**~~ Done.
2. ~~**Item 4 — four formats.**~~ Done.
3. ~~**Item 2 — location preferences.**~~ Done.
4. ~~**Item 1b phases 2–3.**~~ Done.
5. **Item 3 — flexible court assignment.** Start here. Largest, and it changes
   the booking invariant; items 2 and 4 are in place, which it depends on.
6. **Item 1b phase 4 — heatmap coalescing.** Only if it's earned its keep.

## Decisions the next session must make

Each is flagged in context in `TODO.md`; collected here so none get missed.

- ~~**Email provider.**~~ Decided: Resend, until volume nears 3,000/month or
  100/day. The Worker secret is named `RESEND_API_TOKEN`.
- ~~**Location preference: filter or sort?**~~ Decided: sort, don't filter.
  Nothing excludes an unranked player.
- **Court holding strategy for flexible games.** Three options in `TODO.md`
  item 3. Recommendation: hold nothing until the game fills, then lock
  atomically — it keeps the database-level guarantee and doesn't block courts
  while a game is still filling. Needs a defined "filled but unplaceable" path.
- ~~**Does availability need a mixed distinction?**~~ Decided: no. `format_pref`
  stays `singles | doubles | either`; format preference lives on the profile.

## Things that will bite you

All of these cost time already; they're in `CLAUDE.md` in more detail.

- Local D1 is keyed by `database_id`, not name. Same id = same file = the test
  suite wipes your dev data.
- Named wrangler environments inherit **nothing** from the top level. A binding
  added at the top has to be repeated under `env.test` or the browser suite
  runs against a differently-shaped Worker than production.
- Durable Objects must use the WebSocket **Hibernation API**, or idle sockets
  bill duration continuously.
- Durable Object migration tags are **append-only**. A new class needs a new
  tag; editing a shipped one is not allowed.
- Never step days with `+ 86400000`. DST days are 23 and 25 hours.
- Anything clickable inside a time grid needs `data-entry`, or the drag handler
  eats its click.
- Treat browser-test flakes as bugs. Every one so far has been a real defect —
  most recently, the create form could be submitted mid-refetch and book a court
  at the wrong location.
