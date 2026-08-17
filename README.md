# Santa Fe Tennis GameSeeker

<!-- Contributors: CLAUDE.md covers architecture, invariants and testing. -->

Find a tennis game in Santa Fe. Players post the times they're free; when
someone hosts a game at their level in one of those windows, they get a
message. First to confirm gets the spot.

Runs entirely on Cloudflare's free tier — Workers, D1, and Cron Triggers.

## How it works

1. **Sign in** with an emailed magic link. No passwords.
2. **Set your level** — NTRP or UTR (UTR is converted to an NTRP equivalent so
   everyone is matched on one scale), then tick every level you're *willing* to
   play. A 3.5 happy to play up ticks 3.5 and 4.0 and hears about both; one who
   isn't ticks only 3.5 and is never stretched. Matching is opt-in, not a band
   guessed around your rating.
3. **Post your times** — drag on a week calendar to paint availability. Each
   selection can repeat every week, apply to that date only, or mark time off
   that overrides the repeating pattern.
4. **Host a game** — pick a time, a format, and every court you'd accept,
   across as many parks as you like. For each empty seat, either invite a
   specific player or open it to a *GameSeeker* at a level (3.0, 3.5, 4.0…).
   A location's day view shades each half hour by how many players are free
   then, so you can put the game where the people are.
5. **The court is decided when the game fills.** Nothing is held while a game
   is still looking for players, so a court nobody ends up using is never
   blocked for everyone else. The moment the last seat goes, the game takes the
   best court still free from the ones offered.
6. **The right people hear about it.** Everyone who opted into that level, who
   plays that format, and whose posted availability covers the whole window
   gets a message with a claim link. First to confirm takes the seat.

**Contact details are never shown to other players.** A game page is readable
by anyone with the link, so it lists names and levels only. Phone numbers exist
solely to text you about your own games.

**Mixed** is a toggle on either format: mixed doubles is two of each, mixed
singles is one of each. Seats are set from the host's division, and only players
who opted into that exact format are messaged. Players opt into any of singles,
mixed singles, doubles and mixed doubles independently.

The profile asks **which you play — men's or women's tennis** — rather than
asking your gender. That's the only thing a mixed game needs to know, it's a
question players already answer in tennis terms, and it means the app doesn't
store gender at all. Anyone can pick either division. It's optional, and leaving
it unset costs you nothing except seats that exist specifically to hold one side
of a mixed game.

### Three rules the database enforces, not the code

- **One game per court per time.** Courts are held in 30-minute granules in
  `court_slot_locks`, whose composite primary key makes a double-booking a
  constraint violation. The court locks and the game's `court_id` go in through
  a single D1 `batch()` — one transaction — at the moment the game fills, so
  two games filling at once can't both take the last court.
- **One player, one game at a time.** The same trick in `player_slot_locks`,
  keyed on `(user_id, slot_start)`, so you can't hold seats in two overlapping
  games.
- **One winner per seat.** Claiming runs
  `UPDATE ... WHERE filled_by_user_id IS NULL RETURNING *`. A second claimant
  updates zero rows and gets a clean "someone just took it" instead of
  overwriting the winner.

All three are covered by tests that fire concurrent requests and assert exactly
one succeeds.

A game that fills and finds every court it offered has gone is marked
**unplaceable** rather than cancelled: it still has its players, so the host is
emailed and asked to move the time or offer more courts.

> The app does not reserve courts with the City of Santa Fe. Public park courts
> are first come, first served. This guarantees only that GameSeeker never
> sends two of its own games to the same court.

## Getting started

```bash
npm install
npm run db:setup      # apply migrations + seed Santa Fe courts, locally
npm run db:demo       # optional: 36 demo players and a week of games
npm run dev           # http://localhost:3000
```

