export type OutboundMessage = {
  subject: string
  /** Plain-text body. Also used verbatim as the SMS body when sending by text. */
  text: string
  html: string
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
