import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { GAME_FORMATS } from '~/db/schema'
import { getCurrentUser, requireUser } from '~/server/auth'
import { freeCourtsAt, gamesAtLocation, getLocationWithCourts, listLocations } from '~/server/booking'
import { availabilityDensity } from '~/server/availability'
import {
  cancelGame,
  claimAnyOpenSlot,
  gameRosters,
  claimSlot,
  createGame,
  gameParticipants,
  getGame,
  getGameBrief,
  leaveGame,
  listMyGames,
  listOpenGamesFor,
  listPastGames,
  listUpcomingGames,
  markNotificationClaimed,
  resolveClaimToken,
  seatsToFill,
} from '~/server/games'
import { notifyCandidatesForGame, previewReach } from '~/server/matching'
import { enqueueNotifications, type NotifyMessage } from '~/server/notify/queue'
import { DAY } from '~/server/time'

const slotInput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('invited'), invitedUserId: z.string().min(1) }),
  z.object({
    kind: z.literal('seeker'),
    seekerNtrp: z.number().min(1).max(7),
    seekerGender: z.enum(['woman', 'man']).nullable().optional(),
  }),
])

export const fetchDashboard = createServerFn({ method: 'GET' }).handler(async () => {
  const user = await getCurrentUser()
  if (!user) return { signedIn: false as const }

  const [myGames, openGames, upcoming] = await Promise.all([
    listMyGames(user.id),
    listOpenGamesFor(user),
    listUpcomingGames(Date.now(), 25),
  ])

  return { signedIn: true as const, myGames, openGames, upcoming }
})

export const fetchGame = createServerFn({ method: 'GET' })
  .validator(z.object({ gameId: z.string() }))
  .handler(async ({ data }) => {
    const user = await getCurrentUser()
    const detail = await getGame(data.gameId)
    if (!detail) return null

    const isParticipant = detail.slots.some((s) => s.player?.id === user?.id)

    return {
      ...detail,
      viewer: user
        ? {
            id: user.id,
            ntrp: user.ntrp,
            playLevels: user.playLevels,
            gender: user.gender,
            playsMixed: user.playsMixed,
            isHost: detail.game.hostId === user.id,
            isParticipant,
            isAdmin: user.isAdmin,
          }
        : null,
    }
  })

export const fetchMyHistory = createServerFn({ method: 'GET' }).handler(async () => {
  const user = await requireUser()
  return listPastGames(user.id)
})

/** Courts free for a window, so the create form only offers real options. */
export const fetchFreeCourts = createServerFn({ method: 'GET' })
  .validator(z.object({ locationId: z.string(), startsAt: z.number(), endsAt: z.number() }))
  .handler(async ({ data }) => {
    await requireUser()
    return freeCourtsAt(data.locationId, data.startsAt, data.endsAt)
  })

/** How many players would be alerted — shown before the host commits. */
export const fetchReach = createServerFn({ method: 'GET' })
  .validator(
    z.object({
      startsAt: z.number(),
      endsAt: z.number(),
      format: z.enum(GAME_FORMATS),
      seekerLevels: z.array(z.number()).min(1).max(9),
      isMixed: z.boolean().optional(),
      seekerGenders: z.array(z.enum(['woman', 'man'])).optional(),
    }),
  )
  .handler(async ({ data }) => {
    const user = await requireUser()
    const count = await previewReach({
      hostId: user.id,
      startsAt: data.startsAt,
      endsAt: data.endsAt,
      format: data.format,
      seekerLevels: data.seekerLevels,
      isMixed: data.isMixed,
      seekerGenders: data.seekerGenders,
    })
    return { count }
  })

export const postGame = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      courtId: z.string().min(1),
      startsAt: z.number(),
      endsAt: z.number(),
      format: z.enum(GAME_FORMATS),
      isMixed: z.boolean().optional(),
      notes: z.string().trim().max(400).optional(),
      slots: z.array(slotInput).min(1).max(3),
    }),
  )
  .handler(async ({ data }) => {
    const user = await requireUser()

    if (data.slots.length !== seatsToFill(data.format)) {
      throw new Error(
        `A ${data.format} game needs ${seatsToFill(data.format)} other player${
          seatsToFill(data.format) === 1 ? '' : 's'
        }.`,
      )
    }

    const game = await createGame({
      hostId: user.id,
      hostNtrp: user.ntrp,
      courtId: data.courtId,
      startsAt: data.startsAt,
      endsAt: data.endsAt,
      format: data.format,
      isMixed: data.isMixed ?? false,
      hostGender: user.gender,
      notes: data.notes ?? null,
      slots: data.slots,
    })

    // Awaited, but it no longer sends anything: it writes one notification row
    // per candidate and hands the whole set to the queue in a single call. The
    // host still gets a real count on the next screen, without waiting on a
    // round trip per recipient.
    const fanOut = await notifyCandidatesForGame(game.id)

    return { gameId: game.id, invited: fanOut.invited, candidates: fanOut.candidates }
  })

async function afterClaim(gameId: string, userId: string, slotId: string) {
  await markNotificationClaimed(slotId, userId)
  if (!(await getGameBrief(gameId))) return

  const participants = await gameParticipants(gameId)
  const claimer = participants.find((p) => p.id === userId)
  if (!claimer) return

  const detail = await getGame(gameId)
  const host = participants.find((p) => p.id === detail?.game.hostId)

  const messages: NotifyMessage[] = [{ kind: 'spot-confirmed', gameId, userId }]
  if (host) {
    messages.push({ kind: 'host-filled', gameId, userId: host.id, playerName: claimer.name })
  }
  await enqueueNotifications(messages)
}

