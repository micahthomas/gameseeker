# Santa Fe Tennis GameSeeker

Find a tennis game in Santa Fe. Players post the times they're free; when
someone hosts a game at their level in one of those windows, they get a
message. First to confirm gets the spot.

Runs entirely on Cloudflare's free tier — Workers, D1, and Cron Triggers.

## How it works

1. **Sign in** with an emailed magic link. No passwords.
2. **Set your level** — NTRP or UTR. UTR is converted to an NTRP equivalent so
   everyone is matched on one scale.
3. **Post your times** — a weekly pattern ("Tuesdays and Thursdays, 5–7"),
   one-off windows, and blackouts when you're away.
4. **Host a game** — pick a location, court, time, and format. For each empty
   seat, either invite a specific player or open it to a *GameSeeker* at a
   level (3.0, 3.5, 4.0…).
5. **The right people hear about it.** Everyone whose level matches, who plays
   that format, and whose posted availability covers the whole window gets a
   message with a claim link. First to confirm takes the seat.

### Two rules the database enforces, not the code

- **One game per court per time.** Courts are held in 30-minute granules in
  `court_slot_locks`, whose composite primary key makes a double-booking a
  constraint violation. The game row, its seats, and its court locks all go in
  through a single D1 `batch()` — one transaction — so a losing race leaves no
  orphaned game behind.
- **One winner per seat.** Claiming runs
  `UPDATE ... WHERE filled_by_user_id IS NULL RETURNING *`. A second claimant
  updates zero rows and gets a clean "someone just took it" instead of
  overwriting the winner.

Both are covered by tests that fire concurrent requests and assert exactly one
succeeds.

> The app does not reserve courts with the City of Santa Fe. Public park courts
> are first come, first served. This guarantees only that GameSeeker never
> sends two of its own games to the same court.

## Getting started

```bash
npm install
npm run db:setup      # apply migrations + seed Santa Fe courts, locally
npm run dev           # http://localhost:3000
```

No accounts or API keys needed to develop. `MAIL_PROVIDER` defaults to
`console`, which prints messages to the Worker log instead of sending them —
and the sign-in screen shows you the magic link directly.

### Make yourself an admin

Admins manage locations and courts. Sign in once, then:

```bash
npx wrangler d1 execute gameseeker --local \
  --command="UPDATE users SET is_admin = 1 WHERE email = 'you@example.com'"
```

## Verifying

```bash
npm test        # 51 tests: races, matching, DST, availability logic
npm run smoke   # end-to-end over real HTTP (needs `npm run dev` running)
npm run typecheck
```

`npm test` runs inside workerd against a real D1, so the atomicity guarantees
above are tested rather than mocked. `npm run smoke` walks the whole player
journey — magic link, profile, availability, hosting, matching, claiming,
cancelling — against the dev server, and resets the local database first.

## Deploying

```bash
npx wrangler d1 create gameseeker      # copy the database_id into wrangler.jsonc
npm run db:migrate:remote
npm run db:seed:remote

npx wrangler secret put SESSION_SECRET # any random string, 32+ characters
npm run deploy
```

Then set `APP_URL` in `wrangler.jsonc` to your real URL — it's what magic-link
and claim links are built from — and redeploy.

### Turning on real email

Cloudflare **cannot** send email to arbitrary addresses: Email Routing is
inbound only, and the Email Workers `send_email` binding only reaches addresses
you've pre-verified in your own account. So delivery goes through an adapter.

To use [Resend](https://resend.com) (free: 3,000/month, 100/day):

1. Add and verify your domain in the Resend dashboard.
2. Set `MAIL_FROM` in `wrangler.jsonc` to an address on that domain.
3. `npx wrangler secret put RESEND_API_KEY`
4. Set `MAIL_PROVIDER` to `"resend"` in `wrangler.jsonc`, then redeploy.

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
  routes/               Pages
  server.ts             Worker entry (fetch + scheduled)
drizzle/
  migrations/           Generated by `npm run db:generate`
  seed.sql              Santa Fe locations and courts
  reset.sql             Clears player/game data, keeps courts
```

## About the seeded courts

Locations and court counts come from public reporting on the city's tennis
inventory — 19 public courts across Salvador Perez, Herb Martinez / La
Resolana, Ron Shirley / Alto, Larragoite, and Atalaya, plus the Chavez Center
and the Santa Fe Tennis & Swim Club. Fort Marcy is intentionally absent; its
two tennis courts were converted to pickleball.

Treat this as a starting point and correct it under **Admin → Courts**. Courts
closed for resurfacing can be deactivated rather than deleted, so existing
games keep their history. Coordinates are left empty rather than guessed.