If you use [mise](https://mise.jdx.dev), `mise trust && mise run setup` does the
first two steps and pins Node to the version this project is built against. It
also puts `node_modules/.bin` on your PATH, so `wrangler` and friends work
without `npx`.

`npm run db:demo` fills the local database with four players at every NTRP
level (each with availability posted) and books games across the coming week —
a mix of singles, doubles, and mixed. It prints a few addresses you can sign in
as; the magic link appears in the dev console. It clears players and games
first, so don't run it when you care about local data.

No accounts or API keys needed to develop. With no `RESEND_API_TOKEN` present,
development falls back to the console adapter, which prints messages to the
Worker log instead of sending them — and the sign-in screen shows you the magic
link directly.

### Make yourself an admin

Admins manage locations and courts. Sign in once, then:

```bash
npx wrangler d1 execute gameseeker --local \
  --command="UPDATE users SET is_admin = 1 WHERE email = 'you@example.com'"
```

## Verifying

```bash
npm test          # 139 unit tests: races, matching, formats, DST, queue, inbox
npm run test:e2e  # 50 browser tests through the real UI
npm run typecheck
```

Or `mise run check`, which runs all of those plus the production build.

`npm test` runs inside workerd against a real D1, so the atomicity guarantees
above are tested rather than mocked.

`npm run test:e2e` drives Chromium (plus a phone-sized pass over the journeys
tagged `@mobile`) through the actual pages: signing in by magic link, painting
availability by dragging, hosting, matching, claiming, mixed-doubles balance,
the demand heatmap, and the admin screens. It starts its own dev server on
port 3100 bound to a **separate `gameseeker-test` database**, so running it
never touches your development data or signs you out.

> Local D1 is keyed by `database_id`, not by database name. If you ever change
> those ids, keep the two environments' ids distinct — sharing one (including
> sharing the same placeholder) silently puts both in a single SQLite file, and
> the suite's reset will wipe your development data.

`npm run test:e2e:ui` opens the Playwright inspector.

## Deploying

Live at **https://gameseeker.app**. GitHub Actions
(`.github/workflows/ci.yml`) deploys on every push to `main`:

```
build → typecheck → unit tests → browser tests → D1 migrations → deploy
```

The build runs first because two files typecheck needs are generated rather
than committed: `worker-configuration.d.ts` (from `wrangler types`) and
`src/routeTree.gen.ts` (written by the router plugin during a build).

Pull requests run everything up to and including the build, and stop there.
There is no deploy step to run by hand.

**Migrations run before the deploy on purpose.** Code that expects a column the
remote database hasn't got takes production down until the migration lands, so
the pipeline never lets the deploy get there first. The reverse case still needs
a human: a *destructive* migration breaks the running code from the moment it
applies until the deploy finishes. When that window matters, ship code that
tolerates both shapes first and drop the column in a later release.

Two things to know about the setup:

- It needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as repository
  secrets. The token is an account-scoped custom token with three permissions:
  **Workers Scripts → Edit** (the script, its Durable Object classes and their
  migrations, the cron triggers), **D1 → Edit** (`migrations apply --remote`
  writes), and **Queues → Edit** — the last is easy to miss, because this Worker
  is a queue *consumer*, so deploying registers the consumer and its DLQ. No
  zone permissions: the custom domain lives in the dashboard, not in
  `wrangler.jsonc`. Tests need no credentials at all — they run entirely against
  a local D1.
- **Cloudflare Workers Builds must stay disconnected.** With both connected,
  every push deploys twice, and the Workers Builds deploy lands first — without
  running the tests, and ahead of its migrations.

The custom domain is configured in the Cloudflare dashboard rather than in
`wrangler.jsonc`, so a deploy from a fresh checkout would serve on
`*.workers.dev` until that binding is set up again.

### Starting from scratch

Only needed for a fork, or if the account is ever rebuilt:

```bash
npx wrangler d1 create gameseeker      # copy the database_id into wrangler.jsonc
npm run db:migrate:remote
npm run db:seed:remote

# Outbound notifications are queued, so the queues have to exist.
npx wrangler queues create gameseeker-notifications
npx wrangler queues create gameseeker-notifications-dlq

mise run secrets:session               # or: wrangler secret put SESSION_SECRET
mise run secrets:push                  # RESEND_API_TOKEN, out of 1Password
npm run deploy
```

Then point `APP_URL` and `MAIL_FROM` in `wrangler.jsonc` at the real domain —
they're what magic-link and claim links are built from — and add the custom
domain in the Cloudflare dashboard.

### Turning on real email

Delivery goes through a swappable adapter (`src/server/notify/`), so switching
provider is configuration rather than a rewrite.

Two options worth knowing about:

