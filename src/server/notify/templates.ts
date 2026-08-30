import { formatRange, relativeTime } from '../time'
import { markdownSummary } from '../markdown'
import { seekerLabel } from '../rating'
import { buildIcs, googleCalendarUrl, type CalendarAttendee, type CalendarEvent } from './calendar'
import type { ClinicBrief } from '../clinics'
import type { Attachment, OutboundMessage } from './types'

export type GameBrief = {
  id: string
  startsAt: number
  endsAt: number
  format: 'singles' | 'doubles'
  /** Null until the game fills and a court is assigned. */
  locationName: string | null
  locationAddress: string | null
  courtName: string | null
  /** Aimed at the courts rather than the park centroid. Null for both, or neither. */
  locationLat: number | null
  locationLng: number | null
  /** Where it might be, when no court is assigned yet. */
  candidateLocations?: string[]
  hostName: string
  notes: string | null
  /** iCalendar SEQUENCE, so a later message supersedes the invite already sent. */
  calendarSeq: number
}

/**
 * Escape text that goes into an HTML body.
 *
 * Host names, game notes and cancellation reasons are all player-written and
 * were being interpolated raw. Nothing in the app lets a player set a name
 * containing markup today, but an email template is the wrong place to be
 * relying on that.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * The calendar entry for a game.
 *
 * Only meaningful once the game has filled and taken a court — before that
 * there is no address and no certainty it will happen, which is why nothing
 * sends one earlier.
 */
export function gameCalendarEvent(game: GameBrief, gameUrl: string): CalendarEvent {
  const description = [
    `${game.format === 'singles' ? 'Singles' : 'Doubles'} with ${game.hostName}.`,
    game.notes,
    'Posted on Santa Fe GameSeeker. Public courts are first come, first served.',
  ]
    .filter(Boolean)
    .join('\n\n')

  return {
    uid: `game-${game.id}@gameseeker.app`,
    sequence: game.calendarSeq,
    startsAt: game.startsAt,
    endsAt: game.endsAt,
    summary: `Tennis at ${venueOf(game)}`,
    description,
    location: [placeOf(game), game.locationAddress].filter(Boolean).join(', '),
    geo:
      game.locationLat !== null && game.locationLng !== null
        ? { lat: game.locationLat, lng: game.locationLng }
        : null,
    url: gameUrl,
  }
}

