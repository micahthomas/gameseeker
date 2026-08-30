import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { GAME_FORMATS, SEAT_DIVISIONS } from '~/db/schema'
import { getCurrentUser, requireUser } from '~/server/auth'
import {
  freeCourtsAt,
  freeCourtsEverywhere,
  gamesAtLocation,
  getLocationWithCourts,
  listLocations,
  pendingGamesAtLocation,
} from '~/server/booking'
import { projectPlacements } from '~/server/assign'
import { clinicsAtLocation, listMyClinics } from '~/server/clinics'
import { availabilityDensity } from '~/server/availability'
import { getConfig } from '~/server/config'
import { announceGameChanged, pushToInboxes } from '~/server/live'
import { cancelledEntry } from '~/server/live/entries'
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
  resolveClaimToken,
  seatsToFill,
} from '~/server/games'
import { notifyAfterClaim, notifyCandidatesForGame, previewReach } from '~/server/matching'
import { googleCalendarUrl } from '~/server/notify/calendar'
import { enqueueNotifications, type NotifyMessage } from '~/server/notify/queue'
import { gameCalendarEvent } from '~/server/notify/templates'
import { DAY } from '~/server/time'

const slotInput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('invited'), invitedUserId: z.string().min(1) }),
  z.object({
    kind: z.literal('seeker'),
    seekerNtrp: z.number().min(1).max(7),
    seekerDivision: z.enum(SEAT_DIVISIONS).nullable().optional(),
  }),
])

export const fetchDashboard = createServerFn({ method: 'GET' }).handler(async () => {
  const user = await getCurrentUser()
  if (!user) return { signedIn: false as const }

  const [myGames, openGames, upcoming, myClinics] = await Promise.all([
    listMyGames(user.id),
    listOpenGamesFor(user),
    listUpcomingGames(Date.now(), 25),
    listMyClinics(user.id),
  ])

  return { signedIn: true as const, myGames, openGames, upcoming, myClinics }
})

export const fetchGame = createServerFn({ method: 'GET' })
  .validator(z.object({ gameId: z.string() }))
  .handler(async ({ data }) => {
    const user = await getCurrentUser()
    const detail = await getGame(data.gameId)
    if (!detail) return null

    const isParticipant = detail.slots.some((s) => s.player?.id === user?.id)

    /**
     * Built here rather than in the component: `googleCalendarUrl` lives beside
     * the ICS writer, which reads config through `cloudflare:workers` and has
     * no business in the client bundle.
     *
     * Null until the game has a court. Before that there is no address and no
     * certainty it will happen, so there is nothing worth putting on a calendar.
     */
    const brief = detail.game.courtId ? await getGameBrief(data.gameId) : null
    const calendar =
      brief?.courtName && detail.game.status !== 'cancelled'
        ? {
            icsUrl: `/api/calendar/game/${data.gameId}.ics`,
            googleUrl: googleCalendarUrl(
              gameCalendarEvent(brief, `${getConfig().appUrl}/games/${data.gameId}`),
            ),
          }
        : null

    return {
      ...detail,
      calendar,
      viewer: user
        ? {
            id: user.id,
            ntrp: user.ntrp,
            playLevels: user.playLevels,
            division: user.division,
            formats: user.formats,
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

/**
 * Free courts across every location, so a host can offer more than one park.
 * The game holds none of them until it fills.
 */
export const fetchFreeCourtsEverywhere = createServerFn({ method: 'GET' })
  .validator(z.object({ startsAt: z.number(), endsAt: z.number() }))
  .handler(async ({ data }) => {
    await requireUser()
    return freeCourtsEverywhere(data.startsAt, data.endsAt)
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
      seekerDivisions: z.array(z.enum(SEAT_DIVISIONS)).optional(),
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
      seekerDivisions: data.seekerDivisions,
    })
    return { count }
  })

export const postGame = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      /** Acceptable courts, best first. The game holds none until it fills. */
      courtIds: z.array(z.string().min(1)).min(1).max(12),
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
      courtIds: data.courtIds,
      startsAt: data.startsAt,
      endsAt: data.endsAt,
      format: data.format,
      isMixed: data.isMixed ?? false,
      hostDivision: user.division,
      notes: data.notes ?? null,
      slots: data.slots,
    })

    // Awaited, but it no longer sends anything: it writes one notification row
    // per candidate and hands the whole set to the queue in a single call. The
    // host still gets a real count on the next screen, without waiting on a
    // round trip per recipient.
    const fanOut = await notifyCandidatesForGame(game.id)

    // Anyone looking at this location's day view sees the new booking appear.
    await announceGameChanged(game.id)

    return { gameId: game.id, invited: fanOut.invited, candidates: fanOut.candidates }
  })

