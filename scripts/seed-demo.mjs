/**
 * Demo data for local development.
 *
 *   npm run db:demo
 *
 * Creates four players at every NTRP level (2.0 through 6.0), each with
 * availability posted, and books at least one game on every court over the
 * coming week — a mix of singles, doubles, and mixed doubles, some full and
 * some still looking for players.
 *
 * Safe to re-run: it clears players and games first (but not your courts).
 * Everything it creates uses @demo.test addresses, so you can sign in as any
 * of them from the login screen and see the magic link in the dev console.
 *
 * Deterministic: the "random" times come from a seeded generator, so the same
 * command always produces the same schedule.
 */
import { execFileSync } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REMOTE = process.argv.includes('--remote')
const DB = 'gameseeker'

// --- deterministic randomness ----------------------------------------------

let seed = 20260815
function random() {
  // Mulberry32. A fixed seed keeps demo data stable between runs, so a
  // screenshot or a bug report still matches what you see tomorrow.
  seed |= 0
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const pick = (list) => list[Math.floor(random() * list.length)]
const chance = (p) => random() < p

// --- time -------------------------------------------------------------------

const TZ = 'America/Denver'
const MINUTE = 60_000

function zonedParts(ms) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(ms))
  const get = (t) => Number(parts.find((p) => p.type === t)?.value ?? 0)
  return { year: get('year'), month: get('month'), day: get('day') }
}

/** Santa Fe wall-clock time to an instant, DST included. */
function zonedToUtc(year, month, day, hour, minute) {
  const naive = Date.UTC(year, month - 1, day, hour, minute)
  const offset = (ms) => {
    const p = new Intl.DateTimeFormat('en-US', {
      timeZone: TZ,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(ms))
    const g = (t) => Number(p.find((x) => x.type === t)?.value ?? 0)
    return (
      Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) -
      Math.floor(ms / 1000) * 1000
    )
  }
  const first = naive - offset(naive)
  return naive - offset(first)
}

const SLOT_MS = 30 * MINUTE

// --- players ----------------------------------------------------------------

const LEVELS = [2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0, 5.5, 6.0]

// [name, division]. The division is which side of a mixed game the player
// takes, not a statement about the person -- so it is deliberately not
// inferable from the name. The last four sit either side of that on purpose:
// two play a division, two leave it unset, which is what exercises the
// "can play mixed, but not a seat held to one side" path in the demo.
const FIRST_NAMES = [
  ['Maria', 'womens'], ['Elena', 'womens'], ['Rosa', 'womens'], ['Cara', 'womens'],
  ['Nina', 'womens'], ['Alice', 'womens'], ['Delia', 'womens'], ['Sofia', 'womens'],
  ['Junie', 'womens'], ['Paloma', 'womens'], ['Ruth', 'womens'], ['Ana', 'womens'],
  ['Diego', 'mens'], ['Marcus', 'mens'], ['Ben', 'mens'], ['Theo', 'mens'],
  ['Sam', 'mens'], ['Ivan', 'mens'], ['Luis', 'mens'], ['Hank', 'mens'],
  ['Owen', 'mens'], ['Pablo', 'mens'], ['Gil', 'mens'], ['Ray', 'mens'],
  ['Robin', 'womens'], ['Sky', 'mens'], ['Ash', 'unspecified'], ['Wren', 'unspecified'],
]

const LAST_NAMES = [
  'Ortiz', 'Vigil', 'Trujillo', 'Sena', 'Romero', 'Chavez', 'Baca', 'Lujan',
  'Archuleta', 'Montoya', 'Gallegos', 'Padilla', 'Herrera', 'Salazar', 'Griego',
  'Duran', 'Maestas', 'Quintana', 'Rael', 'Tafoya', 'Valdez', 'Abeyta',
  'Sandoval', 'Cordova', 'Martinez', 'Silva', 'Aragon', 'Naranjo', 'Roybal',
  'Pacheco', 'Lovato', 'Esquibel', 'Vialpando', 'Anaya', 'Sisneros', 'Bustos',
]

/**
 * A multi-line string as a SQL expression.
 *
 * Statements are handed to `wrangler d1 execute --command` joined by newlines,
 * and it splits them on those — so a literal newline inside a quoted string
 * tears the statement in half. `char(10)` keeps the text on one line.
 */
function sqlMultiline(value) {
  return value
    .split('\n')
    .map((line) => sql(line))
    .join(" || char(10) || ")
}

function sql(value) {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return value ? '1' : '0'
  return `'${String(value).replace(/'/g, "''")}'`
}

const statements = []
const now = Date.now()

