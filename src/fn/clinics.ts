import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { getCurrentUser, requireOrganizer, requireUser } from '~/server/auth'
import {
  createClinic,
  courtsFreeForSeries,
  getClinic,
  listClinicsFor,
  listUpcomingClinics,
  signUpForClinic,
  withdrawFromClinic,
} from '~/server/clinics'
import {
  announceClinic,
  announceClinicChanged,
  cancelClinicAndTell,
  cancelOccurrenceAndTell,
  notifyClinicSignup,
} from '~/server/clinicNotify'
import { listCourts, listLocations } from '~/server/booking'
import { issueUploadTicket } from '~/server/media'
import { renderMarkdown } from '~/server/markdown'

/**
 * The clinic edge. Validate, resolve the viewer, call into `server/clinics.ts`,
 * shape the response — every rule lives one layer down.
 */

const recurrenceSchema = z.object({
  weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  startMinute: z.number().int().min(0).max(24 * 60),
  endMinute: z.number().int().min(0).max(24 * 60),
  from: z.number(),
  until: z.number(),
})

/** Locations and their courts, for the create form's pickers. */
export const fetchClinicFormData = createServerFn({ method: 'GET' }).handler(async () => {
  await requireOrganizer()
  const locations = await listLocations()
  const courts = (
    await Promise.all(locations.map((location) => listCourts(location.id)))
  ).flat()
  return { locations, courts }
})

export const fetchClinics = createServerFn({ method: 'GET' }).handler(async () => {
  return { clinics: await listUpcomingClinics() }
})

export const fetchClinic = createServerFn({ method: 'GET' })
  .validator(z.object({ clinicId: z.string() }))
  .handler(async ({ data }) => {
    const user = await getCurrentUser()
    const detail = await getClinic(data.clinicId, user?.id ?? null)
    if (!detail) return null

    // Rendered on the server so the sanitising renderer is the only path from
    // stored Markdown to markup — a client-side copy could drift from it.
    return {
      ...detail,
      descriptionHtml: renderMarkdown(detail.clinic.descriptionMd),
      viewer: user
        ? { id: user.id, isOrganizer: user.id === detail.clinic.organizerId || user.isAdmin }
        : null,
    }
  })

/** An organizer's own clinics, drafts included. */
export const fetchMyClinics = createServerFn({ method: 'GET' }).handler(async () => {
  const user = await requireOrganizer()
  return { clinics: await listClinicsFor(user.id) }
})

/** Courts with nothing booked on any date of a proposed series. */
export const fetchCourtsForSeries = createServerFn({ method: 'GET' })
  .validator(z.object({ locationId: z.string(), recurrence: recurrenceSchema }))
  .handler(async ({ data }) => {
    await requireOrganizer()
    return { courtIds: await courtsFreeForSeries(data.locationId, data.recurrence) }
  })

/** A short-lived signed ticket for a hero-image upload. See src/server/media.ts. */
export const requestUploadTicket = createServerFn({ method: 'POST' }).handler(async () => {
  const user = await requireOrganizer()
  return { ticket: await issueUploadTicket(user.id) }
})

export const postClinic = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      locationId: z.string().min(1),
      courtId: z.string().min(1),
      title: z.string().trim().min(3).max(120),
      descriptionMd: z.string().trim().max(4000).default(''),
      costNote: z.string().trim().max(140).optional(),
      heroKey: z.string().trim().max(120).optional(),
      heroWidth: z.number().int().positive().optional(),
      heroHeight: z.number().int().positive().optional(),
      capacity: z.number().int().min(1).max(40),
      recurrence: recurrenceSchema,
    }),
  )
  .handler(async ({ data }) => {
    const user = await requireOrganizer()

    const result = await createClinic({
      organizerId: user.id,
      locationId: data.locationId,
      courtId: data.courtId,
      title: data.title,
      descriptionMd: data.descriptionMd,
      costNote: data.costNote || null,
      heroKey: data.heroKey || null,
      heroWidth: data.heroWidth ?? null,
      heroHeight: data.heroHeight ?? null,
      capacity: data.capacity,
      recurrence: data.recurrence,
    })

    // A clash is an expected answer, not an error: the organizer needs the
    // dates back so they can move the time or pick another court.
    if (!result.ok) return { ok: false as const, conflicts: result.conflicts }
    return { ok: true as const, clinicId: result.clinic.id }
  })

export const publishClinic = createServerFn({ method: 'POST' })
  .validator(z.object({ clinicId: z.string() }))
  .handler(async ({ data }) => {
    const user = await requireOrganizer()
    const detail = await getClinic(data.clinicId)
    if (!detail) throw new Error('That clinic no longer exists.')
    if (detail.clinic.organizerId !== user.id && !user.isAdmin) throw new Error('FORBIDDEN')

    const { notified } = await announceClinic(data.clinicId)
    return { ok: true as const, notified }
  })

export const joinClinic = createServerFn({ method: 'POST' })
  .validator(z.object({ clinicId: z.string(), occurrenceId: z.string() }))
  .handler(async ({ data }) => {
    const user = await requireUser()
    await signUpForClinic(data.occurrenceId, user.id)
    await notifyClinicSignup(data.clinicId, data.occurrenceId, user.id)
    return { ok: true as const }
  })

export const leaveClinic = createServerFn({ method: 'POST' })
  .validator(z.object({ occurrenceId: z.string() }))
  .handler(async ({ data }) => {
    const user = await requireUser()
    await withdrawFromClinic(data.occurrenceId, user.id)
    await announceClinicChanged(data.occurrenceId)
    return { ok: true as const }
  })

export const cancelClinicSession = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      clinicId: z.string(),
      occurrenceId: z.string(),
      reason: z.string().trim().max(200).optional(),
    }),
  )
  .handler(async ({ data }) => {
    const user = await requireOrganizer()
    const detail = await getClinic(data.clinicId)
    if (!detail) throw new Error('That clinic no longer exists.')
    if (detail.clinic.organizerId !== user.id && !user.isAdmin) throw new Error('FORBIDDEN')

    await cancelOccurrenceAndTell(
      data.clinicId,
      data.occurrenceId,
      data.reason?.trim() || `${user.name} cancelled this session.`,
    )
    return { ok: true as const }
  })

export const cancelClinicSeries = createServerFn({ method: 'POST' })
  .validator(z.object({ clinicId: z.string(), reason: z.string().trim().max(200).optional() }))
  .handler(async ({ data }) => {
    const user = await requireOrganizer()
    const detail = await getClinic(data.clinicId)
    if (!detail) throw new Error('That clinic no longer exists.')
    if (detail.clinic.organizerId !== user.id && !user.isAdmin) throw new Error('FORBIDDEN')

    await cancelClinicAndTell(
      data.clinicId,
      data.reason?.trim() || `${user.name} cancelled this clinic.`,
    )
    return { ok: true as const }
  })
