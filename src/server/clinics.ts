import { and, asc, desc, eq, gte, inArray, lt, ne, sql } from 'drizzle-orm'
import { d1, db } from '~/db/client'
import {
  clinicNotifications,
  clinicOccurrences,
  clinicSignups,
  clinics,
  courtSlotLocks,
  courts,
  locations,
  playerSlotLocks,
  users,
  type Clinic,
  type ClinicOccurrence,
} from '~/db/schema'
import { batchOf, violates } from './batch'
import { lockSlotsFor } from './booking'
import { newId } from './tokens'
import {
  HOUR,
  MINUTE,
  addLocalDays,
  localWeekday,
  startOfLocalDay,
  zonedParts,
  zonedToUtc,
} from './time'

/**
 * Clinics: an organizer holding a court on a schedule and selling seats into
 * it — cardio tennis, a drills hour, a junior session.
 *
 * **A clinic takes its courts when it is created, and a game does not.** That
 * looks like an inconsistency and isn't. A game holds nothing while it fills
 * because it may never fill, and blocking five courts on behalf of a group
 * that never assembles is worse than losing a court to whoever books it first.
 * A clinic has already assembled: one person has committed to being there, and
 * it runs whether or not anybody signs up. Holding the court is the whole
 * point of creating one.
 *
 * What does *not* change is who settles the collision. Clinic court locks go
 * into the same `court_slot_locks` table as games, under the same
 * `(court_id, slot_start)` primary key. A separate table would let a game and
 * a clinic be sent to the same court at the same hour.
 */

export class ClinicValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ClinicValidationError'
  }
}

export class ClinicFullError extends Error {
  constructor() {
    super('That session just filled up.')
    this.name = 'ClinicFullError'
  }
}

export class AlreadySignedUpError extends Error {
  constructor() {
    super("You're already signed up for that session.")
    this.name = 'AlreadySignedUpError'
  }
}

export class PlayerBusyError extends Error {
  constructor() {
    super("You're already booked at that time.")
    this.name = 'PlayerBusyError'
  }
}

export const MIN_DURATION = 30 * MINUTE
export const MAX_DURATION = 4 * HOUR
/**
 * Half a year of weekly sessions. A bound rather than a policy: creation writes
 * every occurrence and every one of its court locks in a single batch, and an
 * unbounded series would make that batch unbounded too.
 */
export const MAX_OCCURRENCES = 26
export const MAX_CAPACITY = 40

export type RecurrenceInput = {
  /** 0 = Sunday .. 6 = Saturday, in Santa Fe local time. */
  weekdays: number[]
  /** Minutes from local midnight, e.g. 18:00 => 1080. */
  startMinute: number
  endMinute: number
  /** Local days; only the date part is used. */
  from: number
  until: number
}

/**
 * Every date a recurrence lands on.
 *
 * The recurrence is stored as **local wall-clock**, exactly like
 * `availability_rules`, and expanded here — so a 6pm Tuesday clinic is still
 * at 6pm after the clocks change. Stepping by a fixed 86,400,000 ms would put
 * half the series an hour out, which is the failure `addLocalDays` exists to
 * prevent.
 *
 * Materialised into rows rather than expanded on read, which is the opposite
 * of what availability does. It has to be: a court is held by rows in
 * `court_slot_locks`, and those have nothing to point at unless each date is
 * a row of its own.
 */
export function generateOccurrences(
  recurrence: RecurrenceInput,
): Array<{ startsAt: number; endsAt: number }> {
  const weekdays = new Set(recurrence.weekdays)
  const out: Array<{ startsAt: number; endsAt: number }> = []

  let cursor = startOfLocalDay(recurrence.from)
  const last = startOfLocalDay(recurrence.until)

  while (cursor <= last && out.length < MAX_OCCURRENCES) {
    if (weekdays.has(localWeekday(cursor))) {
      const day = zonedParts(cursor)
      out.push({
        // Minute-of-day rather than an offset from midnight: on a 23-hour
        // spring-forward day those two are not the same instant.
        startsAt: zonedToUtc(day.year, day.month, day.day, 0, recurrence.startMinute),
        endsAt: zonedToUtc(day.year, day.month, day.day, 0, recurrence.endMinute),
      })
    }
    cursor = addLocalDays(cursor, 1)
  }

  return out
}