export const claimGameSlot = createServerFn({ method: 'POST' })
  .validator(z.object({ gameId: z.string(), slotId: z.string().optional() }))
  .handler(async ({ data }) => {
    const user = await requireUser()
    const result = data.slotId
      ? await claimSlot(data.slotId, user)
      : await claimAnyOpenSlot(data.gameId, user)

    await afterClaim(data.gameId, user.id, result.slot.id)
    return { ok: true as const, gameId: data.gameId, remainingOpen: result.remainingOpen }
  })

/**
 * Claim from a notification link. The token identifies both the game and the
 * player it was sent to, so a forwarded link can't be used by someone else.
 */
export const claimByToken = createServerFn({ method: 'POST' })
  .validator(z.object({ token: z.string().min(10) }))
  .handler(async ({ data }) => {
    const user = await requireUser()
    const resolved = await resolveClaimToken(data.token)
    if (!resolved) return { ok: false as const, reason: 'That invitation link is no longer valid.' }
    if (resolved.userId !== user.id) {
      return {
        ok: false as const,
        reason: 'That invitation was sent to a different player. Ask the host to invite you.',
      }
    }

    const result = await claimAnyOpenSlot(resolved.gameId, user)
    await afterClaim(resolved.gameId, user.id, result.slot.id)
    return { ok: true as const, gameId: resolved.gameId, remainingOpen: result.remainingOpen }
  })

/** Who a claim link belongs to, so /claim can render before acting. */
export const inspectClaimToken = createServerFn({ method: 'GET' })
  .validator(z.object({ token: z.string().min(10) }))
  .handler(async ({ data }) => {
    const resolved = await resolveClaimToken(data.token)
    if (!resolved) return null
    const detail = await getGame(resolved.gameId)
    if (!detail) return null
    const user = await getCurrentUser()
    return {
      gameId: resolved.gameId,
      forUserId: resolved.userId,
      isForViewer: user?.id === resolved.userId,
      signedIn: Boolean(user),
      openSlots: detail.slots.filter((s) => s.slot.status === 'open').length,
      status: detail.game.status,
    }
  })

export const dropOut = createServerFn({ method: 'POST' })
  .validator(z.object({ gameId: z.string() }))
  .handler(async ({ data }) => {
    const user = await requireUser()
    await leaveGame(data.gameId, user.id)
    return { ok: true as const }
  })

export const callOffGame = createServerFn({ method: 'POST' })
  .validator(z.object({ gameId: z.string(), reason: z.string().trim().max(200).optional() }))
  .handler(async ({ data }) => {
    const user = await requireUser()
    const participants = await gameParticipants(data.gameId)
    const brief = await getGameBrief(data.gameId)

    await cancelGame(data.gameId, user.id, user.isAdmin)

    if (brief) {
      const reason = data.reason?.trim()
        ? `${user.name} cancelled: ${data.reason.trim()}`
        : `${user.name} cancelled this game.`
      await enqueueNotifications(
        participants
          .filter((player) => player.id !== user.id)
          .map((player) => ({
            kind: 'game-cancelled' as const,
            gameId: data.gameId,
            userId: player.id,
            reason,
          })),
      )
    }

    return { ok: true as const }
  })

// --- Locations --------------------------------------------------------------

export const fetchLocations = createServerFn({ method: 'GET' }).handler(async () => {
  return listLocations()
})

/**
 * A location's courts plus everything booked on them in a window, including
 * who's playing — that roster is the whole point of the day view.
 */
/**
 * How many players are free during each half hour of a day, for the heatmap
 * behind the court grid. Defaults to the levels the viewer plays, since "who
 * could I actually get a game with" is the question a host is asking.
 */
export const fetchDemand = createServerFn({ method: 'GET' })
  .validator(
    z.object({
      dayStart: z.number(),
      allLevels: z.boolean().optional(),
      format: z.enum(GAME_FORMATS).optional(),
    }),
  )
  .handler(async ({ data }) => {
    const user = await getCurrentUser()
    const levels = data.allLevels || !user ? undefined : user.playLevels
    const slots = await availabilityDensity(data.dayStart, data.dayStart + DAY, {
      levels,
      format: data.format,
    })
    return { slots, levels: levels ?? null }
  })

export const fetchLocationCalendar = createServerFn({ method: 'GET' })
  .validator(z.object({ locationId: z.string(), fromMs: z.number(), days: z.number().max(21) }))
  .handler(async ({ data }) => {
    const found = await getLocationWithCourts(data.locationId)
    if (!found) return null

    const toMs = data.fromMs + data.days * DAY
    const scheduled = await gamesAtLocation(data.locationId, data.fromMs, toMs)
    const rosters = await gameRosters(scheduled.map((row) => row.game.id))

    return {
      ...found,
      games: scheduled.map((row) => {
        const roster = rosters.get(row.game.id)
        return {
          id: row.game.id,
          courtId: row.court.id,
          startsAt: row.game.startsAt,
          endsAt: row.game.endsAt,
          format: row.game.format,
          isMixed: row.game.isMixed,
          status: row.game.status,
          players: roster?.players ?? [],
          openSlots: roster?.openSlots ?? 0,
        }
      }),
    }
  })
