import type { User } from '~/db/schema'
import { getConfig, type MailProvider } from '../config'
import { consoleMail, consoleSms } from './console'
import { resendMail } from './resend'
import { twilioSms } from './twilio'
import type { MailAdapter, OutboundMessage, SmsAdapter } from './types'

export * from './types'
export * from './templates'

/**
 * Which adapter actually gets used, given what's configured and what's available.
 *
 * `MAIL_PROVIDER` in wrangler.jsonc is a production value, but the same vars
 * back `npm run dev`. Without this, pointing production at Resend would break
 * every fresh clone: no token locally means no sign-in email, and no sign-in
 * email means no way into the app.
 *
 * So in development a configured-but-unusable provider degrades to the log,
 * which is where a developer reads their magic link anyway. Set a token in
 * .dev.vars (`mise run secrets:dev`) and dev sends for real.
 *
 * Production deliberately does **not** degrade. Quietly writing real
 * invitations to a log nobody reads is worse than a delivery failure, which at
 * least lands on the notification row and in the Worker logs.
 */
export function resolveMailProvider(
  configured: MailProvider,
  hasResendToken: boolean,
  isDev: boolean,
): MailProvider {
  if (configured !== 'resend') return configured
  return isDev && !hasResendToken ? 'console' : 'resend'
}

function mailAdapter(): MailAdapter {
  const { mailProvider, resendApiToken } = getConfig()
  const resolved = resolveMailProvider(
    mailProvider,
    Boolean(resendApiToken),
    Boolean(import.meta.env?.DEV),
  )
  return resolved === 'resend' ? resendMail : consoleMail
}

function smsAdapter(): SmsAdapter | null {
  const { smsProvider } = getConfig()
  if (smsProvider === 'twilio') return twilioSms
  // "none" still logs in dev so you can see what would have gone out.
  return import.meta.env?.DEV ? consoleSms : null
}

export async function sendEmail(to: string, message: OutboundMessage): Promise<void> {
  await mailAdapter().send(to, message)
}

export async function sendSms(to: string, body: string): Promise<void> {
  const adapter = smsAdapter()
  if (!adapter) return
  await adapter.send(to, body)
}

export type DeliveryResult = {
  channels: Array<'email' | 'sms'>
  errors: Array<{ channel: 'email' | 'sms'; message: string }>
}

/**
 * Deliver to a player over every channel they've opted into.
 *
 * Failures are collected rather than thrown: one player's bad email address
 * must not abort a fan-out to twenty other players. Callers persist the result
 * on the notification row.
 */
export async function notifyUser(
  user: Pick<User, 'email' | 'phone' | 'notifyEmail' | 'notifySms'>,
  message: OutboundMessage,
  smsBody?: string,
): Promise<DeliveryResult> {
  const result: DeliveryResult = { channels: [], errors: [] }

  if (user.notifyEmail && user.email) {
    try {
      await sendEmail(user.email, message)
      result.channels.push('email')
    } catch (error) {
      result.errors.push({ channel: 'email', message: String(error) })
    }
  }

  if (user.notifySms && user.phone) {
    try {
      await sendSms(user.phone, smsBody ?? message.text)
      result.channels.push('sms')
    } catch (error) {
      result.errors.push({ channel: 'sms', message: String(error) })
    }
  }

  return result
}
