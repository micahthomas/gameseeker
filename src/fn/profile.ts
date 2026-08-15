import { createServerFn } from '@tanstack/react-start'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '~/db/client'
import { GENDERS, RATING_SYSTEMS, users } from '~/db/schema'
import { requireUser } from '~/server/auth'
import { isValidRating, normalizePlayLevels, normalizeRating } from '~/server/rating'

const profileSchema = z.object({
  name: z.string().trim().min(2, 'Please enter your name').max(80),
  phone: z
    .string()
    .trim()
    .max(30)
    .optional()
    .transform((v) => (v ? v : null)),
  ratingSystem: z.enum(RATING_SYSTEMS),
  ratingValue: z.number(),
  playsSingles: z.boolean(),
  playsDoubles: z.boolean(),
  notifyEmail: z.boolean(),
  notifySms: z.boolean(),
  homeLocationId: z.string().nullable().optional(),
  playLevels: z.array(z.number()).min(1, 'Pick at least one level you\'ll play').max(9),
  gender: z.enum(GENDERS),
  playsMixed: z.boolean(),
})

export const saveProfile = createServerFn({ method: 'POST' })
  .validator(profileSchema)
  .handler(async ({ data }) => {
    const user = await requireUser()

    if (!isValidRating(data.ratingSystem, data.ratingValue)) {
      throw new Error(
        data.ratingSystem === 'UTR'
          ? 'UTR must be between 1 and 16.5.'
          : 'NTRP must be between 1.0 and 7.0.',
      )
    }
    if (!data.playsSingles && !data.playsDoubles) {
      throw new Error('Pick at least one of singles or doubles, or nobody can invite you.')
    }
    if (data.notifySms && !data.phone) {
      throw new Error('Add a phone number to get text notifications.')
    }

    const ntrp = normalizeRating(data.ratingSystem, data.ratingValue)
    const playLevels = normalizePlayLevels(data.playLevels, ntrp)

    const updated = await db()
      .update(users)
      .set({
        name: data.name,
        phone: data.phone ?? null,
        ratingSystem: data.ratingSystem,
        ratingValue: data.ratingValue,
        ntrp,
        playLevels,
        playsSingles: data.playsSingles,
        playsDoubles: data.playsDoubles,
        gender: data.gender,
        playsMixed: data.playsMixed,
        notifyEmail: data.notifyEmail,
        notifySms: data.notifySms,
        homeLocationId: data.homeLocationId ?? null,
        profileCompletedAt: user.profileCompletedAt ?? Date.now(),
      })
      .where(eq(users.id, user.id))
      .returning()

    return { ok: true as const, ntrp, playLevels, user: updated[0]! }
  })

/** Directory of players, used by the host when inviting someone by name. */
export const searchPlayers = createServerFn({ method: 'GET' })
  .validator(z.object({ query: z.string().trim().max(80) }))
  .handler(async ({ data }) => {
    const me = await requireUser()
    const rows = await db()
      .select({ id: users.id, name: users.name, ntrp: users.ntrp })
      .from(users)
      .limit(200)

    const needle = data.query.toLowerCase()
    return rows
      .filter((row) => row.id !== me.id && row.name.toLowerCase().includes(needle))
      .slice(0, 20)
  })
