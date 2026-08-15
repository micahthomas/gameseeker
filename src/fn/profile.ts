import { createServerFn } from '@tanstack/react-start'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '~/db/client'
import { GENDERS, PLAYER_FORMATS, RATING_SYSTEMS, users } from '~/db/schema'
import { requireUser } from '~/server/auth'
import { setPreferredLocations } from '~/server/preferences'
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
  notifyEmail: z.boolean(),
  notifySms: z.boolean(),
  /** Preferred locations, most preferred first. Order is the priority. */
  preferredLocationIds: z.array(z.string()).max(20).default([]),
  playLevels: z.array(z.number()).min(1, 'Pick at least one level you\'ll play').max(9),
  gender: z.enum(GENDERS),
  formats: z.array(z.enum(PLAYER_FORMATS)).min(1, 'Pick at least one format you\'ll play'),
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
        // De-duplicated so a malformed client can't grow the set unboundedly.
        formats: [...new Set(data.formats)],
        gender: data.gender,
        notifyEmail: data.notifyEmail,
        notifySms: data.notifySms,
        profileCompletedAt: user.profileCompletedAt ?? Date.now(),
      })
      .where(eq(users.id, user.id))
      .returning()

    const preferredLocationIds = await setPreferredLocations(
      user.id,
      data.preferredLocationIds,
    )

    return { ok: true as const, ntrp, playLevels, preferredLocationIds, user: updated[0]! }
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
