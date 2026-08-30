/**
 * A file to send alongside the message.
 *
 * `content` is the decoded body — adapters encode it however their provider
 * wants. Text-only for now, because the only attachment the app sends is a
 * calendar invite; a binary one would want bytes here instead.
 */
export type Attachment = {
  filename: string
  content: string
  contentType: string
}

export type OutboundMessage = {
  subject: string
  /** Plain-text body. Also used verbatim as the SMS body when sending by text. */
  text: string
  html: string
  /** Ignored by the SMS path, which has nowhere to put one. */
  attachments?: Attachment[]
}

export interface MailAdapter {
  readonly name: string
  send(to: string, message: OutboundMessage): Promise<void>
}

export interface SmsAdapter {
  readonly name: string
  send(to: string, body: string): Promise<void>
}

export class NotifyError extends Error {
  constructor(
    message: string,
    readonly adapter: string,
  ) {
    super(message)
    this.name = 'NotifyError'
  }
}