function icsAttachment(event: CalendarEvent, attendee?: CalendarAttendee | null): Attachment {
  return {
    filename: `${event.cancelled ? 'cancelled-' : ''}game.ics`,
    content: buildIcs(event, attendee),
    // The method belongs on the content type as well as inside the file —
    // Outlook in particular reads it from here to decide how to treat the part.
    contentType: `text/calendar; charset=utf-8; method=${event.cancelled ? 'CANCEL' : 'PUBLISH'}`,
  }
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

/**
 * The venue, or the shortlist it will be chosen from.
 *
 * A game holds no court until it fills, so most invitations go out before
 * there is one. Naming the candidates is the difference between an invitation
 * someone can act on and "come and play tennis somewhere".
 */
export function venueOf(game: GameBrief): string {
  if (game.locationName) return game.locationName
  const options = game.candidateLocations ?? []
  if (options.length === 0) return 'a court to be confirmed'
  if (options.length === 1) return options[0]!
  return `${options.slice(0, -1).join(', ')} or ${options.at(-1)}`
}

/** Where a game is, or an honest note that it isn't decided yet. */
export function placeOf(game: GameBrief): string {
  if (!game.courtName) return `${venueOf(game)} - court confirmed once it fills`
  return `${game.locationName} - ${game.courtName}`
}

function whereAndWhen(game: GameBrief): string {
  const address = game.locationAddress
    ? `<br /><span style="color:#7b847d">${escapeHtml(game.locationAddress)}</span>`
    : ''
  const place = game.courtName
    ? `${escapeHtml(game.locationName ?? '')} &middot; ${escapeHtml(game.courtName)}${address}`
    : `${escapeHtml(venueOf(game))} &middot; <span style="color:#7b847d">court confirmed once it fills</span>`
  return `<p style="margin:0 0 6px"><strong>${formatRange(game.startsAt, game.endsAt)}</strong></p>
  <p style="margin:0 0 6px">${place}</p>
  <p style="margin:0"><span style="text-transform:capitalize">${game.format}</span> &middot; hosted by ${escapeHtml(game.hostName)}</p>`
}

function plainWhereAndWhen(game: GameBrief): string {
  const lines = [formatRange(game.startsAt, game.endsAt), placeOf(game)]
  if (game.locationAddress) lines.push(game.locationAddress)
  lines.push(`${game.format} - hosted by ${game.hostName}`)
  return lines.join('\n')
}

/**
 * The sign-in email.
 *
 * **The full URL is printed as visible text on purpose — don't "tidy" it away
 * as a duplicate of the button.** Every one of these has the same subject and
 * lands in the same Gmail thread, and Gmail hides content that repeats an
 * earlier message in a thread behind a "..." toggle. The button's `href`
 * changes each time, but its *visible* text doesn't, so with only a button the
 * entire body is a repeat and Gmail collapses the whole email — the link ends
 * up hidden behind the toggle and sign-in looks broken. Printing the URL puts
 * the one-time token in the visible text, which makes each message unlike the
 * last and keeps it expanded. It also rescues anyone whose client strips the
 * button, which is why it was already in the plain-text part.
 */
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
       <p style="margin:0 0 4px;font-size:13px;color:#7b847d">Or paste this link into your browser:</p>
       <p style="margin:0 0 20px;font-size:13px;line-height:1.5;word-break:break-all"><a href="${url}" style="color:#2f5d3f">${url}</a></p>
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
    subject: `Tennis ${relativeTime(game.startsAt)}: ${venueOf(game)} (${seekerNtrp.toFixed(1)})`,
    text,
    html: layout(
      heading,
      `${whereAndWhen(game)}
       ${game.notes ? `<p style="margin:14px 0 0;padding:12px;background:#f6f7f4;border-radius:8px">${escapeHtml(game.notes)}</p>` : ''}
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
    subject: `Confirmed: tennis at ${venueOf(game)}, ${formatRange(game.startsAt, game.endsAt)}`,
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
  const heading = `${escapeHtml(playerName)} joined your game`
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
    subject: `Reminder: tennis at ${venueOf(game)} ${relativeTime(game.startsAt)}`,
    text,
    html: layout(
      heading,
      `${whereAndWhen(game)}
       <p style="margin:16px 0 0"><strong>Playing:</strong> ${roster.map(escapeHtml).join(', ')}</p>
       ${button(gameUrl, 'View game')}`,
    ),
  }
}

/**
 * The game is off.
 *
 * Carries a METHOD:CANCEL invite with the same UID and a bumped SEQUENCE, so
 * the entry a player already accepted disappears rather than sitting on their
 * calendar. Apple Calendar and Outlook honour that reliably and Google is
 * inconsistent about it, which is why the body says so in words as well —
 * the file is the convenience, the sentence is the guarantee.
 *
 * `attendee` and `gameUrl` are optional so a game that never filled — and so
 * never put anything on anyone's calendar — sends the plain message it always
 * did.
 */
export function cancelledEmail(
  game: GameBrief,
  reason: string,
  gameUrl?: string,
  attendee?: CalendarAttendee | null,
): OutboundMessage {
  const heading = 'Game cancelled'
  const wasOnCalendar = Boolean(gameUrl && game.courtName)
  const note = wasOnCalendar
    ? 'If it stays on your calendar, delete it there — not every app removes it automatically.'
    : ''
  const text = [heading, '', reason, '', plainWhereAndWhen(game), note ? `\n${note}` : '']
    .filter(Boolean)
    .join('\n')

  return {
    subject: `Cancelled: tennis at ${venueOf(game)}, ${formatRange(game.startsAt, game.endsAt)}`,
    text,
    html: layout(
      heading,
      `<p style="margin:0 0 16px">${escapeHtml(reason)}</p>${whereAndWhen(game)}${
        note ? `<p style="margin:18px 0 0;font-size:13px;color:#7b847d">${note}</p>` : ''
      }`,
    ),
    ...(wasOnCalendar
      ? {
          attachments: [
            icsAttachment(
              // `cancelGame` already advanced the stored sequence; adding
              // another here would put the file ahead of the database and
              // strand the next update behind it.
              { ...gameCalendarEvent(game, gameUrl!), cancelled: true },
              attendee,
            ),
          ],
        }
      : {}),
  }
}

/**
 * The moment the last seat goes — and the only message that can carry a real
 * calendar entry, because it is the first one that knows the court.
 *
 * Sent to *everyone* in the game, not just whoever claimed last. The players
 * who signed up earlier were told "court confirmed once it fills" and would
 * otherwise never hear which court it is.
 */
export function gameOnEmail(
  game: GameBrief,
  gameUrl: string,
  roster: string[],
  attendee?: CalendarAttendee | null,
): OutboundMessage {
  const heading = 'Your game is on'
  const event = gameCalendarEvent(game, gameUrl)
  const text = [
    heading,
    '',
    'That\'s everyone. The court is booked:',
    '',
    plainWhereAndWhen(game),
    '',
    `Playing: ${roster.join(', ')}`,
    '',
    `Add it to your calendar: ${googleCalendarUrl(event)}`,
    '',
    `Details: ${gameUrl}`,
  ].join('\n')

  return {
    subject: `It's on: tennis at ${venueOf(game)}, ${formatRange(game.startsAt, game.endsAt)}`,
    text,
    html: layout(
      heading,
      `<p style="margin:0 0 16px">That's everyone. The court is booked.</p>
       ${whereAndWhen(game)}
       <p style="margin:16px 0 0"><strong>Playing:</strong> ${roster.map(escapeHtml).join(', ')}</p>
       ${button(gameUrl, 'View game')}
       <p style="margin:0;font-size:13px;color:#7b847d">The invite is attached, or
       <a href="${googleCalendarUrl(event)}" style="color:#2f5d3f">add it to Google Calendar</a>.</p>`,
    ),
    attachments: [icsAttachment(event, attendee)],
  }
}