// Clear anything from a previous demo run, plus any real local players.
statements.push(
  'DELETE FROM notifications;',
  'DELETE FROM clinic_notifications;',
  'DELETE FROM user_locations;',
  'DELETE FROM court_slot_locks;',
  'DELETE FROM game_court_options;',
  'DELETE FROM player_slot_locks;',
  'DELETE FROM game_slots;',
  'DELETE FROM games;',
  // Ahead of users and of the locks above: an occurrence left behind keeps a
  // court booked for a demo that no longer exists.
  'DELETE FROM clinic_signups;',
  'DELETE FROM clinic_occurrences;',
  'DELETE FROM clinics;',
  'DELETE FROM availability_blocks;',
  'DELETE FROM availability_rules;',
  'DELETE FROM sessions;',
  'DELETE FROM magic_tokens;',
  'DELETE FROM users;',
)

const players = []
let nameIndex = 0

for (const level of LEVELS) {
  for (let i = 0; i < 4; i++) {
    const [firstName, division] = FIRST_NAMES[nameIndex % FIRST_NAMES.length]
    const lastName = LAST_NAMES[nameIndex % LAST_NAMES.length]
    nameIndex += 1

    const id = `demo-${level.toFixed(1).replace('.', '')}-${i}`
    const name = `${firstName} ${lastName}`
    const email = `${firstName}.${lastName}${level.toFixed(1).replace('.', '')}@demo.test`.toLowerCase()

    // Most players will also play a step above or below; a few stay put.
    const playLevels = [level]
    if (chance(0.55)) {
      const up = LEVELS.find((l) => l > level)
      if (up) playLevels.push(up)
    }
    if (chance(0.3)) {
      const down = [...LEVELS].reverse().find((l) => l < level)
      if (down) playLevels.unshift(down)
    }

    // Four independent opt-ins, mirroring users.formats. Mixed is only ever
    // taken alongside its own game shape, since that's how a real player would
    // fill the form in.
    const formats = []
    if (chance(0.75)) formats.push('singles')
    if (chance(0.85) || formats.length === 0) formats.push('doubles')
    if (formats.includes('singles') && chance(0.35)) formats.push('mixed_singles')
    if (formats.includes('doubles') && chance(0.8)) formats.push('mixed_doubles')

    const plays = (format, mixed) =>
      formats.includes(mixed ? (format === 'singles' ? 'mixed_singles' : 'mixed_doubles') : format)

    players.push({ id, name, email, level, division, playLevels, formats, plays })

    statements.push(
      `INSERT INTO users (id, email, name, phone, rating_system, rating_value, ntrp, play_levels, ` +
        `formats, division, notify_email, notify_sms, notify_clinics, is_admin, organizer_status, ` +
        `profile_completed_at, created_at) VALUES (` +
        [
          sql(id),
          sql(email),
          sql(name),
          sql(`505-555-${String(1000 + nameIndex).slice(-4)}`),
          sql('NTRP'),
          level,
          level,
          sql(JSON.stringify(playLevels)),
          sql(JSON.stringify(formats)),
          sql(division),
          '1',
          '0',
          '1',
          '0',
          // The first player of each level is an approved organizer, so the
          // demo has somebody who can actually set a clinic up.
          sql(i === 0 ? 'approved' : 'none'),
          now,
          now,
        ].join(', ') +
        ');',
    )

    // Two or three standing weekly windows each, so matching has something to
    // chew on the moment you post a game.
    const days = [...new Set([Math.floor(random() * 7), Math.floor(random() * 7), Math.floor(random() * 7)])]
    for (const weekday of days) {
      const startMinute = pick([7 * 60, 8 * 60, 12 * 60, 16 * 60, 17 * 60, 18 * 60])
      statements.push(
        `INSERT INTO availability_rules (id, user_id, weekday, start_minute, end_minute, ` +
          `format_pref, effective_from, effective_until, is_active, created_at) VALUES (` +
          [
            sql(`${id}-rule-${weekday}`),
            sql(id),
            weekday,
            startMinute,
            startMinute + 3 * 60,
            sql('either'),
            now - 30 * 86_400_000,
            'NULL',
            '1',
            now,
          ].join(', ') +
          ');',
      )
    }
  }
}

// --- games ------------------------------------------------------------------

/**
 * Courts come from the database, so this works whatever an admin has added.
 * Reading them back out keeps the demo honest rather than hard-coding ids.
 */
