import { getConfig } from '../config'
import { NotifyError, type SmsAdapter } from './types'

/**
 * Twilio SMS. Not free — roughly $0.0079 per message plus ~$1.15/month for a
 * number — so it ships disabled (SMS_PROVIDER="none"). The implementation is
 * complete; turning it on is configuration, not code.
 *
 * To enable:
 *   1. Buy a number in the Twilio console.
 *   2. npx wrangler secret put TWILIO_ACCOUNT_SID
 *      npx wrangler secret put TWILIO_AUTH_TOKEN
 *      npx wrangler secret put TWILIO_FROM        (e.g. +15055550123)
 *   3. Set SMS_PROVIDER to "twilio" in wrangler.jsonc.
 *
 * Players still control this per-account via their notifySms preference.
 */
export const twilioSms: SmsAdapter = {
  name: 'twilio',
  async send(to: string, body: string) {
    const { twilio } = getConfig()
    if (!twilio.accountSid || !twilio.authToken || !twilio.from) {
      throw new NotifyError('Twilio credentials are not fully configured', 'twilio')
    }

    const endpoint = `https://api.twilio.com/2010-04-01/Accounts/${twilio.accountSid}/Messages.json`
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${btoa(`${twilio.accountSid}:${twilio.authToken}`)}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: to, From: twilio.from, Body: body }),
    })

    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new NotifyError(`Twilio responded ${response.status}: ${detail}`, 'twilio')
    }
  },
}
