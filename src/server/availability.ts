import { and, asc, eq, gt, lt, sql } from 'drizzle-orm'
import { db } from '~/db/client'
import {
  availabilityBlocks,
  availabilityRules,
  type AvailabilityBlock,
  type AvailabilityRule,
  type FormatPref,
  type GameFormat,
} from '~/db/schema'
import { newId } from './tokens'
import { localMinutes, localWeekday, startOfLocalDay, zonedParts, zonedToUtc, DAY } from './time'

/**
 * A game window is "covered" for a player when a recurring rule or a one-off
 * available block spans the whole window, and no busy block overlaps it.
 * Busy always wins — that's what makes it usable as a vacation override.
 */

export type WindowDescriptor = {
  startsAt: number
  endsAt: number
  weekday: number
  startMinute: number
  endMinute: number
  /** True when the window doesn't fall inside a single local day. */
  spansLocalDays: boolean
}

/** Precompute the local-time facts a coverage check needs. */
export function describeWindow(startsAt: number, endsAt: number): WindowDescriptor {
  const startDay = startOfLocalDay(startsAt)
  // endsAt is exclusive: a game ending exactly at midnight still belongs to the
  // previous day, so probe one millisecond earlier.
  const endDay = startOfLocalDay(endsAt - 1)
  const startMinute = localMinutes(startsAt)
  const rawEndMinute = localMinutes(endsAt)
  return {
    startsAt,
    endsAt,
    weekday: localWeekday(startsAt),
    startMinute,
    // Normalize a midnight end to 1440 so "ends at 24:00" compares correctly.
    endMinute: rawEndMinute === 0 ? 24 * 60 : rawEndMinute,
    spansLocalDays: startDay !== endDay,
  }
}

function formatMatches(column: string, format: GameFormat): string {
  return `(${column} = 'either' OR ${column} = '${format}')`
}

/**
 * SQL fragment: does user `u` have availability covering this window?
 * Shared by the single-user check and the bulk matching query so the two can
 * never drift apart.
 */
export function availabilityCoverageSql(w: WindowDescriptor, format: GameFormat) {
  // A window crossing local midnight can't be covered by a weekday rule, so we
  // fall back to blocks only rather than silently matching the wrong day.
  const ruleClause = w.spansLocalDays
    ? sql`0`
    : sql`EXISTS (
        SELECT 1 FROM availability_rules r
        WHERE r.user_id = u.id
          AND r.is_active = 1
          AND r.weekday = ${w.weekday}
          AND r.start_minute <= ${w.startMinute}
          AND r.end_minute >= ${w.endMinute}
          AND r.effective_from <= ${w.startsAt}
          AND (r.effective_until IS NULL OR r.effective_until >= ${w.endsAt})
          AND ${sql.raw(formatMatches('r.format_pref', format))}
      )`

  return sql`(
    (
      ${ruleClause}
      OR EXISTS (
        SELECT 1 FROM availability_blocks b
        WHERE b.user_id = u.id
          AND b.kind = 'available'
          AND b.starts_at <= ${w.startsAt}
          AND b.ends_at >= ${w.endsAt}
          AND ${sql.raw(formatMatches('b.format_pref', format))}
      )
    )
    AND NOT EXISTS (
      SELECT 1 FROM availability_blocks x
      WHERE x.user_id = u.id
        AND x.kind = 'busy'
        AND x.starts_at < ${w.endsAt}
        AND x.ends_at > ${w.startsAt}
    )
  )`
}

/** Whether one specific player is free for a window. */
export async function userIsAvailable(
  userId: string,
  startsAt: number,
  endsAt: number,
  format: GameFormat,
): Promise<boolean> {
  const w = describeWindow(startsAt, endsAt)
  const rows = await db().all<{ ok: number }>(sql`
    SELECT ${availabilityCoverageSql(w, format)} AS ok
    FROM users u WHERE u.id = ${userId}
  `)
  return rows[0]?.ok === 1
}

// ---------------------------------------------------------------------------
// Expansion for calendar rendering
// ---------------------------------------------------------------------------

export type AvailabilityWindow = {
  startsAt: number
  endsAt: number
  formatPref: FormatPref
  source: 'rule' | 'block'
  sourceId: string
  note?: string | null
}

/**
 * Turn recurring rules into concrete windows across a date range, then layer
 * one-off blocks on top and subtract busy time. This is what the availability
 * calendar and the "who could play?" preview render from.
 *
 * Days are stepped in local time (not by adding 24h) so a DST transition
 * shifts the window with the wall clock rather than sliding it an hour.
 */