function readCourts() {
  const out = execFileSync(
    'npx',
    [
      'wrangler',
      'd1',
      'execute',
      DB,
      REMOTE ? '--remote' : '--local',
      '--json',
      '--command=SELECT id, location_id FROM courts WHERE is_active = 1 ORDER BY location_id, sort_order',
    ],
    { encoding: 'utf8' },
  )
  const parsed = JSON.parse(out)
  const results = parsed[0]?.results ?? parsed.result?.[0]?.results ?? []
  return results.map((r) => ({ id: r.id, locationId: r.location_id }))
}

const courts = readCourts()
const courtIds = courts.map((c) => c.id)
const locationIds = [...new Set(courts.map((c) => c.locationId))]

// Most players name a couple of parks they like, in order; some name none, so
// the "no preference" path shows up in demo data too.
for (const player of players) {
  if (chance(0.25)) continue
  const shuffled = [...locationIds].sort(() => random() - 0.5)
  const wanted = shuffled.slice(0, chance(0.5) ? 1 : 2)
  wanted.forEach((locationId, rank) => {
    statements.push(
      `INSERT OR IGNORE INTO user_locations (user_id, location_id, rank) VALUES (` +
        [sql(player.id), sql(locationId), rank].join(', ') +
        ');',
    )
  })
}

if (courtIds.length === 0) {
  console.error('No courts found. Run `npm run db:setup` first.')
  process.exit(1)
}

// Every 30-minute granule each player is already committed to. The database
// enforces one game at a time now (player_slot_locks), so demo data has to be
// consistent with that or the inserts collide.
const busy = new Map()
const granulesFor = (startsAt, endsAt) => {
  const out = []
  for (let t = startsAt; t < endsAt; t += 30 * MINUTE) out.push(t)
  return out
}
const isFree = (playerId, startsAt, endsAt) =>
  granulesFor(startsAt, endsAt).every((t) => !busy.get(playerId)?.has(t))
const markBusy = (playerId, startsAt, endsAt) => {
  let held = busy.get(playerId)
  if (!held) busy.set(playerId, (held = new Set()))
  for (const t of granulesFor(startsAt, endsAt)) held.add(t)
}

const START_HOURS = [7, 8, 9, 10, 12, 15, 16, 17, 18, 19]
let gameNumber = 0