export type CreateClinicInput = {
  organizerId: string
  locationId: string
  courtId: string
  title: string
  descriptionMd: string
  costNote: string | null
  heroKey: string | null
  heroWidth: number | null
  heroHeight: number | null
  capacity: number
  recurrence: RecurrenceInput
}

function validate(input: CreateClinicInput, dates: Array<{ startsAt: number; endsAt: number }>) {
  if (!input.title.trim()) throw new ClinicValidationError('Give the clinic a name.')
  if (input.capacity < 1 || input.capacity > MAX_CAPACITY) {
    throw new ClinicValidationError(`Capacity has to be between 1 and ${MAX_CAPACITY}.`)
  }
  if (input.recurrence.weekdays.length === 0) {
    throw new ClinicValidationError('Pick at least one day of the week.')
  }
  if (dates.length === 0) {
    throw new ClinicValidationError('That date range contains none of the days you picked.')
  }

  const duration = input.recurrence.endMinute - input.recurrence.startMinute
  if (duration < MIN_DURATION / MINUTE) {
    throw new ClinicValidationError('A session has to be at least 30 minutes.')
  }
  if (duration > MAX_DURATION / MINUTE) {
    throw new ClinicValidationError('A session can be at most four hours.')
  }
  // Courts are held in 30-minute granules, so a session that starts at 6:10
  // would quietly block from 6:00 and mislead everyone reading the day view.
  if (input.recurrence.startMinute % 30 !== 0 || input.recurrence.endMinute % 30 !== 0) {
    throw new ClinicValidationError('Start and end times have to be on the half hour.')
  }
}

export type CreateClinicResult =
  | { ok: true; clinic: Clinic }
  /** The dates whose court was already taken. Nothing was created. */
  | { ok: false; conflicts: number[] }

/**
 * Create a clinic and hold its courts, in one transaction.
 *
 * All of it or none of it: the clinic row, every occurrence, and a
 * `court_slot_locks` row per 30-minute granule of every occurrence go into a
 * single `batch()`. One collision anywhere in the series therefore fails the
 * whole create — which is the right answer for a recurring booking, because a
 * coach whose week 4 is missing has a different clinic from the one they
 * asked for and should get to decide what to do about it.
 *
 * On failure the conflicting dates are read back and named, so the organizer
 * can move the time rather than guess.
 */
export async function createClinic(input: CreateClinicInput): Promise<CreateClinicResult> {
  const dates = generateOccurrences(input.recurrence)
  validate(input, dates)

  const now = Date.now()
  const clinicId = newId()

  const clinicRow = {
    id: clinicId,
    organizerId: input.organizerId,
    locationId: input.locationId,
    title: input.title.trim(),
    descriptionMd: input.descriptionMd,
    costNote: input.costNote,
    heroKey: input.heroKey,
    heroWidth: input.heroWidth,
    heroHeight: input.heroHeight,
    capacity: input.capacity,
    status: 'draft' as const,
    recurWeekdays: [...input.recurrence.weekdays].sort(),
    recurStartMinute: input.recurrence.startMinute,
    recurEndMinute: input.recurrence.endMinute,
    recurFrom: startOfLocalDay(input.recurrence.from),
    recurUntil: startOfLocalDay(input.recurrence.until),
    createdAt: now,
    publishedAt: null,
    cancelledAt: null,
    cancelReason: null,
  }

  const occurrenceRows = dates.map((date) => ({
    id: newId(),
    clinicId,
    courtId: input.courtId,
    startsAt: date.startsAt,
    endsAt: date.endsAt,
    status: 'scheduled' as const,
    calendarSeq: 0,
    remindedAt: null,
  }))

  const lockRows = occurrenceRows.flatMap((occurrence) =>
    lockSlotsFor(occurrence.startsAt, occurrence.endsAt).map((slotStart) => ({
      courtId: input.courtId,
      slotStart,
      gameId: null,
      clinicOccurrenceId: occurrence.id,
    })),
  )

  const database = db()
  try {
    await database.batch(
      batchOf(
        database.insert(clinics).values(clinicRow),
        database.insert(clinicOccurrences).values(occurrenceRows),
        database.insert(courtSlotLocks).values(lockRows),
      ),
    )
  } catch (error) {
    if (!violates(error, 'court_slot_locks')) throw error
    return { ok: false, conflicts: await conflictingDates(input.courtId, dates) }
  }

  return { ok: true, clinic: clinicRow as Clinic }
}

