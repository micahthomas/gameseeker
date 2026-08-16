/**
 * Timezone helpers. Everything is stored as UTC epoch milliseconds; the club
 * lives in America/Denver, which observes DST. Converting a wall-clock time
 * ("Tuesday 5pm") to an instant therefore depends on the date, so we do it
 * with Intl rather than a fixed offset.
 */

export const TZ = 'America/Denver'

export const MINUTE = 60_000
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR

/** Court bookings are tracked in 30-minute granules. */
export const SLOT_MINUTES = 30
export const SLOT_MS = SLOT_MINUTES * MINUTE

const partsFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  weekday: 'short',
})

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
}

export type ZonedParts = {
  year: number
  month: number // 1-12
  day: number
  hour: number
  minute: number
  second: number
  weekday: number // 0 = Sunday
}

/** Break an instant into its America/Denver wall-clock parts. */
export function zonedParts(ms: number): ZonedParts {
  const parts = partsFormatter.formatToParts(new Date(ms))
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '0'
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    second: Number(get('second')),
    weekday: WEEKDAY_INDEX[get('weekday')] ?? 0,
  }
}

/** Offset of the zone at a given instant, in ms (local - UTC). */
function zoneOffset(ms: number): number {
  const p = zonedParts(ms)
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  // Discard sub-second noise so the result lands on a clean offset.
  return asIfUtc - Math.floor(ms / 1000) * 1000
}

/**
 * Convert an America/Denver wall-clock time to an instant.
 *
 * Two passes: guess using the offset at the naive UTC instant, then correct
 * using the offset actually in effect at the resulting instant. This is what
 * makes times land correctly on either side of a DST transition.
 *
 * Ambiguous times (the repeated hour when clocks fall back) resolve to the
 * first occurrence; nonexistent times (the skipped hour in spring) shift
 * forward out of the gap. Neither matters for tennis scheduling — courts
 * aren't booked at 2am — but the behavior is defined rather than accidental.
 */
export function zonedToUtc(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
): number {
  const naive = Date.UTC(year, month - 1, day, hour, minute)
  const firstPass = naive - zoneOffset(naive)
  return naive - zoneOffset(firstPass)
}

/** Minutes elapsed since local midnight, e.g. 17:30 => 1050. */
export function localMinutes(ms: number): number {
  const p = zonedParts(ms)
  return p.hour * 60 + p.minute
}

/** 0 = Sunday .. 6 = Saturday, in local time. */
export function localWeekday(ms: number): number {
  return zonedParts(ms).weekday
}

/** The instant of local midnight on the day containing `ms`. */
export function startOfLocalDay(ms: number): number {
  const p = zonedParts(ms)
  return zonedToUtc(p.year, p.month, p.day, 0, 0)
}

/** Local midnight `days` days after the local day containing `ms`. */
export function addLocalDays(ms: number, days: number): number {
  const p = zonedParts(ms)
  return zonedToUtc(p.year, p.month, p.day + days, p.hour, p.minute)
}

/** Round down to a 30-minute boundary. */
export function floorToSlot(ms: number): number {
  return Math.floor(ms / SLOT_MS) * SLOT_MS
}

/** Round up to a 30-minute boundary. */
export function ceilToSlot(ms: number): number {
  return Math.ceil(ms / SLOT_MS) * SLOT_MS
}

/**
 * The 30-minute granule starts a booking covers. A game from 17:00-18:30
 * yields [17:00, 17:30, 18:00].
 */
export function slotStarts(startsAt: number, endsAt: number): number[] {
  const first = floorToSlot(startsAt)
  const last = ceilToSlot(endsAt)
  const out: number[] = []
  for (let t = first; t < last; t += SLOT_MS) out.push(t)
  return out
}

export function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd
}

const dateTimeFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
})

const timeFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  hour: 'numeric',
  minute: '2-digit',
})

const dateFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  weekday: 'long',
  month: 'long',
  day: 'numeric',
})

