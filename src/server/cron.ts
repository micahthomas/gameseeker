import { and, eq, gt, gte, isNull, lt, lte, ne, sql } from 'drizzle-orm'
import { db } from '~/db/client'
import { games, notifications } from '~/db/schema'
import { purgeExpiredAuthRows } from './auth'
import { countOpenSlots, gameParticipants, getGameBrief } from './games'
import { enqueueNotifications, type NotifyMessage } from './notify/queue'
import { HOUR } from './time'

/**
 * Scheduled maintenance. Wired up in src/server.ts and configured in
 * wrangler.jsonc under `triggers.crons`.
 */

export type CronReport = {
  reminders: number
  nudges: number
  completed: number
  expired: number
}

export async function runHourly(now = Date.now()): Promise<CronReport> {
  const reminders = await sendDayBeforeReminders(now)
  const nudges = await nudgeShortHandedHosts(now)
  const expired = await expireStaleNotifications(now)
  return { reminders, nudges, completed: 0, expired }
}

export async function runDaily(now = Date.now()): Promise<CronReport> {
  const completed = await completePastGames(now)
  await purgeExpiredAuthRows(now)
  return { reminders: 0, nudges: 0, completed, expired: 0 }
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

    if (!(await getGameBrief(id))) continue
    const participants = await gameParticipants(id)
    if (participants.length === 0) continue

    for (const player of participants) {
      messages.push({ kind: 'reminder', gameId: id, userId: player.id })
    }
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

    if (!(await getGameBrief(row.id))) continue

    const participants = await gameParticipants(row.id)
    const host = participants.find((p) => p.id === row.hostId)
    if (!host) continue

    messages.push({ kind: 'host-nudge', gameId: row.id, userId: host.id })
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