/**
 * Which of these dates the court is already busy for.
 *
 * Only ever run after a failed create, to say something useful about it. The
 * batch above is the authority — this is a second read against a world that
 * has already moved on, and is allowed to be approximate.
 */
async function conflictingDates(
  courtId: string,
  dates: Array<{ startsAt: number; endsAt: number }>,
): Promise<number[]> {
  const slots = dates.flatMap((d) => lockSlotsFor(d.startsAt, d.endsAt))
  if (slots.length === 0) return []

  const taken = await db()
    .select({ slotStart: courtSlotLocks.slotStart })
    .from(courtSlotLocks)
    .where(and(eq(courtSlotLocks.courtId, courtId), inArray(courtSlotLocks.slotStart, slots)))

  const busy = new Set(taken.map((t) => t.slotStart))
  return dates
    .filter((d) => lockSlotsFor(d.startsAt, d.endsAt).some((slot) => busy.has(slot)))
    .map((d) => d.startsAt)
}

/** Courts at a location with nothing booked on any date of a proposed series. */
export async function courtsFreeForSeries(
  locationId: string,
  recurrence: RecurrenceInput,
): Promise<string[]> {
  const dates = generateOccurrences(recurrence)
  const slots = [...new Set(dates.flatMap((d) => lockSlotsFor(d.startsAt, d.endsAt)))]

  const all = await db()
    .select({ id: courts.id })
    .from(courts)
    .where(and(eq(courts.locationId, locationId), eq(courts.isActive, true)))
    .orderBy(asc(courts.sortOrder), asc(courts.name))

  if (slots.length === 0) return []

  const busy = await db()
    .select({ courtId: courtSlotLocks.courtId })
    .from(courtSlotLocks)
    .where(inArray(courtSlotLocks.slotStart, slots))

  const taken = new Set(busy.map((b) => b.courtId))
  return all.map((c) => c.id).filter((id) => !taken.has(id))
}

// ---------------------------------------------------------------------------
// Signing up
// ---------------------------------------------------------------------------

/**
 * Take a place on one date.
 *
 * Two races settle here, both in the database rather than in code:
 *
 * 1. **Capacity.** A guarded `INSERT ... SELECT ... WHERE (count) < capacity`,
 *    which SQLite evaluates as one statement — so the count and the insert
 *    cannot interleave and two players cannot both take the last place. Zero
 *    rows written means it filled. This is the same shape as claiming a game
 *    seat, adapted to a capacity number instead of one row per seat.
 * 2. **Double-booking.** `player_slot_locks`, primary key
 *    `(user_id, slot_start)` — the very same table a game seat writes, which
 *    is what makes "you can't be in a clinic and a game at once" free.
 *
 * The locks and the guarded insert go in one batch, and **the losing path has
 * to delete the locks it just wrote**: the guarded insert only reports zero
 * rows once the batch has already committed. `claimSlot` has the identical
 * wrinkle for the identical reason.
 */