for (const courtId of courtIds) {
  // Every court gets at least one game; some get two.
  const count = chance(0.35) ? 2 : 1
  const usedHours = new Set()

  for (let g = 0; g < count; g++) {
    let hour = pick(START_HOURS)
    // 90-minute games, so keep starts at least two hours apart on a court.
    let guard = 0
    while ([...usedHours].some((h) => Math.abs(h - hour) < 2) && guard++ < 20) {
      hour = pick(START_HOURS)
    }
    usedHours.add(hour)

    // Include today, not just the days ahead: the location page opens on
    // today, and a demo whose first screen is empty looks broken.
    const daysAhead = Math.floor(random() * 7)
    const base = zonedParts(now + daysAhead * 86_400_000)
    let startsAt = zonedToUtc(base.year, base.month, base.day, hour, 0)
    if (startsAt < now + 60 * MINUTE) {
      // That hour has already passed today; push it to a later one.
      const remaining = START_HOURS.filter(
        (h) => zonedToUtc(base.year, base.month, base.day, h, 0) > now + 60 * MINUTE,
      )
      if (remaining.length === 0) continue
      hour = pick(remaining)
      if (usedHours.has(hour)) continue
      usedHours.add(hour)
      startsAt = zonedToUtc(base.year, base.month, base.day, hour, 0)
    }
    const endsAt = startsAt + (chance(0.3) ? 120 : 90) * MINUTE

    const doubles = chance(0.55)
    const format = doubles ? 'doubles' : 'singles'
    // Mixed singles is rarer than mixed doubles, but it exists now.
    const isMixed = chance(doubles ? 0.4 : 0.2)

    // Host: someone who plays this exact format, and who has a division to
    // balance against when it's mixed.
    const eligibleHosts = players.filter(
      (p) =>
        p.plays(format, isMixed) &&
        (!isMixed || p.division !== 'unspecified') &&
        isFree(p.id, startsAt, endsAt),
    )
    if (eligibleHosts.length === 0) continue
    const host = pick(eligibleHosts)
    const level = host.level
    markBusy(host.id, startsAt, endsAt)

    const gameId = `demo-game-${gameNumber++}`
    const seats = doubles ? 3 : 1
    const seatDivisions = !isMixed
      ? [null, null, null]
      : doubles
        ? host.division === 'womens'
          ? ['mens', 'mens', 'womens']
          : ['womens', 'womens', 'mens']
        : [host.division === 'womens' ? 'mens' : 'womens']

    // Fill some seats so the schedule isn't uniformly "looking for players".
    const fillCount = Math.min(seats, chance(0.45) ? seats : Math.floor(random() * seats))

    const taken = new Set([host.id])
    const fillers = []
    for (let i = 0; i < fillCount; i++) {
      const wanted = seatDivisions[i]
      const options = players.filter(
        (p) =>
          !taken.has(p.id) &&
          p.plays(format, isMixed) &&
          (!wanted || p.division === wanted) &&
          p.playLevels.includes(level) &&
          isFree(p.id, startsAt, endsAt),
      )
      if (options.length === 0) break
      const chosen = pick(options)
      taken.add(chosen.id)
      markBusy(chosen.id, startsAt, endsAt)
      fillers.push(chosen)
    }

    statements.push(
      `INSERT INTO games (id, host_id, court_id, starts_at, ends_at, format, is_mixed, status, ` +
        `min_ntrp, max_ntrp, notes, created_at, cancelled_at, reminded_at, host_nudged_at) VALUES (` +
        [
          sql(gameId),
          sql(host.id),
          sql(courtId),
          startsAt,
          endsAt,
          sql(format),
          sql(isMixed),
          sql(fillers.length === seats ? 'full' : 'open'),
          level,
          level,
          chance(0.25) ? sql(pick(['Bring a can of balls', 'Casual sets', 'Warm up at 10 to'])) : 'NULL',
          now,
          'NULL',
          'NULL',
          'NULL',
        ].join(', ') +
        ');',
    )

    // Host seat.
    statements.push(
      `INSERT INTO game_slots (id, game_id, slot_index, kind, invited_user_id, seeker_ntrp, ` +
        `seeker_division, filled_by_user_id, filled_at, status) VALUES (` +
        [
          sql(`${gameId}-s0`),
          sql(gameId),
          0,
          sql('host'),
          'NULL',
          'NULL',
          'NULL',
          sql(host.id),
          now,
          sql('filled'),
        ].join(', ') +
        ');',
    )

    for (let i = 0; i < seats; i++) {
      const filler = fillers[i]
      statements.push(
        `INSERT INTO game_slots (id, game_id, slot_index, kind, invited_user_id, seeker_ntrp, ` +
          `seeker_division, filled_by_user_id, filled_at, status) VALUES (` +
          [
            sql(`${gameId}-s${i + 1}`),
            sql(gameId),
            i + 1,
            sql('seeker'),
            'NULL',
            level,
            sql(seatDivisions[i]),
            filler ? sql(filler.id) : 'NULL',
            filler ? now : 'NULL',
            sql(filler ? 'filled' : 'open'),
          ].join(', ') +
          ');',
      )
    }

    // Demo games are already placed, so each one's court is also its single
    // option — the same shape createGame produces once a game has filled.
    statements.push(
      `INSERT OR IGNORE INTO game_court_options (game_id, court_id, rank) VALUES (` +
        [sql(gameId), sql(courtId), 0].join(', ') +
        ');',
    )

    // Hold the court, and everyone in the game, in the same 30-minute
    // granules the app uses.
    for (let t = Math.floor(startsAt / SLOT_MS) * SLOT_MS; t < endsAt; t += SLOT_MS) {
      statements.push(
        `INSERT OR IGNORE INTO court_slot_locks (court_id, slot_start, game_id, clinic_occurrence_id) VALUES (` +
          [sql(courtId), t, sql(gameId), 'NULL'].join(', ') +
          ');',
      )
      for (const player of [host, ...fillers]) {
        statements.push(
          `INSERT OR IGNORE INTO player_slot_locks (user_id, slot_start, game_id, clinic_occurrence_id) VALUES (` +
            [sql(player.id), t, sql(gameId), 'NULL'].join(', ') +
            ');',
        )
      }
    }
  }
}

// --- a clinic ---------------------------------------------------------------

/**
 * One published clinic, on a court no demo game took.
 *
 * The same argument as including today in the games above: the day view is the
 * first screen anyone looks at, and a feature that never appears on it reads as
 * missing rather than unused.
 */
const clinicOrganizer = players[0]
// 6am is ahead of every START_HOURS entry, so the clinic can share a court
// with the demo games without colliding with any of them.
const CLINIC_HOUR = 6
const clinicCourt = courtIds[0]
const clinicId = 'demo-clinic-1'

