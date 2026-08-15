import { formatRange, relativeTime } from '../time'
import { seekerLabel } from '../rating'
import type { OutboundMessage } from './types'

export type GameBrief = {
  id: string
  startsAt: number
  endsAt: number
  format: 'singles' | 'doubles'
  locationName: string
  locationAddress: string | null
  courtName: string
  hostName: string
  notes: string | null
}

function layout(heading: string, bodyHtml: string): string {
  return `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#f6f7f4;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1c2321">
    <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:12px;padding:28px;border:1px solid #e3e6e0">
      <div style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#5b7f5b;font-weight:600">Santa Fe GameSeeker</div>
      <h1 style="margin:12px 0 18px;font-size:21px;line-height:1.3">${heading}</h1>
      ${bodyHtml}
      <hr style="border:none;border-top:1px solid #e3e6e0;margin:26px 0 14px" />
      <div style="font-size:12px;color:#7b847d">
        You're receiving this because you set your availability on Santa Fe GameSeeker.
        Change your notification settings any time in your profile.
      </div>
    </div>
  </body>
</html>`
}

function button(href: string, label: string): string {
  return `<p style="margin:22px 0"><a href="${href}" style="display:inline-block;background:#2f5d3f;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600">${label}</a></p>`
}

function whereAndWhen(game: GameBrief): string {
  const address = game.locationAddress ? `<br /><span style="color:#7b847d">${game.locationAddress}</span>` : ''
  return `<p style="margin:0 0 6px"><strong>${formatRange(game.startsAt, game.endsAt)}</strong></p>
  <p style="margin:0 0 6px">${game.locationName} &middot; ${game.courtName}${address}</p>
  <p style="margin:0"><span style="text-transform:capitalize">${game.format}</span> &middot; hosted by ${game.hostName}</p>`
}

function plainWhereAndWhen(game: GameBrief): string {
  const lines = [
    formatRange(game.startsAt, game.endsAt),
    `${game.locationName} - ${game.courtName}`,
  ]
  if (game.locationAddress) lines.push(game.locationAddress)
  lines.push(`${game.format} - hosted by ${game.hostName}`)
  return lines.join('\n')
}

export function magicLinkEmail(url: string, isNewAccount: boolean): OutboundMessage {
  const heading = isNewAccount ? 'Finish setting up your account' : 'Your sign-in link'
  const text = [
    heading,
    '',
    'Click the link below to sign in. It expires in 15 minutes and works once.',
    '',
    url,
    '',
    "If you didn't request this, you can ignore this email.",
  ].join('\n')

  return {
    subject: 'Sign in to Santa Fe GameSeeker',
    text,
    html: layout(
      heading,
      `<p style="margin:0">Click below to sign in. This link expires in 15 minutes and can only be used once.</p>
       ${button(url, 'Sign in')}
       <p style="margin:0;font-size:13px;color:#7b847d">If you didn't request this, you can ignore this email.</p>`,
    ),
  }
}

/** Sent to a level-matched, available player when a game opens a seeker slot. */
export function seekerAlertEmail(
  game: GameBrief,
  seekerNtrp: number,
  claimUrl: string,
): OutboundMessage {
  const heading = `${game.format === 'singles' ? 'Singles' : 'Doubles'} game needs a ${seekerLabel(seekerNtrp)}`
  const text = [
    heading,
    '',
    plainWhereAndWhen(game),
    game.notes ? `\nNote from the host: ${game.notes}` : '',
    '',
    'First to confirm gets the spot:',
    claimUrl,
  ]
    .filter(Boolean)
    .join('\n')

  return {
    subject: `Tennis ${relativeTime(game.startsAt)}: ${game.locationName} (${seekerNtrp.toFixed(1)})`,
    text,
    html: layout(
      heading,
      `${whereAndWhen(game)}
       ${game.notes ? `<p style="margin:14px 0 0;padding:12px;background:#f6f7f4;border-radius:8px">${game.notes}</p>` : ''}
       ${button(claimUrl, "I'm in — claim this spot")}
       <p style="margin:0;font-size:13px;color:#7b847d">Spots go to whoever confirms first.</p>`,
    ),
  }
}

/** Sent to the claiming player once they've secured a spot. */
export function spotConfirmedEmail(game: GameBrief, gameUrl: string): OutboundMessage {
  const heading = "You're in"
  const text = [heading, '', plainWhereAndWhen(game), '', `Details: ${gameUrl}`].join('\n')
  return {
    subject: `Confirmed: tennis at ${game.locationName}, ${formatRange(game.startsAt, game.endsAt)}`,
    text,
    html: layout(heading, `${whereAndWhen(game)}${button(gameUrl, 'View game details')}`),
  }
}

/** Sent to the host each time somebody takes a spot. */
export function hostFilledEmail(
  game: GameBrief,
  playerName: string,
  remaining: number,
  gameUrl: string,
): OutboundMessage {
  const heading = `${playerName} joined your game`
  const status =
    remaining === 0
      ? 'That fills the game — you\'re all set.'
      : `${remaining} spot${remaining === 1 ? '' : 's'} still open.`
  const text = [heading, '', status, '', plainWhereAndWhen(game), '', gameUrl].join('\n')
  return {
    subject: `${playerName} joined your ${game.format} game`,
    text,
    html: layout(
      heading,
      `<p style="margin:0 0 16px">${status}</p>${whereAndWhen(game)}${button(gameUrl, 'View game')}`,
    ),
  }
}

export function reminderEmail(game: GameBrief, roster: string[], gameUrl: string): OutboundMessage {
  const heading = `Tennis ${relativeTime(game.startsAt)}`
  const text = [
    heading,
    '',
    plainWhereAndWhen(game),
    '',
    `Playing: ${roster.join(', ')}`,
    '',
    gameUrl,
  ].join('\n')
  return {
    subject: `Reminder: tennis at ${game.locationName} ${relativeTime(game.startsAt)}`,
    text,
    html: layout(
      heading,
      `${whereAndWhen(game)}
       <p style="margin:16px 0 0"><strong>Playing:</strong> ${roster.join(', ')}</p>
       ${button(gameUrl, 'View game')}`,
    ),
  }
}

export function cancelledEmail(game: GameBrief, reason: string): OutboundMessage {
  const heading = 'Game cancelled'
  const text = [heading, '', reason, '', plainWhereAndWhen(game)].join('\n')
  return {
    subject: `Cancelled: tennis at ${game.locationName}, ${formatRange(game.startsAt, game.endsAt)}`,
    text,
    html: layout(heading, `<p style="margin:0 0 16px">${reason}</p>${whereAndWhen(game)}`),
  }
}

/** SMS bodies are kept short; a long text costs more and reads badly. */
export function seekerAlertSms(game: GameBrief, seekerNtrp: number, claimUrl: string): string {
  return `Tennis ${formatRange(game.startsAt, game.endsAt)} at ${game.locationName} (${game.courtName}). ${game.format}, ${seekerNtrp.toFixed(1)}. First to confirm plays: ${claimUrl}`
}

export function reminderSms(game: GameBrief, gameUrl: string): string {
  return `Reminder: tennis ${formatRange(game.startsAt, game.endsAt)} at ${game.locationName}, ${game.courtName}. ${gameUrl}`
}