/** SMS bodies are kept short; a long text costs more and reads badly. */
/**
 * The flexible-booking failure, told to the host.
 *
 * Deliberately not phrased as a cancellation: the game has its players, it
 * just has nowhere to go. Everything the host needs to fix it — move the time
 * or offer more courts — is a decision only they can make.
 */
export function unplaceableEmail(game: GameBrief, gameUrl: string): OutboundMessage {
  const heading = 'Your game is full, but every court has gone'
  const lines = [
    heading,
    '',
    plainWhereAndWhen(game),
    '',
    'Everyone you needed has signed up. While the game was filling, the courts you',
    'offered were all booked by somebody else.',
    '',
    'Pick a different time, or offer more courts, and the game can go ahead:',
    gameUrl,
  ]
  return {
    subject: `Your game is full but needs a court`,
    text: lines.join('\n'),
    html: layout(
      heading,
      `${whereAndWhen(game)}
      <p style="margin:18px 0 0">Everyone you needed has signed up. While the game was filling,
      the courts you offered were all booked by somebody else.</p>
      <p style="margin:10px 0 0">Pick a different time, or offer more courts, and it can go ahead.</p>
      ${button(gameUrl, 'Move the game')}`,
    ),
  }
}

export function seekerAlertSms(game: GameBrief, seekerNtrp: number, claimUrl: string): string {
  return `Tennis ${formatRange(game.startsAt, game.endsAt)} at ${placeOf(game)}. ${game.format}, ${seekerNtrp.toFixed(1)}. First to confirm plays: ${claimUrl}`
}

export function reminderSms(game: GameBrief, gameUrl: string): string {
  return `Reminder: tennis ${formatRange(game.startsAt, game.endsAt)} at ${placeOf(game)}. ${gameUrl}`
}

// ---------------------------------------------------------------------------
// Clinics
// ---------------------------------------------------------------------------

