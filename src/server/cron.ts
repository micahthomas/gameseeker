import { and, eq, gt, gte, isNull, lt, lte, ne, sql } from 'drizzle-orm'
import { db } from '~/db/client'
import { clinicOccurrences, clinics, games, notifications } from '~/db/schema'
import { purgeExpiredAuthRows } from './auth'
import { getConfig } from './config'
import { completePastOccurrences, getClinicBrief, occurrenceAttendees } from './clinics'
import { countOpenSlots, gameParticipants, getGameBrief } from './games'
import { pushToInbox, pushToInboxes } from './live'
import { clinicReminderEntry, hostNudgeEntry, reminderEntry } from './live/entries'
import { enqueueNotifications, type NotifyMessage } from './notify/queue'
import { HOUR } from './time'

/**
 * Scheduled maintenance. Wired up in src/server.ts and configured in
 * wrangler.jsonc under `triggers.crons`.
 */

export type CronReport = {
  reminders: number
  clinicReminders: number
  nudges: number
  completed: number
  expired: number
}

export async function runHourly(now = Date.now()): Promise<CronReport> {
  const reminders = await sendDayBeforeReminders(now)
  const clinicReminders = await sendClinicReminders(now)
  const nudges = await nudgeShortHandedHosts(now)
  const expired = await expireStaleNotifications(now)
  return { reminders, clinicReminders, nudges, completed: 0, expired }
}

export async function runDaily(now = Date.now()): Promise<CronReport> {
  const completed = (await completePastGames(now)) + (await completePastOccurrences(now))
  await purgeExpiredAuthRows(now)
  return { reminders: 0, clinicReminders: 0, nudges: 0, completed, expired: 0 }
}

/**
 * Remind everyone holding a place in a clinic session, roughly 24 hours out.
 *
 * Same claim-then-act shape as the game reminder: `reminded_at` is stamped by
 * a guarded UPDATE first, so two overlapping cron runs can't both send.
 */
async function sendClinicReminders(now: number): Promise<number> {
  const due = await db()
    .select({ id: clinicOccurrences.id, clinicId: clinicOccurrences.clinicId })
    .from(clinicOccurrences)
    .innerJoin(clinics, eq(clinics.id, clinicOccurrences.clinicId))
    .where(
      and(
        eq(clinicOccurrences.status, 'scheduled'),
        eq(clinics.status, 'published'),
        isNull(clinicOccurrences.remindedAt),
        gte(clinicOccurrences.startsAt, now + 23 * HOUR),
        lt(clinicOccurrences.startsAt, now + 25 * HOUR),
      ),
    )

  const messages: NotifyMessage[] = []

  for (const occurrence of due) {
    const claimed = await db()
      .update(clinicOccurrences)
      .set({ remindedAt: now })
      .where(and(eq(clinicOccurrences.id, occurrence.id), isNull(clinicOccurrences.remindedAt)))
      .returning({ id: clinicOccurrences.id })
    if (claimed.length === 0) continue

    const attendees = await occurrenceAttendees(occurrence.id)
    if (attendees.length === 0) continue

    const brief = await getClinicBrief(occurrence.clinicId, occurrence.id, now)
    const clinicUrl = `${getConfig().appUrl}/clinics/${occurrence.clinicId}`
    if (brief) {
      await pushToInboxes(
        attendees.map((a) => a.id),
        () => clinicReminderEntry(brief, clinicUrl),
      )
    }

    for (const attendee of attendees) {
      messages.push({
        kind: 'clinic-reminder',
        clinicId: occurrence.clinicId,
        occurrenceId: occurrence.id,
        userId: attendee.id,
      })
    }
  }

  await enqueueNotifications(messages)
  return messages.length
}

/**
 * Remind everyone holding a seat, roughly 24 hours out. `reminded_at` is
 * stamped first so an overlapping cron run can't double-send.
 */
