import { env } from 'cloudflare:workers'
import { eq, and } from 'drizzle-orm'
import { db } from '~/db/client'
import { games, notifications, users } from '~/db/schema'
import { getConfig } from '../config'
import { getClinicBrief } from '../clinics'
import { countOpenSlots, gameParticipants, getGameBrief } from '../games'
import { notifyUser } from './index'
import {
  cancelledEmail,
  clinicAnnouncedEmail,
  clinicCancelledEmail,
  clinicReminderEmail,
  clinicSignupEmail,
  clinicSignupSms,
  gameOnEmail,
  organizerDecisionEmail,
  hostFilledEmail,
  reminderEmail,
  reminderSms,
  seekerAlertEmail,
  seekerAlertSms,
  spotConfirmedEmail,
  unplaceableEmail,
  venueOf,
} from './templates'

/**
 * Outbound notifications, moved off the request path onto Cloudflare Queues.
 *
 * A host posting a game to twenty available players should not wait on twenty
 * third-party HTTP round trips before seeing their game. What stays in the
 * request is the part that has to be transactional — writing the notification
 * rows — and what leaves is the slow, retryable, failure-prone part.
 *
 * Two rules shape everything here.
 *
 * **Messages carry ids, not rendered bodies.** The consumer re-reads current
 * state before it renders, so a game cancelled between enqueue and delivery
 * can't produce a cheerful "come play tomorrow" email. Enqueuing a finished
 * body would freeze the world at the moment of the request.
 *
 * **Rows are written before the message exists.** Queues are at-least-once, so
 * a retry can deliver twice. The unique index on `notifications
 * (user_id, game_id)` is what prevents that, and it only helps if the insert
 * happens first — see `notifyCandidatesForGame` in `../matching.ts`.
 */

export type NotifyMessage =
  /** You could fill an open seat in this game. Carries a claim link. */
  | { kind: 'seeker-alert'; gameId: string; userId: string }
  /** You claimed a seat and it's yours. */
  | { kind: 'spot-confirmed'; gameId: string; userId: string }
  /** Someone took a seat in the game you're hosting. */
  | { kind: 'host-filled'; gameId: string; userId: string; playerName: string }
  /** The game is off. */
  | { kind: 'game-cancelled'; gameId: string; userId: string; reason: string }
  /** Cron, roughly a day out. */
  | { kind: 'reminder'; gameId: string; userId: string }
  /** Cron, a few hours out, to a host whose game is still short. */
  | { kind: 'host-nudge'; gameId: string; userId: string }
  /** The game filled, but every court the host offered had gone. */
  | { kind: 'unplaceable'; gameId: string; userId: string }
  /**
   * The last seat went and a court was assigned. Goes to every player, not
   * only the one who claimed — this is the first message that can name the
   * court, and it is the one that carries the calendar invite.
   */
  | { kind: 'game-on'; gameId: string; userId: string }
  /** A clinic was published, to players who asked to hear about them. */
  | { kind: 'clinic-announced'; clinicId: string; userId: string }
  /** You took a place on one date. */
  | { kind: 'clinic-signup'; clinicId: string; occurrenceId: string; userId: string }
  /** A date, or the whole series, was called off. */
  | {
      kind: 'clinic-cancelled'
      clinicId: string
      occurrenceId: string | null
      userId: string
      reason: string
    }
  /** Cron, roughly a day out. */
  | { kind: 'clinic-reminder'; clinicId: string; occurrenceId: string; userId: string }
  /** The answer to a request to run clinics. */
  | { kind: 'organizer-decision'; userId: string; approved: boolean }

/** Queues caps a single `sendBatch` at 100 messages. */
const MAX_BATCH = 100

/**
 * The binding is declared in wrangler.jsonc, so the generated `Env` types it as
 * always present — but it genuinely is absent in the unit-test worker, which
 * builds its bindings by hand. Hence the optional read rather than `env.NOTIFY_QUEUE`.
 */
function notifyQueue(): Queue<NotifyMessage> | null {
  const bound = (env as Partial<Env>).NOTIFY_QUEUE
  return (bound as Queue<NotifyMessage> | undefined) ?? null
}

