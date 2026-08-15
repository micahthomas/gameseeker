import { getConfig } from '../config'
import { NotifyError, type MailAdapter, type OutboundMessage } from './types'

/**
 * Resend (https://resend.com) — free tier is 3,000 emails/month, 100/day, and
 * requires a verified sending domain. Plain fetch, no SDK, so it runs on
 * workerd without a Node shim.
 *
 * To enable:
 *   1. Add and verify your domain in the Resend dashboard.
 *   2. Set MAIL_FROM in wrangler.jsonc to an address on that domain.
 *   3. npx wrangler secret put RESEND_API_KEY
 *   4. Set MAIL_PROVIDER to "resend" in wrangler.jsonc.
 */
export const resendMail: MailAdapter = {
  name: 'resend',
  async send(to: string, message: OutboundMessage) {
    const { resendApiKey, mailFrom } = getConfig()
    if (!resendApiKey) {
      throw new NotifyError('RESEND_API_KEY is not set', 'resend')
    }

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: mailFrom,
        to: [to],
        subject: message.subject,
        text: message.text,
        html: message.html,
      }),
    })

    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new NotifyError(`Resend responded ${response.status}: ${detail}`, 'resend')
    }
  },
}
