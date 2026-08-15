import { env } from 'cloudflare:workers'

export type MailProvider = 'console' | 'resend'
export type SmsProvider = 'none' | 'twilio'

/**
 * Reads runtime configuration. A function rather than a module-level constant
 * because bindings aren't guaranteed to be populated at import time.
 *
 * The `as` casts widen the literal types wrangler generates from wrangler.jsonc
 * (it types APP_URL as the exact string in the file) back to their real types.
 */
export function getConfig() {
  return {
    appUrl: (env.APP_URL as string).replace(/\/$/, ''),
    mailProvider: env.MAIL_PROVIDER as MailProvider,
    smsProvider: env.SMS_PROVIDER as SmsProvider,
    mailFrom: env.MAIL_FROM as string,
    sessionSecret: env.SESSION_SECRET,
    resendApiKey: env.RESEND_API_KEY,
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
