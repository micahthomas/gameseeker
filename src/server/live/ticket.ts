import { sessionSecret } from '../config'

/**
 * Authenticating a WebSocket upgrade.
 *
 * The session cookie *is* sent on a same-origin upgrade request, but reading it
 * needs TanStack Start's request context, and the live endpoint deliberately
 * runs before Start's handler (Start claims every path, and a 101 response
 * would not survive it). Outside that context `useSession` throws
 * "No StartEvent found in AsyncLocalStorage".
 *
 * So the client asks an ordinary — authenticated — server function for a
 * short-lived ticket and presents it on the upgrade URL. The Worker verifies
 * the signature and gets the player id from it. A client still never names its
 * own id: the id is inside something only the server can have signed.
 *
 * Stateless on purpose. A table would buy single-use semantics, but the ticket
 * lives for thirty seconds, is obtained over TLS from an already-authenticated
 * call, and opens nothing but that same player's own socket — so the row, the
 * migration and the cron sweep to purge it would all be machinery for no
 * meaningful gain.
 */

const TICKET_TTL_MS = 30_000
const encoder = new TextEncoder()

async function signingKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(sessionSecret()),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
}

function toBase64Url(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function fromBase64Url(value: string): ArrayBuffer {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}

export async function issueLiveTicket(userId: string, now = Date.now()): Promise<string> {
  const payload = `${userId}.${now + TICKET_TTL_MS}`
  const signature = await crypto.subtle.sign('HMAC', await signingKey(), encoder.encode(payload))
  return `${payload}.${toBase64Url(signature)}`
}

/** The player id a ticket vouches for, or null if it's forged or stale. */
export async function verifyLiveTicket(
  ticket: string | null | undefined,
  now = Date.now(),
): Promise<string | null> {
  if (!ticket) return null
  // User ids are UUIDs, so the two dots are unambiguous separators.
  const parts = ticket.split('.')
  if (parts.length !== 3) return null
  const [userId, expiresAt, signature] = parts as [string, string, string]

  const expires = Number(expiresAt)
  if (!Number.isFinite(expires) || expires < now) return null

  // crypto.subtle.verify rather than a string comparison: constant time.
  const ok = await crypto.subtle.verify(
    'HMAC',
    await signingKey(),
    fromBase64Url(signature),
    encoder.encode(`${userId}.${expiresAt}`),
  ).catch(() => false)

  return ok ? userId : null
}