export async function signUpForClinic(occurrenceId: string, userId: string): Promise<void> {
  const rows = await db()
    .select({ occurrence: clinicOccurrences, clinic: clinics })
    .from(clinicOccurrences)
    .innerJoin(clinics, eq(clinics.id, clinicOccurrences.clinicId))
    .where(eq(clinicOccurrences.id, occurrenceId))
    .limit(1)

  const row = rows[0]
  if (!row) throw new ClinicValidationError('That session no longer exists.')
  if (row.occurrence.status !== 'scheduled' || row.clinic.status !== 'published') {
    throw new ClinicValidationError('That session is not open for signups.')
  }
  if (row.occurrence.startsAt < Date.now()) {
    throw new ClinicValidationError('That session has already started.')
  }

  const slots = lockSlotsFor(row.occurrence.startsAt, row.occurrence.endsAt)

  /**
   * Raw D1 rather than the query builder, for one statement only.
   *
   * Drizzle can't put a *parameterised* raw statement into a `batch()` — it
   * reaches for a prepared statement that a raw `db.run()` hasn't got — and
   * the guarded insert can't be expressed in the query builder either. So this
   * uses the handle `d1()` exists for. Every value is still bound, never
   * interpolated.
   */
  const database = d1()
  let results
  try {
    results = await database.batch([
      database
        .prepare(
          `INSERT INTO player_slot_locks (user_id, slot_start, game_id, clinic_occurrence_id)
           VALUES ${slots.map(() => '(?, ?, NULL, ?)').join(', ')}`,
        )
        .bind(...slots.flatMap((slotStart) => [userId, slotStart, occurrenceId])),
      // One statement, so the count and the insert cannot interleave — this is
      // the whole capacity guarantee. Zero rows written means it filled.
      database
        .prepare(
          `INSERT INTO clinic_signups (id, occurrence_id, user_id, created_at)
           SELECT ?, ?, ?, ?
           WHERE (SELECT COUNT(*) FROM clinic_signups WHERE occurrence_id = ?) < ?`,
        )
        .bind(newId(), occurrenceId, userId, Date.now(), occurrenceId, row.clinic.capacity),
    ])
  } catch (error) {
    if (violates(error, 'player_slot_locks')) throw new PlayerBusyError()
    if (violates(error, 'clinic_signups')) throw new AlreadySignedUpError()
    throw error
  }

  const written = results[1]?.meta?.changes ?? 0
  if (written === 0) {
    // The batch committed, locks and all, and only then did the guarded insert
    // report that it wrote nothing. Release what it left behind.
    await releasePlayerLocks(occurrenceId, userId)
    throw new ClinicFullError()
  }
}

async function releasePlayerLocks(occurrenceId: string, userId: string): Promise<void> {
  await db()
    .delete(playerSlotLocks)
    .where(
      and(
        eq(playerSlotLocks.userId, userId),
        eq(playerSlotLocks.clinicOccurrenceId, occurrenceId),
      ),
    )
}

/**
 * Give up a place.
 *
 * Releasing the player locks is not optional housekeeping: forget it and the
 * player stays blocked from every game and clinic in that window, with nothing
 * on screen to explain why.
 */
export async function withdrawFromClinic(occurrenceId: string, userId: string): Promise<void> {
  const database = db()
  await database.batch(
    batchOf(
      database
        .delete(clinicSignups)
        .where(
          and(eq(clinicSignups.occurrenceId, occurrenceId), eq(clinicSignups.userId, userId)),
        ),
      database
        .delete(playerSlotLocks)
        .where(
          and(
            eq(playerSlotLocks.userId, userId),
            eq(playerSlotLocks.clinicOccurrenceId, occurrenceId),
          ),
        ),
    ),
  )
}

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

