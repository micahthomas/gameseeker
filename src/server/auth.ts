import { useSession } from '@tanstack/react-start/server'
import { and, eq, gt, isNull, lt, or } from 'drizzle-orm'
import { db } from '~/db/client'
import { magicTokens, sessions, users, type User } from '~/db/schema'
import { sessionSecret } from './config'
import { hashToken, newId, newToken } from './tokens'
import { DAY, MINUTE } from './time'

const SESSION_COOKIE = 'gs_session'
const SESSION_TTL = 30 * DAY
const MAGIC_TOKEN_TTL = 15 * MINUTE

type SessionData = { sid: string }

function appSession() {
  return useSession<SessionData>({
    password: sessionSecret(),
    name: SESSION_COOKIE,
    maxAge: SESSION_TTL / 1000,
  })
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

/**
 * Issue a magic-link token for an email address. Returns the raw token — only
 * its hash is persisted, so this is the one and only time it exists in the
 * clear. Callers hand it straight to the notifier.
 */
export async function issueMagicToken(email: string): Promise<string> {
  const raw = newToken()
  const now = Date.now()
  await db()
    .insert(magicTokens)
    .values({
      tokenHash: await hashToken(raw),
      email: normalizeEmail(email),
      expiresAt: now + MAGIC_TOKEN_TTL,
      createdAt: now,
    })
  return raw
}

/**
 * Redeem a magic-link token, returning the email it was issued to.
 *
 * The guarded UPDATE ... RETURNING makes redemption atomic and single-use: if
 * a link is clicked twice (email scanners love to prefetch), only the first
 * call sees a row.
 */
export async function consumeMagicToken(raw: string): Promise<string | null> {
  const now = Date.now()
  const rows = await db()
    .update(magicTokens)
    .set({ usedAt: now })
    .where(
      and(
        eq(magicTokens.tokenHash, await hashToken(raw)),
        isNull(magicTokens.usedAt),
        gt(magicTokens.expiresAt, now),
      ),
    )
    .returning({ email: magicTokens.email })
  return rows[0]?.email ?? null
}

/** Create a server-side session row and seal its id into the cookie. */
export async function signIn(userId: string): Promise<void> {
  const now = Date.now()
  const sid = newId()
  await db().insert(sessions).values({
    id: sid,
    userId,
    expiresAt: now + SESSION_TTL,
    createdAt: now,
  })
  const session = await appSession()
  await session.update({ sid })
}

export async function signOut(): Promise<void> {
  const session = await appSession()
  const sid = session.data.sid
  if (sid) await db().delete(sessions).where(eq(sessions.id, sid))
  await session.clear()
}

/**
 * The signed-in user, or null. Sessions are looked up server-side (rather than
 * trusting the cookie payload alone) so that deleting a session row logs the
 * device out immediately.
 */
export async function getCurrentUser(): Promise<User | null> {
  const session = await appSession()
  const sid = session.data.sid
  if (!sid) return null

  const rows = await db()
    .select({ user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, sid), gt(sessions.expiresAt, Date.now())))
    .limit(1)

  return rows[0]?.user ?? null
}

export async function requireUser(): Promise<User> {
  const user = await getCurrentUser()
  if (!user) throw new Error('UNAUTHENTICATED')
  return user
}

export async function requireAdmin(): Promise<User> {
  const user = await requireUser()
  if (!user.isAdmin) throw new Error('FORBIDDEN')
  return user
}

/** Cron housekeeping: drop expired sessions and spent/expired magic tokens. */
export async function purgeExpiredAuthRows(now = Date.now()): Promise<void> {
  await db().delete(sessions).where(lt(sessions.expiresAt, now))
  await db()
    .delete(magicTokens)
    .where(or(lt(magicTokens.expiresAt, now), lt(magicTokens.createdAt, now - DAY)))
}
