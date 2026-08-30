import { describe, expect, it } from 'vitest'
import {
  addressOf,
  buildIcs,
  foldLine,
  googleCalendarUrl,
  icsStamp,
  toBase64,
  type CalendarEvent,
} from '~/server/notify/calendar'
import { gameCalendarEvent, type GameBrief } from '~/server/notify/templates'
import { localTime } from './helpers'

/**
 * The parts of an ICS that actually break in real clients: line folding
 * counted in octets, TEXT escaping, and a UID/SEQUENCE pair that lets a later
 * message supersede an earlier one. Everything here is pure string work, so
 * none of it touches the database.
 */

function event(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    uid: 'game-abc@gameseeker.app',
    sequence: 0,
    startsAt: localTime(2026, 9, 15, 17, 0),
    endsAt: localTime(2026, 9, 15, 18, 30),
    summary: 'Tennis at Alto Park',
    description: 'Singles with Micah.',
    location: 'Alto Park - Court 3',
    url: 'https://gameseeker.app/games/abc',
    ...overrides,
  }
}

/** Undo folding so a value can be asserted on whole. */
function unfold(ics: string): string {
  return ics.replace(/\r\n /g, '')
}

function valueOf(ics: string, name: string): string | undefined {
  return unfold(ics)
    .split('\r\n')
    .find((line) => line.startsWith(`${name}:`) || line.startsWith(`${name};`))
}

describe('formatting instants', () => {
  it('writes UTC, which needs no VTIMEZONE block', () => {
    // 5pm Santa Fe in September is MDT (UTC-6).
    expect(icsStamp(localTime(2026, 9, 15, 17, 0))).toBe('20260915T230000Z')
  })

  it('survives the spring DST change without shifting the wall clock', () => {
    // 2026-03-08 is the US spring-forward. 5pm local is UTC-6 after it and
    // UTC-7 the day before, and both have to come out as the right instant.
    expect(icsStamp(localTime(2026, 3, 7, 17, 0))).toBe('20260308T000000Z')
    expect(icsStamp(localTime(2026, 3, 9, 17, 0))).toBe('20260309T230000Z')
  })

  it('emits no fractional seconds', () => {
    expect(icsStamp(1_788_000_000_123)).toMatch(/^\d{8}T\d{6}Z$/)
  })
})

describe('line folding', () => {
  it('leaves a short line alone', () => {
    expect(foldLine('SUMMARY:Tennis')).toBe('SUMMARY:Tennis')
  })

  it('folds at 75 octets with a leading space on continuations', () => {
    const folded = foldLine(`DESCRIPTION:${'a'.repeat(200)}`)
    for (const line of folded.split('\r\n')) {
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75)
    }
    expect(folded.split('\r\n').slice(1).every((line) => line.startsWith(' '))).toBe(true)
    expect(folded.replace(/\r\n /g, '')).toBe(`DESCRIPTION:${'a'.repeat(200)}`)
  })

  it('counts octets rather than characters, and never splits one', () => {
    // Each of these is three octets, so 40 of them is 120 bytes but only 40
    // characters — a character-counting fold would emit one over-long line.
    const value = `SUMMARY:${'→'.repeat(40)}`
    const folded = foldLine(value)

    expect(folded).toContain('\r\n ')
    for (const line of folded.split('\r\n')) {
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75)
    }
    // A split multi-byte sequence would come back as replacement characters.
    expect(folded.replace(/\r\n /g, '')).toBe(value)
  })
})

describe('escaping', () => {
  it('escapes the four characters that are structural in a TEXT value', () => {
    const ics = buildIcs(
      event({ description: 'Bring: balls, water; a towel\\nSee you there', summary: 'A, B' }),
    )
    const description = valueOf(ics, 'DESCRIPTION')!

    expect(description).toContain('balls\\, water')
    expect(description).toContain('a towel')
    expect(description).not.toMatch(/[^\\],/)
    expect(valueOf(ics, 'SUMMARY')).toBe('SUMMARY:A\\, B')
  })

  it('escapes a real newline rather than emitting one', () => {
    const ics = buildIcs(event({ description: 'first\nsecond' }))
    expect(valueOf(ics, 'DESCRIPTION')).toBe('DESCRIPTION:first\\nsecond')
    // A raw newline would end the property and corrupt everything after it.
    expect(unfold(ics).split('\r\n').filter((l) => l === 'second')).toHaveLength(0)
  })

  it('escapes backslashes before the rules that add them', () => {
    expect(valueOf(buildIcs(event({ summary: 'a\\b' })), 'SUMMARY')).toBe('SUMMARY:a\\\\b')
  })
})