/**
 * The clinic templates deliberately don't share `whereAndWhen` with the game
 * ones. A game's where-and-when has to hedge — most invitations go out before
 * it holds a court. A clinic always has one, so hedging would be a lie, and
 * folding both into a single helper would make each half harder to read than
 * the small amount of duplication it saved.
 */
function clinicWhereAndWhen(clinic: ClinicBrief): string {
  const when =
    clinic.startsAt && clinic.endsAt
      ? `<p style="margin:0 0 6px"><strong>${formatRange(clinic.startsAt, clinic.endsAt)}</strong></p>`
      : ''
  const address = clinic.locationAddress
    ? `<br /><span style="color:#7b847d">${escapeHtml(clinic.locationAddress)}</span>`
    : ''
  const court = clinic.courtName ? ` &middot; ${escapeHtml(clinic.courtName)}` : ''
  return `${when}
  <p style="margin:0 0 6px">${escapeHtml(clinic.locationName)}${court}${address}</p>
  <p style="margin:0">Run by ${escapeHtml(clinic.organizerName)}</p>`
}

function plainClinicWhereAndWhen(clinic: ClinicBrief): string {
  const lines: string[] = []
  if (clinic.startsAt && clinic.endsAt) lines.push(formatRange(clinic.startsAt, clinic.endsAt))
  lines.push(clinic.courtName ? `${clinic.locationName} - ${clinic.courtName}` : clinic.locationName)
  if (clinic.locationAddress) lines.push(clinic.locationAddress)
  lines.push(`Run by ${clinic.organizerName}`)
  return lines.join('\n')
}

function costLine(clinic: ClinicBrief): string {
  return clinic.costNote ? `<p style="margin:14px 0 0">${escapeHtml(clinic.costNote)}</p>` : ''
}

export function clinicCalendarEvent(clinic: ClinicBrief, clinicUrl: string): CalendarEvent {
  return {
    uid: `clinic-${clinic.occurrenceId}@gameseeker.app`,
    sequence: clinic.calendarSeq,
    startsAt: clinic.startsAt!,
    endsAt: clinic.endsAt!,
    summary: clinic.title,
    description: [
      markdownSummary(clinic.descriptionMd, 400),
      clinic.costNote,
      `Run by ${clinic.organizerName}.`,
    ]
      .filter(Boolean)
      .join('\n\n'),
    location: [
      clinic.courtName ? `${clinic.locationName} - ${clinic.courtName}` : clinic.locationName,
      clinic.locationAddress,
    ]
      .filter(Boolean)
      .join(', '),
    geo:
      clinic.locationLat !== null && clinic.locationLng !== null
        ? { lat: clinic.locationLat, lng: clinic.locationLng }
        : null,
    url: clinicUrl,
  }
}

/** Sent when a clinic is published, to players who asked to hear about them. */
export function clinicAnnouncedEmail(clinic: ClinicBrief, clinicUrl: string): OutboundMessage {
  const heading = `New clinic at ${clinic.locationName}: ${clinic.title}`
  const summary = markdownSummary(clinic.descriptionMd, 220)
  const dates =
    clinic.upcoming === 1 ? 'One session' : `${clinic.upcoming} sessions`

  const text = [
    heading,
    '',
    summary,
    '',
    `${dates}, ${clinic.capacity} places each.`,
    '',
    plainClinicWhereAndWhen(clinic),
    clinic.costNote ? `\n${clinic.costNote}` : '',
    '',
    `Sign up: ${clinicUrl}`,
  ]
    .filter(Boolean)
    .join('\n')

  return {
    subject: `${clinic.title} at ${clinic.locationName}`,
    text,
    html: layout(
      heading,
      `${summary ? `<p style="margin:0 0 16px">${escapeHtml(summary)}</p>` : ''}
       ${clinicWhereAndWhen(clinic)}
       <p style="margin:14px 0 0">${dates}, ${clinic.capacity} places each.</p>
       ${costLine(clinic)}
       ${button(clinicUrl, 'See the clinic')}`,
    ),
  }
}