statements.push(
  `INSERT INTO clinics (id, organizer_id, location_id, title, description_md, cost_note, ` +
    `hero_key, hero_width, hero_height, capacity, status, recur_weekdays, recur_start_minute, ` +
    `recur_end_minute, recur_from, recur_until, created_at, published_at, cancelled_at, ` +
    `cancel_reason) VALUES (` +
    [
      sql(clinicId),
      sql(clinicOrganizer.id),
      sql(courts.find((c) => c.id === clinicCourt).locationId),
      sql('Cardio Tennis'),
      sqlMultiline(
        '## What to expect\n\nAn hour of continuous play — short points, quick feet, no ' +
          'standing around. All levels welcome.\n\n- Bring water and a towel\n- **Racquets ' +
          'available** if you need one',
      ),
      sql('$15 drop-in, cash at the court'),
      'NULL',
      'NULL',
      'NULL',
      8,
      sql('published'),
      sql(JSON.stringify([2, 4])),
      CLINIC_HOUR * 60,
      (CLINIC_HOUR + 1) * 60,
      now,
      now + 28 * 86_400_000,
      now,
      now,
      'NULL',
      'NULL',
    ].join(', ') +
    ');',
)

// Materialised dates, exactly as createClinic writes them — a clinic holds its
// court from creation, so every occurrence needs its locks too.
for (let day = 0; day < 28; day++) {
  const parts = zonedParts(now + day * 86_400_000)
  const startsAt = zonedToUtc(parts.year, parts.month, parts.day, CLINIC_HOUR, 0)
  // Tuesdays and Thursdays, in Santa Fe local terms.
  const weekday = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay()
  if (![2, 4].includes(weekday)) continue
  if (startsAt < now) continue

  const endsAt = zonedToUtc(parts.year, parts.month, parts.day, CLINIC_HOUR + 1, 0)
  const occurrenceId = `demo-occ-${startsAt}`

  statements.push(
    `INSERT INTO clinic_occurrences (id, clinic_id, court_id, starts_at, ends_at, status, ` +
      `calendar_seq, reminded_at) VALUES (` +
      [sql(occurrenceId), sql(clinicId), sql(clinicCourt), startsAt, endsAt, sql('scheduled'), 0, 'NULL'].join(', ') +
      ');',
  )

  for (let t = startsAt; t < endsAt; t += SLOT_MS) {
    statements.push(
      `INSERT OR IGNORE INTO court_slot_locks (court_id, slot_start, game_id, clinic_occurrence_id) VALUES (` +
        [sql(clinicCourt), t, 'NULL', sql(occurrenceId)].join(', ') +
        ');',
    )
  }

  // A few players already signed up, so the page isn't all empty seats.
  for (const player of players.filter((p) => p.id !== clinicOrganizer.id).slice(0, 3)) {
    if (!isFree(player.id, startsAt, endsAt)) continue
    markBusy(player.id, startsAt, endsAt)
    statements.push(
      `INSERT OR IGNORE INTO clinic_signups (id, occurrence_id, user_id, created_at) VALUES (` +
        [sql(`demo-signup-${occurrenceId}-${player.id}`), sql(occurrenceId), sql(player.id), now].join(', ') +
        ');',
    )
    for (let t = startsAt; t < endsAt; t += SLOT_MS) {
      statements.push(
        `INSERT OR IGNORE INTO player_slot_locks (user_id, slot_start, game_id, clinic_occurrence_id) VALUES (` +
          [sql(player.id), t, 'NULL', sql(occurrenceId)].join(', ') +
          ');',
      )
    }
  }
}

// --- apply ------------------------------------------------------------------

/**
 * Written to a file rather than passed as `--command`.
 *
 * The whole seed is one argument that way, and the operating system caps how
 * long an argument can be — adding the clinic tipped it over, and the failure
 * is an opaque exit code rather than anything about SQL. A file has no such
 * limit.
 */
const sqlFile = join(tmpdir(), `gameseeker-demo-${process.pid}.sql`)
writeFileSync(sqlFile, statements.join('\n'))

try {
  execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', DB, REMOTE ? '--remote' : '--local', `--file=${sqlFile}`],
    { stdio: ['pipe', 'pipe', 'inherit'] },
  )
} finally {
  rmSync(sqlFile, { force: true })
}

console.log(`Seeded ${players.length} players across ${LEVELS.length} levels.`)
console.log(`Booked ${gameNumber} games across ${courtIds.length} courts.`)
console.log('\nSign in as any of these (the magic link prints to the dev console):')
for (const level of [3.0, 3.5, 4.0]) {
  const sample = players.filter((p) => p.level === level).slice(0, 2)
  for (const p of sample) console.log(`  ${p.level.toFixed(1)}  ${p.email}`)
}
