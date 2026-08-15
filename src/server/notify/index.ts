import type { User } from '~/db/schema'
import { getConfig } from '../config'
import { consoleMail, consoleSms } from './console'
import { resendMail } from './resend'
import { twilioSms } from './twilio'
import type { MailAdapter, OutboundMessage, SmsAdapter } from './types'

export * from './types'
export * from './templates'

function mailAdapter(): MailAdapter {
  return getConfig().mailProvider === 'resend' ? resendMail : consoleMail
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