export function expandAvailability(
  rules: AvailabilityRule[],
  blocks: AvailabilityBlock[],
  rangeStart: number,
  rangeEnd: number,
): AvailabilityWindow[] {
  const windows: AvailabilityWindow[] = []

  const firstDay = startOfLocalDay(rangeStart)
  for (let day = firstDay; day < rangeEnd; ) {
    const parts = zonedParts(day)
    const weekday = parts.weekday

    for (const rule of rules) {
      if (!rule.isActive || rule.weekday !== weekday) continue
      const startsAt = zonedToUtc(parts.year, parts.month, parts.day, 0, rule.startMinute)
      const endsAt = zonedToUtc(parts.year, parts.month, parts.day, 0, rule.endMinute)
      if (endsAt <= rangeStart || startsAt >= rangeEnd) continue
      if (rule.effectiveFrom > startsAt) continue
      if (rule.effectiveUntil !== null && rule.effectiveUntil < endsAt) continue
      windows.push({
        startsAt,
        endsAt,
        formatPref: rule.formatPref,
        source: 'rule',
        sourceId: rule.id,
      })
    }

    // Step to the next local midnight. Adding DAY then re-flooring keeps this
    // correct across the 23- and 25-hour days.
    const next = startOfLocalDay(day + DAY + 2 * 60 * 60 * 1000)
    day = next > day ? next : day + DAY
  }

  for (const block of blocks) {
    if (block.kind !== 'available') continue
    if (block.endsAt <= rangeStart || block.startsAt >= rangeEnd) continue
    windows.push({
      startsAt: block.startsAt,
      endsAt: block.endsAt,
      formatPref: block.formatPref,
      source: 'block',
      sourceId: block.id,
      note: block.note,
    })
  }

  const busy = blocks.filter((b) => b.kind === 'busy')
  const result = windows.flatMap((w) => subtractBusy(w, busy))
  return result.sort((a, b) => a.startsAt - b.startsAt)
}

/** Remove busy intervals from an available window, possibly splitting it. */
function subtractBusy(window: AvailabilityWindow, busy: AvailabilityBlock[]): AvailabilityWindow[] {
  let pieces: AvailabilityWindow[] = [window]
  for (const b of busy) {
    const next: AvailabilityWindow[] = []
    for (const piece of pieces) {
      if (b.endsAt <= piece.startsAt || b.startsAt >= piece.endsAt) {
        next.push(piece)
        continue
      }
      if (b.startsAt > piece.startsAt) {
        next.push({ ...piece, endsAt: b.startsAt })
      }
      if (b.endsAt < piece.endsAt) {
        next.push({ ...piece, startsAt: b.endsAt })
      }
    }
    pieces = next
  }
  return pieces
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export async function listRules(userId: string): Promise<AvailabilityRule[]> {
  return db()
    .select()
    .from(availabilityRules)
    .where(eq(availabilityRules.userId, userId))
    .orderBy(asc(availabilityRules.weekday), asc(availabilityRules.startMinute))
}

export async function listBlocks(
  userId: string,
  fromMs: number,
  toMs: number,
): Promise<AvailabilityBlock[]> {
  return db()
    .select()
    .from(availabilityBlocks)
    .where(
      and(
        eq(availabilityBlocks.userId, userId),
        lt(availabilityBlocks.startsAt, toMs),
        gt(availabilityBlocks.endsAt, fromMs),
      ),
    )
    .orderBy(asc(availabilityBlocks.startsAt))
}

export async function addRule(input: {
  userId: string
  weekday: number
  startMinute: number
  endMinute: number
  formatPref: FormatPref
  /**
   * When the pattern starts applying. Defaults to now, but the calendar passes
   * the start of the day the rule was drawn on: painting a repeating time onto
   * a day earlier this week and seeing nothing appear reads as a bug, even
   * though a rule that started "now" genuinely doesn't cover a past Tuesday.
   * Backdating costs nothing — matching only ever looks at future games.
   */
  effectiveFrom?: number
  effectiveUntil?: number | null
}): Promise<AvailabilityRule> {
  if (input.endMinute <= input.startMinute) {
    throw new Error('End time must be after start time')
  }
  const now = Date.now()
  const rows = await db()
    .insert(availabilityRules)
    .values({
      id: newId(),
      userId: input.userId,
      weekday: input.weekday,
      startMinute: input.startMinute,
      endMinute: input.endMinute,
      formatPref: input.formatPref,
      effectiveFrom: input.effectiveFrom ?? now,
      effectiveUntil: input.effectiveUntil ?? null,
      isActive: true,
      createdAt: now,
    })
    .returning()
  return rows[0]!
}

export async function addBlock(input: {
  userId: string
  startsAt: number
  endsAt: number
  kind: 'available' | 'busy'
  formatPref: FormatPref
  note?: string | null
}): Promise<AvailabilityBlock> {
  if (input.endsAt <= input.startsAt) {
    throw new Error('End time must be after start time')
  }
  const rows = await db()
    .insert(availabilityBlocks)
    .values({
      id: newId(),
      userId: input.userId,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      kind: input.kind,
      formatPref: input.formatPref,
      note: input.note ?? null,
      createdAt: Date.now(),
    })
    .returning()
  return rows[0]!
}

export async function deleteRule(userId: string, ruleId: string): Promise<void> {
  await db()
    .delete(availabilityRules)
    .where(and(eq(availabilityRules.id, ruleId), eq(availabilityRules.userId, userId)))
}

export async function deleteBlock(userId: string, blockId: string): Promise<void> {
  await db()
    .delete(availabilityBlocks)
    .where(and(eq(availabilityBlocks.id, blockId), eq(availabilityBlocks.userId, userId)))
}