/** "Tue, Aug 18, 5:00 PM" */
export function formatDateTime(ms: number): string {
  return dateTimeFmt.format(new Date(ms))
}

/** "5:00 PM" */
export function formatTime(ms: number): string {
  return timeFmt.format(new Date(ms))
}

/** "Tuesday, August 18" */
export function formatDate(ms: number): string {
  return dateFmt.format(new Date(ms))
}

/** "Tue, Aug 18, 5:00 - 6:30 PM" */
export function formatRange(startsAt: number, endsAt: number): string {
  return `${formatDateTime(startsAt)} – ${formatTime(endsAt)}`
}

/** Minutes-from-midnight to "5:00 PM". */
export function formatMinuteOfDay(minute: number): string {
  const h = Math.floor(minute / 60)
  const m = minute % 60
  const period = h >= 12 ? 'PM' : 'AM'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return `${h12}:${String(m).padStart(2, '0')} ${period}`
}

/** "in 3 hours" / "in 2 days" / "started" */
export function relativeTime(ms: number, now = Date.now()): string {
  const diff = ms - now
  if (diff <= 0) return 'started'
  const mins = Math.round(diff / MINUTE)
  if (mins < 60) return `in ${mins} min`
  const hours = Math.round(diff / HOUR)
  if (hours < 24) return `in ${hours} hour${hours === 1 ? '' : 's'}`
  const days = Math.round(diff / DAY)
  return `in ${days} day${days === 1 ? '' : 's'}`
}

/**
 * Parse an <input type="datetime-local"> value as Santa Fe wall-clock time.
 *
 * Deliberately not `new Date(value)`, which interprets the string in the
 * browser's timezone. A player checking the app from a trip to Denver or
 * Chicago should still be picking Santa Fe court times.
 */
export function parseLocalInput(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value)
  if (!match) return Number.NaN
  const [, y, m, d, h, min] = match
  return zonedToUtc(Number(y), Number(m), Number(d), Number(h), Number(min))
}

/** Format an instant for an <input type="datetime-local"> in Santa Fe time. */
export function toLocalInput(ms: number): string {
  const p = zonedParts(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`
}

/** Format an instant for an <input type="date"> in Santa Fe time. */
export function toDateInput(ms: number): string {
  const p = zonedParts(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`
}

/**
 * Read a `YYYY-MM-DD` back as the start of that day in Santa Fe.
 *
 * The inverse of `toDateInput`, and the same rule as `parseLocalInput`: the
 * string names a *wall-clock* day here, not one in the reader's timezone.
 * Returns null for anything that isn't a real date, so a hand-edited URL can
 * fall back rather than render NaN.
 */
export function fromDateInput(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim())
  if (!match) return null
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  const ms = zonedToUtc(year, month, day, 0, 0)
  // Round-trip check catches the likes of 2026-02-31, which zonedToUtc would
  // happily roll forward into March.
  return toDateInput(ms) === value.trim() ? ms : null
}

/**
 * Consecutive local-day boundaries starting from the day containing `fromMs`.
 * Stepping via startOfLocalDay (rather than adding 24h) keeps the ranges
 * aligned to the wall clock across DST changes, where a day is 23 or 25 hours.
 */
export function localDayRanges(
  fromMs: number,
  count: number,
): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = []
  let cursor = startOfLocalDay(fromMs)
  for (let i = 0; i < count; i++) {
    // Overshoot by 2h before re-flooring so a 23-hour day still lands on the
    // next calendar day rather than back on the same one.
    const next = startOfLocalDay(cursor + DAY + 2 * HOUR)
    ranges.push({ start: cursor, end: next })
    cursor = next
  }
  return ranges
}

/** Half-hour options from 6:00 AM to 10:00 PM, for time pickers. */
export function courtHourOptions(): Array<{ minute: number; label: string }> {
  const options: Array<{ minute: number; label: string }> = []
  for (let minute = 6 * 60; minute <= 22 * 60; minute += SLOT_MINUTES) {
    options.push({ minute, label: formatMinuteOfDay(minute) })
  }
  return options
}

export const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const

export const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const
