import { createServerFn } from '@tanstack/react-start'
import { asc, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '~/db/client'
import { LOCATION_KINDS, SURFACES, courts, locations, users } from '~/db/schema'
import { requireAdmin } from '~/server/auth'
import { newId } from '~/server/tokens'

/**
 * Facility management. The seed data is a starting point taken from public
 * information; a local admin is the authority on what courts actually exist
 * and whether they're playable.
 */

export const fetchAdminLocations = createServerFn({ method: 'GET' }).handler(async () => {
  await requireAdmin()
  const rows = await db()
    .select({
      location: locations,
      courtCount: sql<number>`(SELECT COUNT(*) FROM courts c WHERE c.location_id = ${locations.id})`,
    })
    .from(locations)
    .orderBy(asc(locations.name))

  const allCourts = await db()
    .select()
    .from(courts)
    .orderBy(asc(courts.locationId), asc(courts.sortOrder), asc(courts.name))

  return { locations: rows, courts: allCourts }
})

export const saveLocation = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      id: z.string().optional(),
      name: z.string().trim().min(2).max(120),
      address: z.string().trim().max(200).optional(),
      lat: z.number().nullable().optional(),
      lng: z.number().nullable().optional(),
      kind: z.enum(LOCATION_KINDS),
      notes: z.string().trim().max(500).optional(),
      isActive: z.boolean(),
    }),
  )
  .handler(async ({ data }) => {
    await requireAdmin()
    const values = {
      name: data.name,
      address: data.address || null,
      lat: data.lat ?? null,
      lng: data.lng ?? null,
      kind: data.kind,
      notes: data.notes || null,
      isActive: data.isActive,
    }

    if (data.id) {
      const rows = await db()
        .update(locations)
        .set(values)
        .where(eq(locations.id, data.id))
        .returning()
      return rows[0]!
    }

    const rows = await db()
      .insert(locations)
      .values({ id: newId(), ...values, createdAt: Date.now() })
      .returning()
    return rows[0]!
  })

export const saveCourt = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      id: z.string().optional(),
      locationId: z.string().min(1),
      name: z.string().trim().min(1).max(60),
      surface: z.enum(SURFACES),
      hasLights: z.boolean(),
      isActive: z.boolean(),
      sortOrder: z.number().int().min(0).max(999),
    }),
  )
  .handler(async ({ data }) => {
    await requireAdmin()
    const values = {
      locationId: data.locationId,
      name: data.name,
      surface: data.surface,
      hasLights: data.hasLights,
      isActive: data.isActive,
      sortOrder: data.sortOrder,
    }

    if (data.id) {
      const rows = await db().update(courts).set(values).where(eq(courts.id, data.id)).returning()
      return rows[0]!
    }
    const rows = await db()
      .insert(courts)
      .values({ id: newId(), ...values })
      .returning()
    return rows[0]!
  })

/**
 * Courts are deactivated rather than deleted — games reference them, and a
 * resurfacing closure is temporary. Deactivated courts disappear from the
 * booking form but existing games keep their history.
 */
export const setCourtActive = createServerFn({ method: 'POST' })
  .validator(z.object({ courtId: z.string(), isActive: z.boolean() }))
  .handler(async ({ data }) => {
    await requireAdmin()
    await db()
      .update(courts)
      .set({ isActive: data.isActive })
      .where(eq(courts.id, data.courtId))
    return { ok: true as const }
  })

export const fetchPlayers = createServerFn({ method: 'GET' }).handler(async () => {
  await requireAdmin()
  return db()
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      ntrp: users.ntrp,
      ratingSystem: users.ratingSystem,
      ratingValue: users.ratingValue,
      isAdmin: users.isAdmin,
      createdAt: users.createdAt,
      profileCompletedAt: users.profileCompletedAt,
    })
    .from(users)
    .orderBy(asc(users.name))
})

export const setPlayerAdmin = createServerFn({ method: 'POST' })
  .validator(z.object({ userId: z.string(), isAdmin: z.boolean() }))
  .handler(async ({ data }) => {
    const me = await requireAdmin()
    if (me.id === data.userId && !data.isAdmin) {
      throw new Error("You can't remove your own admin access.")
    }
    await db().update(users).set({ isAdmin: data.isAdmin }).where(eq(users.id, data.userId))
    return { ok: true as const }
  })