/**
 * Hand messages to the queue, or deliver them inline if there's no queue bound.
 *
 * The inline path is not a test shim — it's what keeps the app runnable in an
 * environment without Queues configured, and it goes through exactly the same
 * `handleNotifyMessage` the consumer uses, so the two can't render differently.
 * Only the timing differs.
 *
 * `sendBatch` is a single call regardless of recipient count, so callers can
 * await this without reintroducing the fan-out they just removed.
 */
export async function enqueueNotifications(messages: NotifyMessage[]): Promise<void> {
  if (messages.length === 0) return

  const queue = notifyQueue()
  if (!queue) {
    warnOnceAboutInlineDelivery()
    for (const message of messages) {
      // Same swallow-and-continue rule as the consumer: one bad recipient
      // must not abort the rest.
      await handleNotifyMessage(message).catch((error) => {
        console.error('inline notify failed:', message.kind, message.userId, error)
      })
    }
    return
  }

  for (let i = 0; i < messages.length; i += MAX_BATCH) {
    const chunk = messages.slice(i, i + MAX_BATCH)
    await queue.sendBatch(chunk.map((body) => ({ body })))
  }
}

let warnedAboutInlineDelivery = false

/**
 * Falling back is legitimate, but in a deployed Worker it means NOTIFY_QUEUE
 * didn't bind and every host is paying for the fan-out in their own request —
 * exactly the thing the queue exists to prevent. Say so, once per isolate.
 */
function warnOnceAboutInlineDelivery(): void {
  if (warnedAboutInlineDelivery) return
  warnedAboutInlineDelivery = true
  console.warn('NOTIFY_QUEUE is not bound; delivering notifications inline.')
}

type Recipient = {
  id: string
  name: string
  email: string
  phone: string | null
  notifyEmail: boolean
  notifySms: boolean
}

async function recipient(userId: string): Promise<Recipient | null> {
  const rows = await db()
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      phone: users.phone,
      notifyEmail: users.notifyEmail,
      notifySms: users.notifySms,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  return rows[0] ?? null
}

/**
 * Render and deliver one message, against state as it is *now*.
 *
 * Throwing here asks the queue to retry the message. That's right for a
 * transient delivery failure and wrong for a permanent one, so the cases we
 * know are permanent — deleted game, deleted player, a game that has since
 * been cancelled — return quietly instead.
 */
export async function handleNotifyMessage(message: NotifyMessage): Promise<void> {
  const player = await recipient(message.userId)
  if (!player) return

  const { appUrl: base } = getConfig()

  if (message.kind === 'organizer-decision') {
    await notifyUser(player, organizerDecisionEmail(message.approved, base))
    return
  }

  if ('clinicId' in message) return handleClinicMessage(message, player)

  const brief = await getGameBrief(message.gameId)
  if (!brief) return

  const rows = await db()
    .select({ status: games.status, hostId: games.hostId })
    .from(games)
    .where(eq(games.id, message.gameId))
    .limit(1)
  const game = rows[0]
  if (!game) return

  // The whole reason messages carry ids: between enqueue and delivery the
  // game may have been called off, and every message except the cancellation
  // itself would now be a lie.
  if (game.status === 'cancelled' && message.kind !== 'game-cancelled') return

  const gameUrl = `${base}/games/${message.gameId}`

  switch (message.kind) {
    case 'seeker-alert': {
      // The claim token lives on the notification row written in the request
      // path. Reading it here rather than carrying it in the message means a
      // redelivered message can never present a token that has been replaced.
      const invite = await db()
        .select({ claimToken: notifications.claimToken, seekerNtrp: notifications.seekerNtrp })
        .from(notifications)
        .where(
          and(eq(notifications.userId, message.userId), eq(notifications.gameId, message.gameId)),
        )
        .limit(1)
      const row = invite[0]
      if (!row) return

      const level = row.seekerNtrp ?? 0
      const claimUrl = `${base}/claim/${row.claimToken}`
      const result = await notifyUser(
        player,
        seekerAlertEmail(brief, level, claimUrl),
        seekerAlertSms(brief, level, claimUrl),
      )

      if (result.channels.length === 0) {
        await db()
          .update(notifications)
          .set({ status: 'failed', error: result.errors.map((e) => e.message).join('; ') })
          .where(eq(notifications.claimToken, row.claimToken))
      }
      return
    }

    case 'spot-confirmed':
      await notifyUser(player, spotConfirmedEmail(brief, gameUrl))
      return

    case 'host-filled': {
      // Re-read rather than trusting a count taken at claim time: by now
      // another seat may have gone, and the fresher number is the useful one.
      const remaining = await countOpenSlots(message.gameId)
      await notifyUser(player, hostFilledEmail(brief, message.playerName, remaining, gameUrl))
      return
    }

    case 'game-cancelled':
      await notifyUser(
        player,
        cancelledEmail(brief, message.reason, gameUrl, { name: player.name, email: player.email }),
      )
      return

    case 'game-on': {
      // Re-read rather than trusting the status at enqueue time: a player may
      // have dropped out since, which puts the game back to 'open' and makes
      // "your game is on" wrong.
      if (game.status !== 'full') return
      const roster = (await gameParticipants(message.gameId)).map((p) => p.name)
      await notifyUser(
        player,
        gameOnEmail(brief, gameUrl, roster, { name: player.name, email: player.email }),
      )
      return
    }

    case 'unplaceable': {
      // Re-read: the host may already have moved it, in which case there's
      // nothing to apologise for.
      if (game.status !== 'unplaceable') return
      await notifyUser(player, unplaceableEmail(brief, gameUrl))
      return
    }

    case 'reminder': {
      const roster = (await gameParticipants(message.gameId)).map((p) => p.name)
      await notifyUser(player, reminderEmail(brief, roster, gameUrl), reminderSms(brief, gameUrl))
      return
    }

    case 'host-nudge': {
      const open = await countOpenSlots(message.gameId)
      // The game filled up while this sat in the queue — nothing to nudge about.
      if (open === 0) return
      const text = `Your game at ${venueOf(brief)} still has ${open} open spot${
        open === 1 ? '' : 's'
      }. You can cancel or keep waiting: ${gameUrl}`
      await notifyUser(
        player,
        {
          subject: `Your game still needs ${open} player${open === 1 ? '' : 's'}`,
          text,
          html: `<p>${text}</p>`,
        },
        text,
      )
      return
    }
  }
}