async function sendDayBeforeReminders(now: number): Promise<number> {
  const windowStart = now + 23 * HOUR
  const windowEnd = now + 25 * HOUR

  const due = await db()
    .select({ id: games.id })
    .from(games)
    .where(
      and(
        ne(games.status, 'cancelled'),
        ne(games.status, 'completed'),
        isNull(games.remindedAt),
        gte(games.startsAt, windowStart),
        lt(games.startsAt, windowEnd),
      ),
    )

  const messages: NotifyMessage[] = []

  for (const { id } of due) {
    const claimed = await db()
      .update(games)
      .set({ remindedAt: now })
      .where(and(eq(games.id, id), isNull(games.remindedAt)))
      .returning({ id: games.id })
    if (claimed.length === 0) continue

    const brief = await getGameBrief(id)
    if (!brief) continue
    const participants = await gameParticipants(id)
    if (participants.length === 0) continue

    for (const player of participants) {
      messages.push({ kind: 'reminder', gameId: id, userId: player.id })
    }
    await pushToInboxes(
      participants.map((p) => p.id),
      () => reminderEntry(brief, `${getConfig().appUrl}/games/${id}`),
    )
  }

  await enqueueNotifications(messages)
  return messages.length
}

/**
 * Tell a host their game is still short, about three hours out.
 *
 * Deliberately a nudge rather than an auto-cancel: three people with one empty
 * doubles seat usually still play, and silently deleting somebody's game is a
 * destructive act the software shouldn't take on its own. The host gets the
 * facts and the cancel button.
 */
async function nudgeShortHandedHosts(now: number): Promise<number> {
  const windowStart = now + 2 * HOUR
  const windowEnd = now + 4 * HOUR

  const due = await db()
    .select({ id: games.id, hostId: games.hostId })
    .from(games)
    .where(
      and(
        eq(games.status, 'open'),
        isNull(games.hostNudgedAt),
        gte(games.startsAt, windowStart),
        lt(games.startsAt, windowEnd),
      ),
    )

  const messages: NotifyMessage[] = []

  for (const row of due) {
    const claimed = await db()
      .update(games)
      .set({ hostNudgedAt: now })
      .where(and(eq(games.id, row.id), isNull(games.hostNudgedAt)))
      .returning({ id: games.id })
    if (claimed.length === 0) continue

    const open = await countOpenSlots(row.id)
    if (open === 0) continue

    const brief = await getGameBrief(row.id)
    if (!brief) continue

    const participants = await gameParticipants(row.id)
    const host = participants.find((p) => p.id === row.hostId)
    if (!host) continue

    messages.push({ kind: 'host-nudge', gameId: row.id, userId: host.id })
    await pushToInbox(host.id, hostNudgeEntry(brief, open, `${getConfig().appUrl}/games/${row.id}`))
  }

  await enqueueNotifications(messages)
  return messages.length
}

/** Flip finished games to `completed` so they leave the upcoming lists. */
async function completePastGames(now: number): Promise<number> {
  const updated = await db()
    .update(games)
    .set({ status: 'completed' })
    .where(
      and(
        lt(games.endsAt, now),
        sql`${games.status} IN ('open', 'full')`,
      ),
    )
    .returning({ id: games.id })
  return updated.length
}

/** Claim links for games that already started are dead; mark them so. */
async function expireStaleNotifications(now: number): Promise<number> {
  const updated = await db()
    .update(notifications)
    .set({ status: 'expired' })
    .where(
      and(
        eq(notifications.status, 'sent'),
        sql`${notifications.gameId} IN (SELECT id FROM games WHERE starts_at < ${now} OR status = 'cancelled')`,
      ),
    )
    .returning({ id: notifications.id })
  return updated.length
}

/** Entry point called from the Worker's scheduled handler. */
export async function runCron(cronExpression: string): Promise<CronReport> {
  const now = Date.now()
  // "0 4 * * *" is the daily sweep; anything else is the hourly pass.
  if (cronExpression.startsWith('0 4 ')) return runDaily(now)
  return runHourly(now)
}