/**
 * Who hears about a new clinic.
 *
 * Deliberately **not** `findCandidates`. Level and format matching exist to
 * fill one specific seat in one specific game; a clinic is neither
 * level-specific nor format-specific, and running it through that filter would
 * silently exclude most of the people it is for.
 *
 * Location follows the same soft-preference rule as everything else in the app
 * (see `src/server/preferences.ts`): a player who listed preferred parks hears
 * about clinics there, and a player who listed none hears about all of them.
 * A preference orders and narrows — it never excludes someone who expressed no
 * opinion.
 */
export async function clinicAudience(clinicId: string) {
  const rows = await db()
    .select({ clinic: clinics })
    .from(clinics)
    .where(eq(clinics.id, clinicId))
    .limit(1)
  const clinic = rows[0]?.clinic
  if (!clinic) return []

  return db()
    .select({
      id: users.id,
      email: users.email,
      notifyEmail: users.notifyEmail,
      notifySms: users.notifySms,
    })
    .from(users)
    .where(
      and(
        eq(users.notifyClinics, true),
        ne(users.id, clinic.organizerId),
        // A stub row from a magic link with no profile behind it isn't a
        // player yet, and mailing them would be the app's first contact.
        sql`${users.profileCompletedAt} IS NOT NULL`,
        sql`(${users.notifyEmail} = 1 OR ${users.notifySms} = 1)`,
        sql`(
          NOT EXISTS (SELECT 1 FROM user_locations ul WHERE ul.user_id = ${users.id})
          OR EXISTS (
            SELECT 1 FROM user_locations ul
            WHERE ul.user_id = ${users.id} AND ul.location_id = ${clinic.locationId}
          )
        )`,
      ),
    )
}

/**
 * Publish a clinic and tell its audience, once.
 *
 * Rows into `clinic_notifications` before the queue messages, which is the
 * same ordering `notifyCandidatesForGame` uses and for the same reason: the
 * unique index on `(user_id, clinic_id)` is what makes at-least-once delivery
 * safe, and it only helps if the row exists first.
 */
export async function publishClinic(clinicId: string): Promise<{ notified: string[] }> {
  const updated = await db()
    .update(clinics)
    .set({ status: 'published', publishedAt: Date.now() })
    .where(and(eq(clinics.id, clinicId), eq(clinics.status, 'draft')))
    .returning({ id: clinics.id })

  // Already published, or cancelled. Publishing is once — a second call must
  // not re-announce it to everybody.
  if (updated.length === 0) return { notified: [] }

  const audience = await clinicAudience(clinicId)
  const notified: string[] = []

  for (const player of audience) {
    try {
      await db().insert(clinicNotifications).values({
        id: newId(),
        userId: player.id,
        clinicId,
        channel: player.notifyEmail ? 'email' : 'sms',
        sentAt: Date.now(),
        status: 'sent',
      })
    } catch {
      continue // already told
    }
    notified.push(player.id)
  }

  // The ids rather than a count: sending is a layer up, in `clinicNotify.ts`,
  // because a module the queue consumer imports cannot import the queue back.
  return { notified }
}

// ---------------------------------------------------------------------------
// Cancelling
// ---------------------------------------------------------------------------

/** Everyone holding a place, so they can be told before the row disappears. */
export async function occurrenceAttendees(occurrenceId: string) {
  return db()
    .select({ user: users })
    .from(clinicSignups)
    .innerJoin(users, eq(users.id, clinicSignups.userId))
    .where(eq(clinicSignups.occurrenceId, occurrenceId))
    .then((rows) => rows.map((r) => r.user))
}

/**
 * Call off one date.
 *
 * Both lock tables have to be released — the court so somebody else can use
 * it, and every attendee's player locks so they aren't left blocked from an
 * hour they are now free for.
 */
