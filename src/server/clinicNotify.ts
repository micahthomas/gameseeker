import { getConfig } from './config'
import {
  cancelClinic,
  cancelOccurrence,
  getClinicBrief,
  occurrenceAttendees,
  publishClinic,
} from './clinics'
import { broadcastToLocation, pushToInbox, pushToInboxes } from './live'
import {
  clinicAnnouncedEntry,
  clinicCancelledEntry,
  clinicSignupEntry,
} from './live/entries'
import { db } from '~/db/client'
import { clinicOccurrences, courts } from '~/db/schema'
import { and, eq, gte } from 'drizzle-orm'
import { enqueueNotifications, type NotifyMessage } from './notify/queue'

/**
 * Telling people about clinics.
 *
 * Separate from `clinics.ts` for one structural reason: the queue consumer
 * imports `getClinicBrief`, so `clinics.ts` cannot import the queue back
 * without a cycle. The rules about *what happens* stay one layer down; this
 * file only decides who is told and over which channel — the same split
 * `matching.ts` has with `games.ts`.
 */

/**
 * Announce that a clinic session changed to whoever is watching that day view.
 *
 * The sibling of `announceGameChanged`, resolving the location through the
 * occurrence's court so callers only have to know the session. Reuses the
 * existing `game.changed` event rather than adding one: the event says only
 * that something moved, and the client refetches through the loader either
 * way. Best-effort — D1 was already written.
 */
export async function announceClinicChanged(occurrenceId: string): Promise<void> {
  try {
    const rows = await db()
      .select({
        locationId: courts.locationId,
        courtId: clinicOccurrences.courtId,
        startsAt: clinicOccurrences.startsAt,
      })
      .from(clinicOccurrences)
      .innerJoin(courts, eq(courts.id, clinicOccurrences.courtId))
      .where(eq(clinicOccurrences.id, occurrenceId))
      .limit(1)

    const row = rows[0]
    if (!row) return
    await broadcastToLocation(row.locationId, {
      type: 'clinic.changed',
      occurrenceId,
      courtId: row.courtId,
      startsAt: row.startsAt,
    })
  } catch (error) {
    console.error('clinic announce failed for', occurrenceId, error)
  }
}

/** Publish a clinic and tell the players who asked to hear about them. */
export async function announceClinic(clinicId: string): Promise<{ notified: number }> {
  const { notified } = await publishClinic(clinicId)
  if (notified.length === 0) return { notified: 0 }

  const brief = await getClinicBrief(clinicId)
  const { appUrl } = getConfig()
  const clinicUrl = `${appUrl}/clinics/${clinicId}`

  // Bell first (direct, milliseconds), email second (queued, seconds) — the
  // same ordering the game fan-out uses.
  if (brief) await pushToInboxes(notified, () => clinicAnnouncedEntry(brief, clinicUrl))

  await enqueueNotifications(
    notified.map((userId) => ({ kind: 'clinic-announced' as const, clinicId, userId })),
  )
  return { notified: notified.length }
}

/** Confirm a place to the player who just took it. */
export async function notifyClinicSignup(
  clinicId: string,
  occurrenceId: string,
  userId: string,
): Promise<void> {
  const brief = await getClinicBrief(clinicId, occurrenceId)
  const { appUrl } = getConfig()
  const clinicUrl = `${appUrl}/clinics/${clinicId}`

  await announceClinicChanged(occurrenceId)
  if (brief) await pushToInbox(userId, clinicSignupEntry(brief, clinicUrl))
  await enqueueNotifications([{ kind: 'clinic-signup', clinicId, occurrenceId, userId }])
}

/**
 * Call off one date and tell everyone holding a place.
 *
 * The roster is read **before** the cancellation, because cancelling deletes
 * the signups — read it after and there is nobody left to tell.
 */
export async function cancelOccurrenceAndTell(
  clinicId: string,
  occurrenceId: string,
  reason: string,
): Promise<void> {
  const attendees = await occurrenceAttendees(occurrenceId)
  const brief = await getClinicBrief(clinicId, occurrenceId)

  await cancelOccurrence(occurrenceId)
  await announceClinicChanged(occurrenceId)

  if (attendees.length === 0) return
  const { appUrl } = getConfig()
  const clinicUrl = `${appUrl}/clinics/${clinicId}`

  if (brief) {
    await pushToInboxes(
      attendees.map((a) => a.id),
      () => clinicCancelledEntry(brief, reason, clinicUrl),
    )
  }
  await enqueueNotifications(
    attendees.map((attendee) => ({
      kind: 'clinic-cancelled' as const,
      clinicId,
      occurrenceId,
      userId: attendee.id,
      reason,
    })),
  )
}

/** Call off the whole series, telling each date's roster about that date. */
export async function cancelClinicAndTell(clinicId: string, reason: string): Promise<void> {
  // Only the dates still to come. `cancelClinic` leaves past sessions alone
  // because they happened, and mailing their rosters about a cancellation
  // would be telling people a session they attended is off.
  const upcoming = await db()
    .select({ id: clinicOccurrences.id })
    .from(clinicOccurrences)
    .where(
      and(
        eq(clinicOccurrences.clinicId, clinicId),
        eq(clinicOccurrences.status, 'scheduled'),
        gte(clinicOccurrences.startsAt, Date.now()),
      ),
    )

  const rosters = await Promise.all(
    upcoming.map(async (o) => ({ id: o.id, attendees: await occurrenceAttendees(o.id) })),
  )

  await cancelClinic(clinicId, reason)

  const { appUrl } = getConfig()
  const clinicUrl = `${appUrl}/clinics/${clinicId}`
  const messages: NotifyMessage[] = []

  for (const roster of rosters) {
    await announceClinicChanged(roster.id)
    if (roster.attendees.length === 0) continue

    const brief = await getClinicBrief(clinicId, roster.id)
    if (brief) {
      await pushToInboxes(
        roster.attendees.map((a) => a.id),
        () => clinicCancelledEntry(brief, reason, clinicUrl),
      )
    }
    for (const attendee of roster.attendees) {
      messages.push({
        kind: 'clinic-cancelled',
        clinicId,
        occurrenceId: roster.id,
        userId: attendee.id,
        reason,
      })
    }
  }

  await enqueueNotifications(messages)
}

/** The answer to a request to run clinics. */
export async function notifyOrganizerDecision(userId: string, approved: boolean): Promise<void> {
  await enqueueNotifications([{ kind: 'organizer-decision', userId, approved }])
}