describe('the calendar object', () => {
  it('is a well-formed VCALENDAR with CRLF endings', () => {
    const ics = buildIcs(event())
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true)
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true)
    expect(ics).not.toMatch(/[^\r]\n/)
  })

  it('publishes a confirmed event by default', () => {
    const ics = buildIcs(event())
    expect(ics).toContain('METHOD:PUBLISH')
    expect(valueOf(ics, 'STATUS')).toBe('STATUS:CONFIRMED')
  })

  it('cancels with the same UID so the entry is withdrawn, not duplicated', () => {
    const first = buildIcs(event())
    const cancel = buildIcs(event({ sequence: 1, cancelled: true }))

    expect(valueOf(cancel, 'UID')).toBe(valueOf(first, 'UID'))
    expect(cancel).toContain('METHOD:CANCEL')
    expect(valueOf(cancel, 'STATUS')).toBe('STATUS:CANCELLED')
    // A client ignores an update that doesn't advance the sequence.
    expect(valueOf(cancel, 'SEQUENCE')).toBe('SEQUENCE:1')
    expect(valueOf(first, 'SEQUENCE')).toBe('SEQUENCE:0')
  })

  it('names only the recipient as an attendee, never the roster', () => {
    const ics = buildIcs(event(), { name: 'Ann', email: 'ann@example.test' })
    const attendees = unfold(ics)
      .split('\r\n')
      .filter((line) => line.startsWith('ATTENDEE'))

    expect(attendees).toHaveLength(1)
    expect(attendees[0]).toContain('mailto:ann@example.test')
  })

  it('omits the attendee line entirely when there is nobody to address', () => {
    expect(buildIcs(event())).not.toContain('ATTENDEE')
  })

  it('includes GEO only when the location has coordinates', () => {
    expect(buildIcs(event({ geo: { lat: 35.69, lng: -105.95 } }))).toContain('GEO:35.69;-105.95')
    expect(buildIcs(event())).not.toContain('GEO:')
  })

  it('takes the organizer address out of the display-name MAIL_FROM form', () => {
    // Production's MAIL_FROM is "GameSeeker <noreply@gameseeker.app>", and a
    // display name inside a mailto: is what breaks ORGANIZER in most clients.
    expect(addressOf('GameSeeker <noreply@example.com>')).toBe('noreply@example.com')
    expect(addressOf('noreply@example.com')).toBe('noreply@example.com')
    expect(buildIcs(event())).toMatch(/ORGANIZER[^\r\n]*:mailto:[^\s<>]+$/m)
  })
})

describe('the Google Calendar link', () => {
  it('carries the same instants as the file', () => {
    const url = new URL(googleCalendarUrl(event()))
    expect(url.origin + url.pathname).toBe('https://calendar.google.com/calendar/render')
    expect(url.searchParams.get('action')).toBe('TEMPLATE')
    expect(url.searchParams.get('dates')).toBe('20260915T230000Z/20260916T003000Z')
    expect(url.searchParams.get('text')).toBe('Tennis at Alto Park')
  })

  it('escapes its parameters rather than concatenating them raw', () => {
    // An unescaped '&' would end the parameter and silently truncate the title.
    const url = googleCalendarUrl(event({ summary: 'Tennis & chat', location: 'A, B' }))
    expect(url).not.toContain('Tennis & chat')
    expect(new URL(url).searchParams.get('text')).toBe('Tennis & chat')
    expect(new URL(url).searchParams.get('location')).toBe('A, B')
  })
})

describe('building the event for a game', () => {
  function brief(overrides: Partial<GameBrief> = {}): GameBrief {
    return {
      id: 'game-1',
      startsAt: localTime(2026, 9, 15, 17, 0),
      endsAt: localTime(2026, 9, 15, 18, 30),
      format: 'doubles',
      locationName: 'Alto Park',
      locationAddress: '1121 Alto St',
      locationLat: 35.69,
      locationLng: -105.95,
      courtName: 'Court 3',
      hostName: 'Micah',
      notes: null,
      calendarSeq: 0,
      ...overrides,
    }
  }

  it('uses a UID stable across every message about one game', () => {
    const url = 'https://gameseeker.app/games/game-1'
    expect(gameCalendarEvent(brief(), url).uid).toBe(
      gameCalendarEvent(brief({ calendarSeq: 4 }), url).uid,
    )
  })

  it('carries the stored sequence, so a cancellation supersedes the invite', () => {
    const built = gameCalendarEvent(brief({ calendarSeq: 3 }), 'https://x.test/g')
    expect(built.sequence).toBe(3)
  })

  it('puts the court and the street address in LOCATION', () => {
    const built = gameCalendarEvent(brief(), 'https://x.test/g')
    expect(built.location).toBe('Alto Park - Court 3, 1121 Alto St')
    expect(built.geo).toEqual({ lat: 35.69, lng: -105.95 })
  })

  it('drops GEO when the location has no coordinates', () => {
    const built = gameCalendarEvent(
      brief({ locationLat: null, locationLng: null }),
      'https://x.test/g',
    )
    expect(built.geo).toBeNull()
  })

  it("includes the host's note when there is one", () => {
    const built = gameCalendarEvent(brief({ notes: 'Bring a can of balls' }), 'https://x.test/g')
    expect(built.description).toContain('Bring a can of balls')
  })
})

describe('base64 for attachments', () => {
  it('round-trips through atob', () => {
    expect(atob(toBase64('BEGIN:VCALENDAR'))).toBe('BEGIN:VCALENDAR')
  })

  it('encodes UTF-8 rather than code units', () => {
    expect(toBase64('café')).toBe(btoa(String.fromCharCode(99, 97, 102, 195, 169)))
  })

  it('handles a body long enough to overflow a spread call', () => {
    const long = 'a'.repeat(200_000)
    expect(atob(toBase64(long))).toBe(long)
  })
})