- **[Resend](https://resend.com)** — free: 3,000/month, 100/day. Wired up
  today. Needs a verified domain.
- **[Cloudflare Email Service](https://developers.cloudflare.com/email-service/get-started/send-emails/)**
  — public beta since April 2026, sends to arbitrary recipients via a Workers
  binding, REST, or SMTP. Requires Workers **Paid** ($5/month, 3,000 emails
  included, then $0.35/1,000) and the domain on Cloudflare DNS. Not wired up:
  Resend is free and already works, and the only thing this buys is one fewer
  vendor. Worth revisiting near Resend's 3,000/month or 100/day ceiling.

  Note this supersedes an older limitation: Email *Routing* is inbound-only and
  its `send_email` binding only reached pre-verified addresses, which is why
  this project originally routed around Cloudflare for outbound mail.

To use Resend:

1. Add and verify your domain in the Resend dashboard.
2. Set `MAIL_FROM` in `wrangler.jsonc` to an address on that domain.
3. `npx wrangler secret put RESEND_API_TOKEN` — or `mise run secrets:push`,
   which reads it out of 1Password.
4. Set `MAIL_PROVIDER` to `"resend"` in `wrangler.jsonc`, then redeploy.

`MAIL_PROVIDER` is `"resend"` in the committed config, because that is the
production value. A fresh clone still develops without any accounts: with no
`RESEND_API_TOKEN` present, development falls back to the console adapter and
prints the magic link, which is what makes sign-in work locally. Production
deliberately does *not* fall back — quietly logging real invitations where
nobody reads them is worse than a loud delivery failure. See
`resolveMailProvider`.

To send through Resend from a local dev server, `mise run secrets:dev` writes a
gitignored `.dev.vars` with the token in it; uncomment the `MAIL_PROVIDER` line
in that file to actually deliver rather than log.

### Turning on SMS

Twilio is implemented and switched off (it isn't free — roughly $0.008 per
message plus about $1.15/month for a number). See `src/server/notify/twilio.ts`
for the four steps. Players still opt in individually in their profile.

## Scheduled jobs

Cron triggers are configured in `wrangler.jsonc`:

- **Hourly** — day-before reminders; a nudge to hosts whose game is still short
  a few hours out; expiring stale claim links.
- **Daily** — marking finished games complete, purging expired sessions and
  tokens.

The host nudge is deliberately a nudge and not an auto-cancel. Three players
with one empty doubles seat usually still play, and quietly deleting someone's
game isn't a decision software should make on its own.

## Layout

```
src/
  db/schema.ts          Data model (Drizzle + D1)
  server/               Business logic — no HTTP, directly unit-testable
    games.ts            Creation, court locking, claiming, cancelling
    matching.ts         Who hears about a new game
    availability.ts     Recurring rules, one-offs, blackouts, coverage SQL
    booking.ts          Court occupancy
    rating.ts           NTRP/UTR normalization
    time.ts             America/Denver conversions (DST-aware)
    auth.ts             Magic links and sessions
    cron.ts             Scheduled jobs
    notify/             Swappable delivery: console, Resend, Twilio
  fn/                   Server functions the UI calls
  components/
    timeGrid.tsx        Shared grid geometry, drag selection, popovers
    WeekCalendar.tsx    Availability week view (columns are days)
    CourtDayGrid.tsx    Location day view (columns are courts)
  routes/               Pages
  server.ts             Worker entry (fetch + scheduled)
drizzle/
  migrations/           Generated by `npm run db:generate`
  seed.sql              Santa Fe locations and courts
  reset.sql             Clears player/game data, keeps courts
e2e/                    Playwright browser tests
scripts/seed-demo.mjs   Demo players and games for local development
```

## About the seeded courts

Public city park courts only — 17 across Bicentennial / Alto (5), Salvador Perez
(4), Herb Martinez / La Resolana (4), Larragoite (2), and Atalaya (2). Every one
is free and first come, first served, which is the promise the app makes.

School courts (Santa Fe High, Capital High, SFCC, St. John's) and private clubs
(El Gancho, Las Campanas, Santa Fe Tennis & Swim, Quail Run) are left out on
purpose: they're real, but access is at the owner's discretion, so posting a
game there would invite players somewhere they may not get in.

Four places that look like they belong and don't: **Fort Marcy** (its two tennis
courts became pickleball), **Genoveva Chavez Center** (racquetball, not tennis),
**Gen. Franklin E. Miles Park** (ball fields and a skate park, no tennis), and
**Shellaberger Tennis Center** (closed in 2022 and sold — it still appears in
most tennis directories, which is where much of the bad Santa Fe court data
comes from).

Counts were checked park by park against aerial imagery rather than taken from
listings, because the listings disagree: the city's 2014 inventory has Salvador
Perez and Larragoite transposed, and OpenStreetMap over-counts Atalaya.

Correct anything that's drifted under **Admin → Courts**. Courts closed for
resurfacing can be deactivated rather than deleted, so existing games keep
their history. Coordinates point at each park's courts rather than its centroid,
so a future map pin lands where the tennis actually is — these parks are big
enough that the centroid is a different walk.