/** Sent to a player who just took a place. Carries the calendar invite. */
export function clinicSignupEmail(
  clinic: ClinicBrief,
  clinicUrl: string,
  attendee?: CalendarAttendee | null,
): OutboundMessage {
  const heading = `You're in: ${clinic.title}`
  const event = clinicCalendarEvent(clinic, clinicUrl)
  const text = [
    heading,
    '',
    plainClinicWhereAndWhen(clinic),
    clinic.costNote ? `\n${clinic.costNote}` : '',
    '',
    `Add it to your calendar: ${googleCalendarUrl(event)}`,
    '',
    clinicUrl,
  ]
    .filter(Boolean)
    .join('\n')

  return {
    subject: `Confirmed: ${clinic.title}, ${formatRange(clinic.startsAt!, clinic.endsAt!)}`,
    text,
    html: layout(
      heading,
      `${clinicWhereAndWhen(clinic)}
       ${costLine(clinic)}
       ${button(clinicUrl, 'View the clinic')}
       <p style="margin:0;font-size:13px;color:#7b847d">The invite is attached, or
       <a href="${googleCalendarUrl(event)}" style="color:#2f5d3f">add it to Google Calendar</a>.</p>`,
    ),
    attachments: [icsAttachment(event, attendee)],
  }
}

/** Cron, roughly a day out. */
export function clinicReminderEmail(clinic: ClinicBrief, clinicUrl: string): OutboundMessage {
  const heading = `${clinic.title} ${relativeTime(clinic.startsAt!)}`
  return {
    subject: `Reminder: ${clinic.title} ${relativeTime(clinic.startsAt!)}`,
    text: [heading, '', plainClinicWhereAndWhen(clinic), '', clinicUrl].join('\n'),
    html: layout(heading, `${clinicWhereAndWhen(clinic)}${costLine(clinic)}${button(clinicUrl, 'View the clinic')}`),
  }
}

/** One date, or the whole series, called off. */
export function clinicCancelledEmail(
  clinic: ClinicBrief,
  reason: string,
  clinicUrl: string,
  attendee?: CalendarAttendee | null,
): OutboundMessage {
  const heading = `${clinic.title} is cancelled`
  const note =
    'If it stays on your calendar, delete it there — not every app removes it automatically.'
  const text = [heading, '', reason, '', plainClinicWhereAndWhen(clinic), '', note].join('\n')

  const wasOnCalendar = clinic.occurrenceId !== null && clinic.startsAt !== null
  return {
    subject: `Cancelled: ${clinic.title}`,
    text,
    html: layout(
      heading,
      `<p style="margin:0 0 16px">${escapeHtml(reason)}</p>
       ${clinicWhereAndWhen(clinic)}
       <p style="margin:18px 0 0;font-size:13px;color:#7b847d">${note}</p>`,
    ),
    ...(wasOnCalendar
      ? {
          attachments: [
            icsAttachment(
              { ...clinicCalendarEvent(clinic, clinicUrl), cancelled: true },
              attendee,
            ),
          ],
        }
      : {}),
  }
}

/** The answer to a request to run clinics. */
export function organizerDecisionEmail(approved: boolean, appUrl: string): OutboundMessage {
  const heading = approved
    ? 'You can now run clinics'
    : "We can't approve clinic hosting right now"
  const body = approved
    ? 'Your request was approved. You can set up a recurring session, describe it, and take signups.'
    : "Your request wasn't approved this time. If you think that's a mistake, reply to this email and tell us about the clinic you had in mind."

  return {
    subject: approved ? 'You can now run clinics on GameSeeker' : 'About your organizer request',
    text: [heading, '', body, '', approved ? `${appUrl}/clinics/new` : appUrl].join('\n'),
    html: layout(
      heading,
      `<p style="margin:0">${body}</p>${button(approved ? `${appUrl}/clinics/new` : appUrl, approved ? 'Set up a clinic' : 'Open GameSeeker')}`,
    ),
  }
}

export function clinicSignupSms(clinic: ClinicBrief, clinicUrl: string): string {
  return `${clinic.title} confirmed: ${formatRange(clinic.startsAt!, clinic.endsAt!)} at ${clinic.locationName}. ${clinicUrl}`
}
