import { env } from 'cloudflare:workers'
import { getRequestUrl } from '@tanstack/react-start/server'

export type MailProvider = 'console' | 'resend'
export type SmsProvider = 'none' | 'twilio'

/**
 * Reads runtime configuration. A function rather than a module-level constant
 * because bindings aren't guaranteed to be populated at import time.
 *
 * The `as` casts widen the literal types wrangler generates from wrangler.jsonc
 * (it types APP_URL as the exact string in the file) back to their real types.
 */
/**
 * The origin to build magic-link and claim URLs from.
 *
 * In development we use the origin of the request being handled, so the app
 * works on whatever port it happens to be running on (`vite dev --port 3100`,
 * a browser-test server, a LAN address on your phone) without editing config.
 *
 * In production we deliberately do NOT trust the request. A forged Host header
 * would otherwise mint a sign-in link pointing at an attacker's domain, and
 * the victim clicking it would hand over their account. Production always uses
 * the configured APP_URL — which is also the only thing cron can use, since a
 * scheduled run has no request at all.
 */
function resolveAppUrl(): string {
  const configured = (env.APP_URL as string).replace(/\/$/, '')
  if (!import.meta.env?.DEV) return configured
  try {
    return new URL(getRequestUrl()).origin
  } catch {
    // No request in scope — a cron trigger, or a module-level call.
    return configured
  }
}

export function getConfig() {
  return {
    appUrl: resolveAppUrl(),
    mailProvider: env.MAIL_PROVIDER as MailProvider,
    smsProvider: env.SMS_PROVIDER as SmsProvider,
    mailFrom: env.MAIL_FROM as string,
    sessionSecret: env.SESSION_SECRET,
    resendApiToken: env.RESEND_API_TOKEN,
    twilio: {
      accountSid: env.TWILIO_ACCOUNT_SID,
      authToken: env.TWILIO_AUTH_TOKEN,
      from: env.TWILIO_FROM,
    },
  }
}

/**
 * A development fallback so the app boots before any secrets are set. In
 * production `wrangler deploy` will have a real SESSION_SECRET; if it doesn't,
 * sessions silently reset on every deploy, so we fail loudly instead.
 */
export function sessionSecret(): string {
  const secret = env.SESSION_SECRET
  if (secret && secret.length >= 32) return secret
  if (import.meta.env?.DEV) {
    return 'dev-only-insecure-session-secret-value-32+'
  }
  throw new Error(
    'SESSION_SECRET is missing or shorter than 32 characters. Set it with: npx wrangler secret put SESSION_SECRET',
  )
}
