import type { MailAdapter, OutboundMessage, SmsAdapter } from './types'

/**
 * The zero-setup default. Messages print to the Worker log instead of being
 * delivered, which is what makes local development possible without owning a
 * domain or holding an account with an email provider — magic-link and claim
 * URLs are right there in `npm run dev` output.
 */
export const consoleMail: MailAdapter = {
  name: 'console',
  async send(to: string, message: OutboundMessage) {
    console.log(
      [
        '',
        '┌─────────────────────────────────────────────────────────',
        `│ EMAIL → ${to}`,
        `│ ${message.subject}`,
        '├─────────────────────────────────────────────────────────',
        ...message.text.split('\n').map((line) => `│ ${line}`),
        // Named, not printed: an .ics is a wall of folded lines, and the only
        // thing worth knowing from the log is that one went out at all.
        ...(message.attachments ?? []).map(
          (a) => `│ [attachment: ${a.filename}, ${a.contentType}, ${a.content.length} bytes]`,
        ),
        '└─────────────────────────────────────────────────────────',
        '',
      ].join('\n'),
    )
  },
}

export const consoleSms: SmsAdapter = {
  name: 'console',
  async send(to: string, body: string) {
    console.log(`\n[SMS → ${to}] ${body}\n`)
  },
}
