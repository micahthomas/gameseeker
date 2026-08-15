import { describe, expect, it } from 'vitest'
import {
  formatMinuteOfDay,
  localDayRanges,
  localMinutes,
  localWeekday,
  parseLocalInput,
  slotStarts,
  startOfLocalDay,
  toLocalInput,
  zonedParts,
  zonedToUtc,
  DAY,
  HOUR,
} from '~/server/time'

/**
 * America/Denver observes DST, so "Tuesday at 5pm" is a different UTC instant
 * in January than in July. Everything about matching depends on getting that
 * right, so these are the tests worth writing.
 */
describe('America/Denver conversions', () => {
  it('uses MST (UTC-7) in winter', () => {
    const instant = zonedToUtc(2026, 1, 15, 17, 0)
    expect(new Date(instant).toISOString()).toBe('2026-01-16T00:00:00.000Z')
  })

  it('uses MDT (UTC-6) in summer', () => {
    const instant = zonedToUtc(2026, 7, 15, 17, 0)
    expect(new Date(instant).toISOString()).toBe('2026-07-15T23:00:00.000Z')
  })

  it('round-trips wall-clock time across the spring transition', () => {
    // DST begins 2026-03-08 in the US.
    for (const day of [7, 8, 9]) {
      const instant = zonedToUtc(2026, 3, day, 17, 30)
      const parts = zonedParts(instant)
      expect([parts.month, parts.day, parts.hour, parts.minute]).toEqual([3, day, 17, 30])
    }
  })

  it('round-trips wall-clock time across the autumn transition', () => {
    // DST ends 2026-11-01 in the US.
    for (const day of [31, 1, 2]) {
      const month = day === 31 ? 10 : 11
      const instant = zonedToUtc(2026, month, day, 17, 30)
      const parts = zonedParts(instant)
      expect([parts.month, parts.day, parts.hour, parts.minute]).toEqual([month, day, 17, 30])
    }
  })

  it('reports local weekday and minute-of-day', () => {
    const instant = zonedToUtc(2026, 7, 14, 17, 30) // a Tuesday
    expect(localWeekday(instant)).toBe(2)
    expect(localMinutes(instant)).toBe(17 * 60 + 30)
  })

  it('keeps 5pm on the same local day either side of a transition', () => {
    // The naive "+24h" approach breaks here: the spring-forward day is 23
    // hours long, so adding a fixed day lands at 6pm instead of 5pm.
    const before = zonedToUtc(2026, 3, 7, 17, 0)
    const naiveNextDay = before + DAY
    expect(localMinutes(naiveNextDay)).toBe(18 * 60)

    const ranges = localDayRanges(before, 3)
    expect(ranges.map((r) => zonedParts(r.start).day)).toEqual([7, 8, 9])
    expect(ranges.every((r) => localMinutes(r.start) === 0)).toBe(true)
  })

  it('produces 23- and 25-hour local days at the transitions', () => {
    const spring = localDayRanges(zonedToUtc(2026, 3, 8, 12, 0), 1)[0]!
    expect(spring.end - spring.start).toBe(23 * HOUR)

    const autumn = localDayRanges(zonedToUtc(2026, 11, 1, 12, 0), 1)[0]!
    expect(autumn.end - autumn.start).toBe(25 * HOUR)
  })

  it('floors to local midnight', () => {
    const instant = zonedToUtc(2026, 7, 14, 23, 45)
    expect(zonedParts(startOfLocalDay(instant))).toMatchObject({ day: 14, hour: 0, minute: 0 })
  })

  it('parses datetime-local input as Santa Fe time regardless of the browser', () => {
    expect(parseLocalInput('2026-07-14T17:30')).toBe(zonedToUtc(2026, 7, 14, 17, 30))
    expect(toLocalInput(zonedToUtc(2026, 7, 14, 17, 30))).toBe('2026-07-14T17:30')
  })
})

describe('court slot granules', () => {
  it('covers every half hour a booking touches', () => {
    const start = zonedToUtc(2026, 7, 14, 17, 0)
    const end = start + 90 * 60_000
    expect(slotStarts(start, end)).toEqual([start, start + 1800_000, start + 3600_000])
  })

  it('expands a partial half hour to the granules it overlaps', () => {
    const start = zonedToUtc(2026, 7, 14, 17, 15)
    const end = start + 30 * 60_000
    expect(slotStarts(start, end)).toHaveLength(2)
  })
})

describe('formatting', () => {
  it('renders minutes since midnight as a 12-hour clock', () => {
    expect(formatMinuteOfDay(0)).toBe('12:00 AM')
    expect(formatMinuteOfDay(9 * 60 + 5)).toBe('9:05 AM')
    expect(formatMinuteOfDay(12 * 60)).toBe('12:00 PM')
    expect(formatMinuteOfDay(17 * 60 + 30)).toBe('5:30 PM')
  })
})