/**
 * The clinic half of the consumer.
 *
 * Same rule as the game half, which is the reason it re-reads at all: a
 * session cancelled between enqueue and delivery must not produce a cheerful
 * "see you Tuesday", so everything except the cancellation itself bails out
 * once the clinic or the date has been called off.
 */
async function handleClinicMessage(
  message: Extract<NotifyMessage, { clinicId: string }>,
  player: Recipient,
): Promise<void> {
  const occurrenceId = 'occurrenceId' in message ? message.occurrenceId : null
  const brief = await getClinicBrief(message.clinicId, occurrenceId)
  if (!brief) return

  const { appUrl } = getConfig()
  const clinicUrl = `${appUrl}/clinics/${message.clinicId}`
  const calledOff = brief.clinicStatus === 'cancelled' || brief.occurrenceStatus === 'cancelled'
  if (calledOff && message.kind !== 'clinic-cancelled') return

  const attendee = { name: player.name, email: player.email }

  switch (message.kind) {
    case 'clinic-announced':
      // Nothing left to sign up for — the series ran out while this waited.
      if (brief.upcoming === 0) return
      await notifyUser(player, clinicAnnouncedEmail(brief, clinicUrl))
      return

    case 'clinic-signup':
      if (!brief.startsAt) return
      await notifyUser(
        player,
        clinicSignupEmail(brief, clinicUrl, attendee),
        clinicSignupSms(brief, clinicUrl),
      )
      return

    case 'clinic-reminder':
      if (!brief.startsAt) return
      await notifyUser(player, clinicReminderEmail(brief, clinicUrl))
      return

    case 'clinic-cancelled':
      await notifyUser(player, clinicCancelledEmail(brief, message.reason, clinicUrl, attendee))
      return
  }
}

/**
 * Queue consumer entry point, called from the Worker's `queue` export.
 *
 * Ack and retry per message, never per batch: one address that bounces must
 * not force nineteen good deliveries to be redelivered — and with the
 * `(user_id, game_id)` index doing dedupe at insert time, a redelivered
 * seeker alert would go out again.
 */
export async function handleNotifyBatch(batch: MessageBatch<NotifyMessage>): Promise<void> {
  for (const message of batch.messages) {
    try {
      await handleNotifyMessage(message.body)
      message.ack()
    } catch (error) {
      console.error('notify message failed, retrying:', message.body?.kind, error)
      message.retry()
    }
  }
}
