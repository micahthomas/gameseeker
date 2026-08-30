import { getConfig } from '../config'
import { toBase64 } from './calendar'
import { NotifyError, type MailAdapter, type OutboundMessage } from './types'

/**
 * Resend (https://resend.com) — free tier is 3,000 emails/month, 100/day, and
 * requires a verified sending domain. Plain fetch, no SDK, so it runs on
 * workerd without a Node shim.
 *
 * To enable:
 *   1. Add and verify your domain in the Resend dashboard.
 *   2. Set MAIL_FROM in wrangler.jsonc to an address on that domain.
 *   3. mise run secrets:push  (or: wrangler secret put RESEND_API_TOKEN)
 *   4. Set MAIL_PROVIDER to "resend" in wrangler.jsonc.
 */
export const resendMail: MailAdapter = {
  name: 'resend',
  async send(to: string, message: OutboundMessage) {
    const { resendApiToken, mailFrom } = getConfig()
    if (!resendApiToken) {
      throw new NotifyError('RESEND_API_TOKEN is not set', 'resend')
    }

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resendApiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: mailFrom,
        to: [to],
        subject: message.subject,
        text: message.text,
        html: message.html,
        // Resend wants base64 in `content`. Omitted entirely rather than sent
        // empty, so an ordinary message keeps the body it has always had.
        ...(message.attachments?.length
          ? {
              attachments: message.attachments.map((a) => ({
                filename: a.filename,
                content: toBase64(a.content),
                content_type: a.contentType,
              })),
            }
          : {}),
      }),
    })

    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new NotifyError(`Resend responded ${response.status}: ${detail}`, 'resend')
    }
  },
}
