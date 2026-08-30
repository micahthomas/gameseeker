import type { ClinicBrief } from '../clinics'
import type { GameBrief } from '../notify/templates'
import { venueOf } from '../notify/templates'
import { seekerLabel } from '../rating'
import { formatRange } from '../time'
import type { InboxEntryInput } from './playerInbox'

/**
 * What a player sees in the bell, mirroring the emails in
 * `../notify/templates.ts`.
 *
 * Kept short on purpose: an inbox entry is a glance, not a letter. The body is
 * one line of where-and-when, and the URL takes them to the game for anything
 * more. The email remains the long form.
 */

function whereAndWhen(game: GameBrief): string {
  return `${formatRange(game.startsAt, game.endsAt)} · ${venueOf(game)}`
}

export function invitedEntry(
  game: GameBrief,
  seekerNtrp: number,
  claimUrl: string,
): InboxEntryInput {
  return {
    kind: 'invited',
    gameId: game.id,
    title: `A ${seekerLabel(seekerNtrp)} ${game.format} spot is open`,
    body: whereAndWhen(game),
    url: claimUrl,
  }
}

export function spotConfirmedEntry(game: GameBrief, gameUrl: string): InboxEntryInput {
  return {
    kind: 'spot-confirmed',
    gameId: game.id,
    title: `You're in at ${venueOf(game)}`,
    body: whereAndWhen(game),
    url: gameUrl,
  }
}

/**
 * The game filled and took a court. Names the court, because until this moment
 * nobody could be told one.
 */
export function gameOnEntry(game: GameBrief, gameUrl: string): InboxEntryInput {
  return {
    kind: 'game-on',
    gameId: game.id,
    title: `Your game is on at ${venueOf(game)}`,
    body: game.courtName ? `${whereAndWhen(game)} · ${game.courtName}` : whereAndWhen(game),
    url: gameUrl,
  }
}

export function hostFilledEntry(
  game: GameBrief,
  playerName: string,
  remaining: number,
  gameUrl: string,
): InboxEntryInput {
  return {
    kind: 'host-filled',
    gameId: game.id,
    title: `${playerName} joined your game`,
    body:
      remaining === 0
        ? `${whereAndWhen(game)} · full`
        : `${whereAndWhen(game)} · ${remaining} spot${remaining === 1 ? '' : 's'} left`,
    url: gameUrl,
  }
}

export function cancelledEntry(game: GameBrief, reason: string, gameUrl: string): InboxEntryInput {
  return {
    kind: 'game-cancelled',
    gameId: game.id,
    title: `Called off: ${venueOf(game)}`,
    body: reason,
    url: gameUrl,
  }
}

export function reminderEntry(game: GameBrief, gameUrl: string): InboxEntryInput {
  return {
    kind: 'reminder',
    gameId: game.id,
    title: `Tomorrow: tennis at ${venueOf(game)}`,
    body: whereAndWhen(game),
    url: gameUrl,
  }
}

export function hostNudgeEntry(game: GameBrief, open: number, gameUrl: string): InboxEntryInput {
  return {
    kind: 'host-nudge',
    gameId: game.id,
    title: `Your game still needs ${open} player${open === 1 ? '' : 's'}`,
    body: whereAndWhen(game),
    url: gameUrl,
  }
}

export function unplaceableEntry(game: GameBrief, gameUrl: string): InboxEntryInput {
  return {
    kind: 'unplaceable',
    gameId: game.id,
    title: 'Your game is full but needs a court',
    body: `${formatRange(game.startsAt, game.endsAt)} · every court you offered was taken`,
    url: gameUrl,
  }
}

// --- Clinics ---------------------------------------------------------------

function clinicWhen(clinic: ClinicBrief): string {
  const when = clinic.startsAt && clinic.endsAt ? `${formatRange(clinic.startsAt, clinic.endsAt)} · ` : ''
  return `${when}${clinic.locationName}`
}

export function clinicAnnouncedEntry(clinic: ClinicBrief, clinicUrl: string): InboxEntryInput {
  return {
    kind: 'clinic-announced',
    title: `New clinic: ${clinic.title}`,
    body: clinicWhen(clinic),
    url: clinicUrl,
  }
}

export function clinicSignupEntry(clinic: ClinicBrief, clinicUrl: string): InboxEntryInput {
  return {
    kind: 'clinic-signup',
    title: `You're in: ${clinic.title}`,
    body: clinicWhen(clinic),
    url: clinicUrl,
  }
}

export function clinicReminderEntry(clinic: ClinicBrief, clinicUrl: string): InboxEntryInput {
  return {
    kind: 'clinic-reminder',
    title: `${clinic.title} is tomorrow`,
    body: clinicWhen(clinic),
    url: clinicUrl,
  }
}

export function clinicCancelledEntry(
  clinic: ClinicBrief,
  reason: string,
  clinicUrl: string,
): InboxEntryInput {
  return {
    kind: 'clinic-cancelled',
    title: `${clinic.title} is cancelled`,
    body: reason,
    url: clinicUrl,
  }
}
