/**
 * End-to-end smoke test against a running dev server.
 *
 *   npm run dev          # in one terminal
 *   npm run smoke        # in another
 *
 * Unlike the Vitest suite (which calls the server modules directly), this
 * drives the real HTTP surface: cookies, CSRF, serialization, and route
 * wiring. It walks the actual player journey — sign in by magic link, fill in
 * a profile, post availability, host a game, get matched, and claim a spot
 * from the notification link.
 *
 * Caveat: it talks to TanStack Start's internal /_serverFn endpoint and
 * discovers function ids from the dev server's transformed modules. That's a
 * private interface; if a Start upgrade changes the wire format, fix it here.
 */
import { fromCrossJSON, toJSONAsync } from 'seroval'

const BASE = process.env.SMOKE_BASE_URL ?? 'http://localhost:3000'

// --- server-function plumbing ----------------------------------------------

const FN_IDS = new Map()

async function discover(file) {
  const res = await fetch(`${BASE}/src/fn/${file}.ts`)
  if (!res.ok) throw new Error(`Cannot reach the dev server at ${BASE} (${res.status})`)
  const src = await res.text()
  for (const m of src.matchAll(/export const (\w+) =[\s\S]{0,200}?createClientRpc\("([^"]+)"\)/g)) {
    FN_IDS.set(`${file}.${m[1]}`, m[2])
  }
}

async function callFn({ file, name, method = 'POST', data, cookie }) {
  const id = FN_IDS.get(`${file}.${name}`)
  if (!id) throw new Error(`no server fn id for ${file}.${name}`)

  let url = `${BASE}/_serverFn/${id}`
  const headers = {
    'x-tsr-serverFn': 'true',
    accept: 'application/json, application/x-ndjson',
    // Start's CSRF middleware requires a same-origin request.
    origin: BASE,
    referer: `${BASE}/`,
  }
  if (cookie) headers.cookie = cookie

  let body
  if (data !== undefined) {
    const serialized = JSON.stringify(await toJSONAsync({ data }))
    if (method === 'GET') url += `?payload=${encodeURIComponent(serialized)}`
    else {
      body = serialized
      headers['content-type'] = 'application/json'
    }
  }

  const res = await fetch(url, { method, headers, body })
  return { text: await res.text(), setCookie: res.headers.getSetCookie?.() ?? [] }
}

/** Decode a seroval cross-JSON response into plain JS. */
function decode(text) {
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const value = fromCrossJSON(JSON.parse(line), { refs: new Map() })
      if (value && typeof value === 'object' && 'result' in value) return value
      return { result: value }
    } catch {}
  }
  return { raw: text }
}

// --- harness ----------------------------------------------------------------

let ok = 0
let failed = 0

function check(label, condition, detail = '') {
  if (condition) {
    ok += 1
    console.log(`  ok   ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL ${label}${detail ? `  — ${detail}` : ''}`)
  }
}

function section(title) {
  console.log(`\n${title}`)
}

async function signIn(email) {
  const login = await callFn({ file: 'auth', name: 'requestLogin', data: { email } })
  const match = /auth\/verify\?token=([A-Za-z0-9_\-%]+)/.exec(login.text)
  if (!match) throw new Error(`no magic link issued for ${email}`)

  const verify = await callFn({
    file: 'auth',
    name: 'verifyMagicLink',
    data: { token: decodeURIComponent(match[1]) },
  })
  const cookie = verify.setCookie.map((c) => c.split(';')[0]).join('; ')
  if (!cookie) throw new Error(`no session cookie issued for ${email}`)
  return cookie
}

async function completeProfile(cookie, name, ntrp) {
  return callFn({
    file: 'profile',
    name: 'saveProfile',
    cookie,
    data: {
      name,
      phone: '505-555-0100',
      ratingSystem: 'NTRP',
      ratingValue: ntrp,
      playsSingles: true,
      playsDoubles: true,
      notifyEmail: true,
      notifySms: false,
      homeLocationId: null,
    },
  })
}

/** The next Tuesday at 5:00 PM Santa Fe time, at least a day out. */
function nextTuesdayEvening() {
  const now = Date.now()
  const probe = new Date(now)
  probe.setUTCHours(23, 0, 0, 0)
  while (probe.getUTCDay() !== 2 || probe.getTime() < now + 86_400_000) {
    probe.setUTCDate(probe.getUTCDate() + 1)
  }
  return probe.getTime()
}

// --- the journey ------------------------------------------------------------

for (const file of ['auth', 'profile', 'availability', 'games', 'admin']) await discover(file)

const stamp = Date.now()
const hostEmail = `host-${stamp}@santafe.test`
const playerEmail = `player-${stamp}@santafe.test`

section('Sign in')
const host = await signIn(hostEmail)
const player = await signIn(playerEmail)
check('both players signed in by magic link', Boolean(host && player))