export async function cancelOccurrence(occurrenceId: string): Promise<void> {
  const database = db()
  await database.batch(
    batchOf(
      database
        .update(clinicOccurrences)
        .set({ status: 'cancelled', calendarSeq: sql`${clinicOccurrences.calendarSeq} + 1` })
        .where(eq(clinicOccurrences.id, occurrenceId)),
      database
        .delete(courtSlotLocks)
        .where(eq(courtSlotLocks.clinicOccurrenceId, occurrenceId)),
      database
        .delete(playerSlotLocks)
        .where(eq(playerSlotLocks.clinicOccurrenceId, occurrenceId)),
      database.delete(clinicSignups).where(eq(clinicSignups.occurrenceId, occurrenceId)),
    ),
  )
}

/** Call off the whole series. Past dates are left alone — they happened. */
export async function cancelClinic(clinicId: string, reason: string): Promise<void> {
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

  for (const occurrence of upcoming) await cancelOccurrence(occurrence.id)

  await db()
    .update(clinics)
    .set({ status: 'cancelled', cancelledAt: Date.now(), cancelReason: reason })
    .where(eq(clinics.id, clinicId))
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export type ClinicOccurrenceView = {
  occurrence: ClinicOccurrence
  courtName: string
  taken: number
  /** Null for a signed-out viewer. */
  viewerSignedUp: boolean
}

export type ClinicDetail = {
  clinic: Clinic
  location: { id: string; name: string; address: string | null }
  organizer: { id: string; name: string }
  occurrences: ClinicOccurrenceView[]
}

export async function getClinic(
  clinicId: string,
  viewerId?: string | null,
): Promise<ClinicDetail | null> {
  const rows = await db()
    .select({ clinic: clinics, location: locations, organizer: users })
    .from(clinics)
    .innerJoin(locations, eq(locations.id, clinics.locationId))
    .innerJoin(users, eq(users.id, clinics.organizerId))
    .where(eq(clinics.id, clinicId))
    .limit(1)

  const row = rows[0]
  if (!row) return null

  const occurrences = await db()
    .select({
      occurrence: clinicOccurrences,
      courtName: courts.name,
      taken: sql<number>`(SELECT COUNT(*) FROM clinic_signups s WHERE s.occurrence_id = ${clinicOccurrences.id})`,
      viewerSignedUp: viewerId
        ? sql<number>`(SELECT COUNT(*) FROM clinic_signups s WHERE s.occurrence_id = ${clinicOccurrences.id} AND s.user_id = ${viewerId})`
        : sql<number>`0`,
    })
    .from(clinicOccurrences)
    .innerJoin(courts, eq(courts.id, clinicOccurrences.courtId))
    .where(eq(clinicOccurrences.clinicId, clinicId))
    .orderBy(asc(clinicOccurrences.startsAt))

  return {
    clinic: row.clinic,
    location: { id: row.location.id, name: row.location.name, address: row.location.address },
    organizer: { id: row.organizer.id, name: row.organizer.name },
    occurrences: occurrences.map((o) => ({
      occurrence: o.occurrence,
      courtName: o.courtName,
      taken: Number(o.taken),
      viewerSignedUp: Number(o.viewerSignedUp) > 0,
    })),
  }
}

/**
 * The compact shape notification templates read.
 *
 * Loaded by the queue consumer at delivery time, never carried in the message
 * — same rule the game path follows, and for the same reason: a session
 * cancelled between enqueue and delivery must not produce a cheerful "see you
 * Tuesday".
 */
export type ClinicBrief = {
  clinicId: string
  /** Null for a message about the series rather than one date. */
  occurrenceId: string | null
  title: string
  descriptionMd: string
  costNote: string | null
  capacity: number
  organizerName: string
  locationName: string
  locationAddress: string | null
  locationLat: number | null
  locationLng: number | null
  /** All null when the message is about the series and none are left. */
  startsAt: number | null
  endsAt: number | null
  courtName: string | null
  calendarSeq: number
  taken: number
  /** How many dates the series still has ahead of it. */
  upcoming: number
  clinicStatus: Clinic['status']
  occurrenceStatus: ClinicOccurrence['status'] | null
}

export async function getClinicBrief(
  clinicId: string,
  occurrenceId?: string | null,
  now = Date.now(),
): Promise<ClinicBrief | null> {
  const rows = await db()
    .select({ clinic: clinics, location: locations, organizer: users })
    .from(clinics)
    .innerJoin(locations, eq(locations.id, clinics.locationId))
    .innerJoin(users, eq(users.id, clinics.organizerId))
    .where(eq(clinics.id, clinicId))
    .limit(1)

  const row = rows[0]
  if (!row) return null

  // A named date, or — for a message about the whole series — the next one
  // still to come, which is what someone reading it wants to know about.
  const occurrences = await db()
    .select({ occurrence: clinicOccurrences, courtName: courts.name })
    .from(clinicOccurrences)
    .innerJoin(courts, eq(courts.id, clinicOccurrences.courtId))
    .where(
      occurrenceId
        ? eq(clinicOccurrences.id, occurrenceId)
        : and(
            eq(clinicOccurrences.clinicId, clinicId),
            eq(clinicOccurrences.status, 'scheduled'),
            gte(clinicOccurrences.startsAt, now),
          ),
    )
    .orderBy(asc(clinicOccurrences.startsAt))

  const chosen = occurrences[0] ?? null
  const taken = chosen
    ? await db()
        .select({ id: clinicSignups.id })
        .from(clinicSignups)
        .where(eq(clinicSignups.occurrenceId, chosen.occurrence.id))
        .then((r) => r.length)
    : 0

  const upcoming = occurrenceId
    ? await db()
        .select({ id: clinicOccurrences.id })
        .from(clinicOccurrences)
        .where(
          and(
            eq(clinicOccurrences.clinicId, clinicId),
            eq(clinicOccurrences.status, 'scheduled'),
            gte(clinicOccurrences.startsAt, now),
          ),
        )
        .then((r) => r.length)
    : occurrences.length

  return {
    clinicId,
    occurrenceId: chosen?.occurrence.id ?? null,
    title: row.clinic.title,
    descriptionMd: row.clinic.descriptionMd,
    costNote: row.clinic.costNote,
    capacity: row.clinic.capacity,
    organizerName: row.organizer.name,
    locationName: row.location.name,
    locationAddress: row.location.address,
    locationLat: row.location.lat,
    locationLng: row.location.lng,
    startsAt: chosen?.occurrence.startsAt ?? null,
    endsAt: chosen?.occurrence.endsAt ?? null,
    courtName: chosen?.courtName ?? null,
    calendarSeq: chosen?.occurrence.calendarSeq ?? 0,
    taken,
    upcoming,
    clinicStatus: row.clinic.status,
    occurrenceStatus: chosen?.occurrence.status ?? null,
  }
}

export type ClinicListItem = {
  clinic: Clinic
  locationName: string
  organizerName: string
  /** The next date still to come, or null once the series is over. */
  nextStartsAt: number | null
  openSpots: number | null
}

const nextOccurrenceSql = sql<number | null>`(
  SELECT MIN(o.starts_at) FROM clinic_occurrences o
  WHERE o.clinic_id = ${clinics.id} AND o.status = 'scheduled' AND o.starts_at > ${sql.placeholder('now')}
)`

/** Published clinics with a date still to come, soonest first. */
export async function listUpcomingClinics(now = Date.now()): Promise<ClinicListItem[]> {
  const rows = await db()
    .select({
      clinic: clinics,
      locationName: locations.name,
      organizerName: users.name,
      nextStartsAt: nextOccurrenceSql,
    })
    .from(clinics)
    .innerJoin(locations, eq(locations.id, clinics.locationId))
    .innerJoin(users, eq(users.id, clinics.organizerId))
    .where(eq(clinics.status, 'published'))
    .orderBy(asc(clinics.title))
    .all({ now })

  return rows
    .filter((r) => r.nextStartsAt !== null)
    .map((r) => ({ ...r, nextStartsAt: Number(r.nextStartsAt), openSpots: null }))
    .sort((a, b) => a.nextStartsAt - b.nextStartsAt)
}

/** Everything an organizer runs, including drafts and finished series. */
export async function listClinicsFor(organizerId: string): Promise<ClinicListItem[]> {
  const rows = await db()
    .select({
      clinic: clinics,
      locationName: locations.name,
      organizerName: users.name,
      nextStartsAt: nextOccurrenceSql,
    })
    .from(clinics)
    .innerJoin(locations, eq(locations.id, clinics.locationId))
    .innerJoin(users, eq(users.id, clinics.organizerId))
    .where(eq(clinics.organizerId, organizerId))
    .orderBy(desc(clinics.createdAt))
    .all({ now: Date.now() })

  return rows.map((r) => ({
    ...r,
    nextStartsAt: r.nextStartsAt === null ? null : Number(r.nextStartsAt),
    openSpots: null,
  }))
}

export type ScheduledClinic = {
  occurrenceId: string
  clinicId: string
  courtId: string
  title: string
  startsAt: number
  endsAt: number
  capacity: number
  taken: number
}

/** Clinic sessions on a location's courts in a window, for the day view. */
export async function clinicsAtLocation(
  locationId: string,
  fromMs: number,
  toMs: number,
): Promise<ScheduledClinic[]> {
  const rows = await db()
    .select({
      occurrenceId: clinicOccurrences.id,
      clinicId: clinics.id,
      courtId: clinicOccurrences.courtId,
      title: clinics.title,
      startsAt: clinicOccurrences.startsAt,
      endsAt: clinicOccurrences.endsAt,
      capacity: clinics.capacity,
      taken: sql<number>`(SELECT COUNT(*) FROM clinic_signups s WHERE s.occurrence_id = ${clinicOccurrences.id})`,
    })
    .from(clinicOccurrences)
    .innerJoin(clinics, eq(clinics.id, clinicOccurrences.clinicId))
    .innerJoin(courts, eq(courts.id, clinicOccurrences.courtId))
    .where(
      and(
        eq(courts.locationId, locationId),
        ne(clinicOccurrences.status, 'cancelled'),
        // A session overlapping the window, not merely starting inside it.
        lt(clinicOccurrences.startsAt, toMs),
        gte(clinicOccurrences.endsAt, fromMs),
      ),
    )
    .orderBy(asc(clinicOccurrences.startsAt))

  return rows.map((r) => ({ ...r, taken: Number(r.taken) }))
}

/** A player's upcoming clinic sessions, for the dashboard. */
export async function listMyClinics(userId: string, now = Date.now()) {
  return db()
    .select({
      occurrence: clinicOccurrences,
      clinic: clinics,
      locationName: locations.name,
      courtName: courts.name,
    })
    .from(clinicSignups)
    .innerJoin(clinicOccurrences, eq(clinicOccurrences.id, clinicSignups.occurrenceId))
    .innerJoin(clinics, eq(clinics.id, clinicOccurrences.clinicId))
    .innerJoin(courts, eq(courts.id, clinicOccurrences.courtId))
    .innerJoin(locations, eq(locations.id, courts.locationId))
    .where(
      and(
        eq(clinicSignups.userId, userId),
        gte(clinicOccurrences.endsAt, now),
        ne(clinicOccurrences.status, 'cancelled'),
      ),
    )
    .orderBy(asc(clinicOccurrences.startsAt))
}

/** Mark past sessions complete, so a finished series stops looking live. */
export async function completePastOccurrences(now = Date.now()): Promise<number> {
  const done = await db()
    .update(clinicOccurrences)
    .set({ status: 'completed' })
    .where(and(lt(clinicOccurrences.endsAt, now), eq(clinicOccurrences.status, 'scheduled')))
    .returning({ id: clinicOccurrences.id })
  return done.length
}

