import { getConfig } from '../config'

/**
 * iCalendar (RFC 5545) generation, hand-rolled.
 *
 * A dependency would be the fifth runtime package in the project for something
 * that is a hundred lines of string formatting, and the parts that actually
 * break in real clients — line folding, TEXT escaping, and a stable UID — are
 * exactly the parts a library would hide.
 *
 * Every instant goes out as UTC (`YYYYMMDDTHHMMSSZ`) straight from the epoch
 * milliseconds we already store, so there is no VTIMEZONE block and no DST
 * arithmetic to get wrong. `src/server/time.ts` is deliberately not involved:
 * an instant is already absolute, and the recipient's calendar renders it in
 * whatever zone their device is in.
 */

export type CalendarEvent = {
  /** Stable across every message about the same booking. */
  uid: string
  /**
   * Bumped whenever the event moves or is called off. A calendar client
   * ignores an update whose sequence didn't advance, so this is what makes an
   * ICS update the existing entry instead of being silently dropped.
   */
  sequence: number
  startsAt: number
  endsAt: number
  summary: string
  description: string
  location: string
  geo?: { lat: number; lng: number } | null
  url: string
  cancelled?: boolean
}

/** The one person this copy is addressed to. Never the rest of the roster. */
export type CalendarAttendee = {
  name: string
  email: string
}

const CRLF = '\r\n'

/** `2026-09-15T23:00:00Z` -> `20260915T230000Z`. */
export function icsStamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}

/**
 * Escape a TEXT value. Order matters — the backslash rule has to run first or
 * it escapes the backslashes the later rules just added.
 */
function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n')
}

/**
 * Fold to 75 octets per line, continuing with a leading space.
 *
 * Counted in **octets, not characters**: a line of accented text or emoji can
 * be well under 75 characters and still over the limit, and a client that
 * enforces it will truncate or reject the file. Multi-byte sequences are never
 * split across a fold.
 */
export function foldLine(line: string): string {
  const bytes = new TextEncoder().encode(line)
  if (bytes.length <= 75) return line

  const out: string[] = []
  let current = ''
  let currentBytes = 0
  // The continuation space costs an octet, so subsequent lines fit 74.
  let limit = 75

  for (const char of line) {
    const size = new TextEncoder().encode(char).length
    if (currentBytes + size > limit) {
      out.push(current)
      current = ''
      currentBytes = 0
      limit = 74
    }
    current += char
    currentBytes += size
  }
  if (current) out.push(current)

  return out.join(`${CRLF} `)
}

function line(name: string, value: string): string {
  return foldLine(`${name}:${value}`)
}

/** `"GameSeeker <noreply@gameseeker.app>"` -> `noreply@gameseeker.app`. */
export function addressOf(mailFrom: string): string {
  const angled = mailFrom.match(/<([^>]+)>/)
  return (angled ? angled[1]! : mailFrom).trim()
}

/**
 * One VEVENT, addressed to one person.
 *
 * The attendee is always the recipient's own address and never the roster —
 * telling someone their own email address is not a disclosure, and it is what
 * lets Google and Outlook match a later update or cancellation to the entry
 * they already hold. Putting the other players in here would leak contact
 * details out of the server, which nothing in this app is allowed to do.
 */
export function buildIcs(event: CalendarEvent, attendee?: CalendarAttendee | null): string {
  const method = event.cancelled ? 'CANCEL' : 'PUBLISH'
  const organizer = addressOf(getConfig().mailFrom)

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Santa Fe GameSeeker//EN',
    'CALSCALE:GREGORIAN',
    `METHOD:${method}`,
    'BEGIN:VEVENT',
    line('UID', event.uid),
    line('SEQUENCE', String(event.sequence)),
    // DTSTAMP is when this *message* was produced, not when the game is.
    line('DTSTAMP', icsStamp(Date.now())),
    line('DTSTART', icsStamp(event.startsAt)),
    line('DTEND', icsStamp(event.endsAt)),
    line('SUMMARY', escapeText(event.summary)),
    line('DESCRIPTION', escapeText(event.description)),
    line('LOCATION', escapeText(event.location)),
    line('URL', event.url),
    line('STATUS', event.cancelled ? 'CANCELLED' : 'CONFIRMED'),
    line('TRANSP', 'OPAQUE'),
    line('ORGANIZER;CN=Santa Fe GameSeeker', `mailto:${organizer}`),
  ]

  if (event.geo) {
    lines.push(line('GEO', `${event.geo.lat};${event.geo.lng}`))
  }
  if (attendee) {
    lines.push(
      foldLine(
        `ATTENDEE;CN=${escapeText(attendee.name)};PARTSTAT=ACCEPTED;RSVP=FALSE:mailto:${attendee.email}`,
      ),
    )
  }

  lines.push('END:VEVENT', 'END:VCALENDAR')
  return `${lines.join(CRLF)}${CRLF}`
}

/**
 * A one-click "add this" link for people who'd rather not open an attachment.
 *
 * Google's template URL is undocumented but long-stable, and it costs nothing:
 * if it ever changes, the `.ics` attachment is still the real mechanism.
 */
export function googleCalendarUrl(event: CalendarEvent): string {
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: event.summary,
    dates: `${icsStamp(event.startsAt)}/${icsStamp(event.endsAt)}`,
    details: `${event.description}\n\n${event.url}`,
    location: event.location,
  })
  return `https://calendar.google.com/calendar/render?${params.toString()}`
}

/**
 * Base64 for an attachment body.
 *
 * Chunked because `String.fromCharCode(...bytes)` spreads every byte into the
 * argument list, and a long enough file overflows the call stack.
 */
export function toBase64(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}