section('Profiles')
check('host profile saved', Boolean(decode((await completeProfile(host, 'Maria Host', 3.5)).text).result))
check('player profile saved', Boolean(decode((await completeProfile(player, 'Dan Player', 3.5)).text).result))

section('Availability')
const rule = await callFn({
  file: 'availability',
  name: 'createRule',
  cookie: player,
  data: { weekday: 2, startMinute: 16 * 60, endMinute: 20 * 60, formatPref: 'either' },
})
check('player posted a Tuesday 4-8pm weekly rule', decode(rule.text).result?.weekday === 2)

section('Courts')
const locations = decode(
  (await callFn({ file: 'games', name: 'fetchLocations', method: 'GET', cookie: host })).text,
).result
check('Santa Fe locations are seeded', locations?.some((l) => l.id === 'loc-salvador-perez'))

const startsAt = nextTuesdayEvening()
const endsAt = startsAt + 90 * 60 * 1000

const freeCourts = decode(
  (
    await callFn({
      file: 'games',
      name: 'fetchFreeCourts',
      method: 'GET',
      cookie: host,
      data: { locationId: 'loc-salvador-perez', startsAt, endsAt },
    })
  ).text,
).result
const initialFree = freeCourts?.length ?? 0
check('courts are available for that window', initialFree > 0, `got ${initialFree}`)

section('Matching')
const reach = decode(
  (
    await callFn({
      file: 'games',
      name: 'fetchReach',
      method: 'GET',
      cookie: host,
      data: { startsAt, endsAt, format: 'singles', seekerNtrp: 3.5 },
    })
  ).text,
).result
check('reach preview finds exactly the available player', reach?.count === 1, `count=${reach?.count}`)

section('Hosting')
const courtId = freeCourts[0].id
const posted = decode(
  (
    await callFn({
      file: 'games',
      name: 'postGame',
      cookie: host,
      data: {
        courtId,
        startsAt,
        endsAt,
        format: 'singles',
        notes: 'Bring a can of balls',
        slots: [{ kind: 'seeker', seekerNtrp: 3.5 }],
      },
    })
  ).text,
).result
check('game posted', Boolean(posted?.gameId))
const duringGame = decode(
  (
    await callFn({
      file: 'games',
      name: 'fetchFreeCourts',
      method: 'GET',
      cookie: host,
      data: { locationId: 'loc-salvador-perez', startsAt, endsAt },
    })
  ).text,
).result
check('the booked court left the free pool', duringGame?.length === initialFree - 1, `got ${duringGame?.length}`)
check('the matched player was notified', posted?.notified === 1, JSON.stringify(posted))

const dup = await callFn({
  file: 'games',
  name: 'postGame',
  cookie: player,
  data: {
    courtId,
    startsAt,
    endsAt,
    format: 'singles',
    slots: [{ kind: 'seeker', seekerNtrp: 3.5 }],
  },
})
check(
  'the same court and time is refused',
  /already booked/i.test(decode(dup.text).error?.message ?? dup.text),
  dup.text.slice(0, 160),
)

section('Claiming')
const claim = decode(
  (await callFn({ file: 'games', name: 'claimGameSlot', cookie: player, data: { gameId: posted.gameId } })).text,
).result
check('player claimed the spot', claim?.ok === true)
check('no spots remain', claim?.remainingOpen === 0)

const detail = decode(
  (
    await callFn({
      file: 'games',
      name: 'fetchGame',
      method: 'GET',
      cookie: player,
      data: { gameId: posted.gameId },
    })
  ).text,
).result
check('game reads as full', detail?.game?.status === 'full', detail?.game?.status)
const roster = (detail?.slots ?? []).map((s) => s.player?.name).filter(Boolean)
check('both players on the roster', roster.includes('Maria Host') && roster.includes('Dan Player'), JSON.stringify(roster))
check('teammates can see contact details', (detail?.slots ?? []).some((s) => s.player?.phone))

const reclaim = decode(
  (await callFn({ file: 'games', name: 'claimGameSlot', cookie: player, data: { gameId: posted.gameId } })).text,
)
check('a full game cannot be claimed again', reclaim.result?.ok !== true)

section('Cancelling')
const cancelled = decode(
  (await callFn({ file: 'games', name: 'callOffGame', cookie: host, data: { gameId: posted.gameId, reason: 'rain' } })).text,
).result
check('host cancelled the game', cancelled?.ok === true)

const reopened = decode(
  (
    await callFn({
      file: 'games',
      name: 'fetchFreeCourts',
      method: 'GET',
      cookie: host,
      data: { locationId: 'loc-salvador-perez', startsAt, endsAt },
    })
  ).text,
).result
check(
  'the court was released back to the pool',
  reopened?.length === initialFree,
  `expected ${initialFree}, got ${reopened?.length}`,
)

console.log(`\n${ok} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
