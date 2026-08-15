/** Random identifiers and one-way token hashing, on Web Crypto only. */

const BASE64URL = /[+/=]/g
const BASE64URL_MAP: Record<string, string> = { '+': '-', '/': '_', '=': '' }

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(BASE64URL, (c) => BASE64URL_MAP[c]!)
}

export function newId(): string {
  return crypto.randomUUID()
}

/** 32 bytes of entropy, URL-safe. Used for magic-link and claim tokens. */
export function newToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return toBase64Url(bytes)
}

/** SHA-256 hex. Tokens are stored hashed so a database leak isn't a login. */
export async function hashToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
