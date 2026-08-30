import { createServerFn } from '@tanstack/react-start'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '~/db/client'
import { users, type User } from '~/db/schema'
import {
  consumeMagicToken,
  getCurrentUser,
  issueMagicToken,
  normalizeEmail,
  signIn,
  signOut,
} from '~/server/auth'
import { getConfig } from '~/server/config'
import { defaultFormats } from '~/server/formats'
import { magicLinkEmail, sendEmail } from '~/server/notify'
import { getPreferredLocationIds } from '~/server/preferences'
import { defaultPlayLevels } from '~/server/rating'
import { newId } from '~/server/tokens'

export type SessionUser = Pick<
  User,
  | 'id'
  | 'email'
  | 'name'
  | 'phone'
  | 'ratingSystem'
  | 'ratingValue'
  | 'ntrp'
  | 'playLevels'
  | 'formats'
  | 'division'
  | 'notifyEmail'
  | 'notifySms'
  | 'notifyClinics'
  | 'isAdmin'
  | 'organizerStatus'
  | 'profileCompletedAt'
> & {
  /** Preferred locations, most preferred first. Replaces homeLocationId. */
  preferredLocationIds: string[]
}

function toSessionUser(user: User, preferredLocationIds: string[]): SessionUser {
  const {
    id,
    email,
    name,
    phone,
    ratingSystem,
    ratingValue,
    ntrp,
    playLevels,
    formats,
    division,
    notifyEmail,
    notifySms,
    notifyClinics,
    isAdmin,
    organizerStatus,
    profileCompletedAt,
  } = user
  return {
    id,
    email,
    name,
    phone,
    ratingSystem,
    ratingValue,
    ntrp,
    playLevels,
    formats,
    division,
    notifyEmail,
    notifySms,
    notifyClinics,
    isAdmin,
    organizerStatus,
    profileCompletedAt,
    preferredLocationIds,
  }
}

/** The signed-in player, or null. Loaded once in the root route. */
export const fetchMe = createServerFn({ method: 'GET' }).handler(
  async (): Promise<SessionUser | null> => {
    const user = await getCurrentUser()
    if (!user) return null
    return toSessionUser(user, await getPreferredLocationIds(user.id))
  },
)

export const requestLogin = createServerFn({ method: 'POST' })
  .validator(z.object({ email: z.string().trim().email() }))
  .handler(async ({ data }) => {
    const email = normalizeEmail(data.email)
    const existing = await db().select().from(users).where(eq(users.email, email)).limit(1)
    const token = await issueMagicToken(email)
    const { appUrl } = getConfig()
    const url = `${appUrl}/auth/verify?token=${encodeURIComponent(token)}`

    await sendEmail(email, magicLinkEmail(url, existing.length === 0))

    return {
      ok: true as const,
      /**
       * In development the console adapter only logs the link, and hunting
       * through terminal output on every sign-in gets old fast. Never returned
       * from a production build — that would hand anyone a login for any
       * address they can type.
       */
      devLink: import.meta.env.DEV ? url : undefined,
    }
  })

export const verifyMagicLink = createServerFn({ method: 'POST' })
  .validator(z.object({ token: z.string().min(10) }))
  .handler(async ({ data }) => {
    const email = await consumeMagicToken(data.token)
    if (!email) {
      return { ok: false as const, reason: 'That link has expired or was already used.' }
    }

    const existing = await db().select().from(users).where(eq(users.email, email)).limit(1)
    let user = existing[0]

    if (!user) {
      // Create a stub from the address alone; /profile collects the rest and
      // stamps profileCompletedAt.
      const created = await db()
        .insert(users)
        .values({
          id: newId(),
          email,
          name: email.split('@')[0] ?? 'New player',
          ratingSystem: 'NTRP',
          ratingValue: 3.0,
          ntrp: 3.0,
          playLevels: defaultPlayLevels(3.0),
          // Every format to begin with, matching what the old
          // plays_singles/plays_doubles/plays_mixed booleans defaulted to. The
          // player narrows this in the profile form they're sent to next.
          formats: defaultFormats(),
          createdAt: Date.now(),
          profileCompletedAt: null,
        })
        .returning()
      user = created[0]!
    }

    await signIn(user.id)
    return { ok: true as const, needsProfile: user.profileCompletedAt === null }
  })

export const logout = createServerFn({ method: 'POST' }).handler(async () => {
  await signOut()
  return { ok: true as const }
})