export const claimGameSlot = createServerFn({ method: 'POST' })
  .validator(z.object({ gameId: z.string(), slotId: z.string().optional() }))
  .handler(async ({ data }) => {
    const user = await requireUser()
    const result = data.slotId
      ? await claimSlot(data.slotId, user)
      : await claimAnyOpenSlot(data.gameId, user)

    await notifyAfterClaim(data.gameId, user.id, result.slot.id)
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
    await notifyAfterClaim(resolved.gameId, user.id, result.slot.id)
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
    await announceGameChanged(data.gameId)
    return { ok: true as const }
  })

export const callOffGame = createServerFn({ method: 'POST' })
  .validator(z.object({ gameId: z.string(), reason: z.string().trim().max(200).optional() }))
  .handler(async ({ data }) => {
    const user = await requireUser()
    const participants = await gameParticipants(data.gameId)
    const brief = await getGameBrief(data.gameId)

    await cancelGame(data.gameId, user.id, user.isAdmin)
    await announceGameChanged(data.gameId)

    if (brief) {
      const reason = data.reason?.trim()
        ? `${user.name} cancelled: ${data.reason.trim()}`
        : `${user.name} cancelled this game.`
      const told = participants.filter((player) => player.id !== user.id)
      const { appUrl } = getConfig()
      await pushToInboxes(
        told.map((player) => player.id),
        () => cancelledEntry(brief, reason, `${appUrl}/games/${data.gameId}`),
      )
      await enqueueNotifications(
        told.map((player) => ({
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

    // Games that could still land here. They hold no court, so they're drawn
    // in outline on the one court they'd actually take — see projectPlacements.
    const pending = await pendingGamesAtLocation(data.locationId, data.fromMs, toMs)
    const projected = await projectPlacements(
      pending.map((row) => ({
        id: row.game.id,
        startsAt: row.game.startsAt,
        endsAt: row.game.endsAt,
        createdAt: row.game.createdAt,
      })),
    )

    const rosters = await gameRosters([
      ...scheduled.map((row) => row.game.id),
      ...pending.map((row) => row.game.id),
    ])

    const shape = (game: (typeof scheduled)[number]['game'], courtId: string, pendingGame: boolean) => {
      const roster = rosters.get(game.id)
      return {
        id: game.id,
        courtId,
        startsAt: game.startsAt,
        endsAt: game.endsAt,
        format: game.format,
        isMixed: game.isMixed,
        status: game.status,
        players: roster?.players ?? [],
        openSlots: roster?.openSlots ?? 0,
        pending: pendingGame,
      }
    }

    // Clinics hold their courts outright, so they need no projection — they
    // are simply on the court they booked.
    const clinicSessions = await clinicsAtLocation(data.locationId, data.fromMs, toMs)

    return {
      ...found,
      games: [
        ...scheduled.map((row) => shape(row.game, row.court.id, false)),
        // A pending game with no projection would be unplaceable right now, so
        // there's no honest column to draw it in.
        ...pending
          .filter((row) => projected.has(row.game.id))
          .map((row) => shape(row.game, projected.get(row.game.id)!, true)),
        ...clinicSessions.map((session) => ({
          // The clinic, not the occurrence: this is what the block links to.
          id: session.clinicId,
          kind: 'clinic' as const,
          courtId: session.courtId,
          title: session.title,
          startsAt: session.startsAt,
          endsAt: session.endsAt,
          // Present so the block shares one type with games; neither means
          // anything for a clinic.
          format: 'doubles' as const,
          isMixed: false,
          status: 'full' as const,
          players: [],
          openSlots: Math.max(0, session.capacity - session.taken),
          pending: false,
        })),
      ],
    }
  })
