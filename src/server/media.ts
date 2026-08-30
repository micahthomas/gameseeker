import { env } from 'cloudflare:workers'
import { sessionSecret } from './config'

/**
 * Storing an uploaded image.
 *
 * The handler that receives the bytes lives in `src/server.ts`, ahead of
 * TanStack Start — same as `/api/live/*`, and for a related reason: Start's
 * handler expects to answer with an HTML document, and this needs to take a
 * raw request body and answer with JSON.
 *
 * That puts it outside Start's request context, so `useSession` can't be
 * called there. The solution is the one `live/ticket.ts` already uses: an
 * ordinary authenticated server function mints a short-lived HMAC ticket, and
 * the raw handler verifies it. The uploader's id comes out of the signature,
 * so a client never names its own.
 *
 * Objects are keyed by the hash of their own bytes. Two organizers uploading
 * the same picture share one object, a re-upload is idempotent, and the key
 * can be cached forever because it cannot come to mean anything else.
 */

/** Long enough to pick a file and upload it over a phone connection. */
const TICKET_TTL_MS = 10 * 60_000
/** Generous for a hero image, small enough that a stall is a bug not a wait. */
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024

const encoder = new TextEncoder()

/**
 * What we accept, and how to recognise it from its own first bytes.
 *
 * The declared content type is a claim by the client, so it is checked against
 * the actual leading bytes before anything is stored. Without that, `image/png`
 * on an HTML document would be served back from our own origin as an image
 * that a browser might well sniff as markup.
 */
const SIGNATURES: Array<{ type: string; ext: string; matches: (b: Uint8Array) => boolean }> = [
  {
    type: 'image/jpeg',
    ext: 'jpg',
    matches: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    type: 'image/png',
    ext: 'png',
    matches: (b) =>
      b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  },
  {
    type: 'image/webp',
    ext: 'webp',
    matches: (b) =>
      // "RIFF" .... "WEBP"
      b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
  },
]

export const ACCEPTED_TYPES = SIGNATURES.map((s) => s.type)

/** The type these bytes actually are, whatever they were said to be. */
export function sniffImageType(bytes: Uint8Array): { type: string; ext: string } | null {
  if (bytes.length < 12) return null
  const match = SIGNATURES.find((s) => s.matches(bytes))
  return match ? { type: match.type, ext: match.ext } : null
}

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

export async function issueUploadTicket(userId: string, now = Date.now()): Promise<string> {
  const payload = `${userId}.${now + TICKET_TTL_MS}`
  const signature = await crypto.subtle.sign('HMAC', await signingKey(), encoder.encode(payload))
  return `${payload}.${toBase64Url(signature)}`
}

/** The uploader a ticket vouches for, or null if it's forged or stale. */
export async function verifyUploadTicket(
  ticket: string | null | undefined,
  now = Date.now(),
): Promise<string | null> {
  if (!ticket) return null
  const parts = ticket.split('.')
  if (parts.length !== 3) return null
  const [userId, expiresAt, signature] = parts as [string, string, string]

  const expires = Number(expiresAt)
  if (!Number.isFinite(expires) || expires < now) return null

  // Constant time, unlike a string comparison.
  const ok = await crypto.subtle
    .verify('HMAC', await signingKey(), fromBase64Url(signature), encoder.encode(`${userId}.${expiresAt}`))
    .catch(() => false)

  return ok ? userId : null
}

function mediaBucket(): R2Bucket | null {
  // Declared in wrangler.jsonc, so the generated Env types it as always
  // present — but the unit-test worker builds its bindings by hand and has
  // none. Same optional read as `notifyQueue()`.
  return ((env as Partial<Env>).CLINIC_MEDIA as R2Bucket | undefined) ?? null
}

export type UploadResult =
  | { ok: true; key: string; contentType: string; bytes: number }
  | { ok: false; reason: string }

/**
 * Read an upload, verify it really is an image, and put it in R2.
 *
 * Buffered rather than streamed straight through, because the content hash
 * that becomes the key can't be computed until the last byte has arrived — and
 * at a 2 MB cap that is a fair trade for a key that never needs invalidating.
 * The cap is enforced while reading, so an oversized body is abandoned rather
 * than held.
 */
export async function storeUpload(body: ReadableStream | null): Promise<UploadResult> {
  const bucket = mediaBucket()
  if (!bucket) return { ok: false, reason: 'Image uploads are not configured.' }
  if (!body) return { ok: false, reason: 'No file was sent.' }

  const chunks: Uint8Array[] = []
  let size = 0
  const reader = body.getReader()

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_UPLOAD_BYTES) {
      await reader.cancel()
      return { ok: false, reason: 'That image is larger than 2 MB.' }
    }
    chunks.push(value)
  }

  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }

  const sniffed = sniffImageType(bytes)
  if (!sniffed) return { ok: false, reason: 'That file is not a JPEG, PNG or WebP image.' }

  const digest = await crypto.subtle.digest('SHA-256', bytes)
  const hash = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32)
  const key = `clinics/${hash}.${sniffed.ext}`

  await bucket.put(key, bytes, { httpMetadata: { contentType: sniffed.type } })
  return { ok: true, key, contentType: sniffed.type, bytes: size }
}

/** Keys are content hashes, so anything else is a probe. */
export function isMediaKey(key: string): boolean {
  return /^clinics\/[0-9a-f]{32}\.(jpg|png|webp)$/.test(key)
}

export async function readMedia(key: string): Promise<R2ObjectBody | null> {
  const bucket = mediaBucket()
  if (!bucket || !isMediaKey(key)) return null
  return bucket.get(key)
}
