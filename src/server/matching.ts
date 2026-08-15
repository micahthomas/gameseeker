import { and, eq, sql } from 'drizzle-orm'
import { db } from '~/db/client'
import { courts, gameSlots, games, notifications, type Game, type GameFormat } from '~/db/schema'
import { availabilityCoverageSql, describeWindow } from './availability'
import { playerFormat } from './formats'
import { candidateLocationRankSql } from './preferences'
import { getGameBrief } from './games'
import { enqueueNotifications, type NotifyMessage } from './notify/queue'
import { newId, newToken } from './tokens'

/**
 * Deciding who hears about a new game.
 *
 * A player is a candidate when all of these hold:
 *   - one of the levels they opted into matches a level an open seat wants
 *   - they play this format (singles/doubles), and mixed if the game is mixed
 *   - their gender matches, when a seat is held to keep a mixed game balanced
 *   - they have at least one notification channel switched on
 *   - their posted availability covers the whole game window
 *   - they aren't already in this game, and aren't booked in another one
 *
 * Availability is the reason this is worth automating at all — it's what turns
 * "post a game and hope" into "the right four people get a text".
 */

export type Candidate = {
  id: string
  email: string
  name: string
  phone: string | null
  ntrp: number
  notifyEmail: boolean
  notifySms: boolean
}

type CandidateRow = Omit<Candidate, 'notifyEmail' | 'notifySms'> & {
  notifyEmail: number
  notifySms: number
}

export async function findCandidates(
  game: Pick<
    Game,
    'id' | 'hostId' | 'startsAt' | 'endsAt' | 'format' | 'minNtrp' | 'maxNtrp' | 'isMixed'
  > & {
    /**
     * Where the game is. Used only to order the result — players who listed
     * this location are messaged first. Omitted means "no preference signal",
     * not "nobody prefers it".
     */
    locationId?: string | null
  },
  /**
   * The levels the game's open seats are asking for. Matching is an
   * intersection against each player's opted-in levels, so a 4.0 seat only
   * reaches players who said they'd play 4.0 — never a 3.5 who didn't.
   */
  seekerLevels: number[],
  /** Genders the open seats are holding, if any. Empty means anyone. */
  seekerGenders: Array<'woman' | 'man'> = [],
  limit = 200,
): Promise<Candidate[]> {
  if (seekerLevels.length === 0) return []

  const window = describeWindow(game.startsAt, game.endsAt)
  const coverage = availabilityCoverageSql(window, game.format as GameFormat)
  // One membership test where there used to be a column check plus a separate
  // mixed clause. (format, is_mixed) names exactly one player-format, and a
  // player hears about the game only if it's in their set.
  const wanted = playerFormat(game.format as GameFormat, game.isMixed)

  const rows = await db().all<CandidateRow>(sql`
    SELECT
      u.id           AS id,
      u.email        AS email,
      u.name         AS name,
      u.phone        AS phone,
      u.ntrp         AS ntrp,
      u.notify_email AS notifyEmail,
      u.notify_sms   AS notifySms
    FROM users u
    WHERE u.id <> ${game.hostId}
      AND EXISTS (
        SELECT 1 FROM json_each(u.play_levels) lvl
        WHERE lvl.value IN ${seekerLevels}
      )
      AND EXISTS (
        SELECT 1 FROM json_each(u.formats) fmt
        WHERE fmt.value = ${wanted}
      )
      ${
        seekerGenders.length > 0
          ? sql`AND u.gender IN ${seekerGenders}`
          : sql``
      }
      AND (u.notify_email = 1 OR u.notify_sms = 1)
      AND NOT EXISTS (
        SELECT 1 FROM game_slots gs
        WHERE gs.game_id = ${game.id} AND gs.filled_by_user_id = u.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM notifications n
        WHERE n.user_id = u.id AND n.game_id = ${game.id}
      )
      AND NOT EXISTS (
        SELECT 1 FROM game_slots gs2
        JOIN games g2 ON g2.id = gs2.game_id
        WHERE gs2.filled_by_user_id = u.id
          AND g2.status IN ('open', 'full')
          AND g2.starts_at < ${game.endsAt}
          AND g2.ends_at > ${game.startsAt}
      )
      AND ${coverage}
    -- Location preference first, but as a sort and never a filter: an
    -- unranked player still gets the invitation, just behind the players who
    -- said they play there. See src/server/preferences.ts.
    ORDER BY ${candidateLocationRankSql(game.locationId)} ASC,
             ABS(u.ntrp - ${seekerLevels[0]}) ASC,
             u.created_at ASC
    LIMIT ${limit}
  `)

  return rows.map((row) => ({
    ...row,
    notifyEmail: Boolean(row.notifyEmail),
    notifySms: Boolean(row.notifySms),
  }))
}

export type FanOutResult = {
  candidates: number
  /**
   * How many players were invited — that is, had a notification row written
   * and a message enqueued. Deliberately *not* "delivered": delivery now
   * happens in the queue consumer, after this function has returned, and
   * claiming otherwise would overstate what the host actually knows.
   */
  invited: number
}

/**
 * Invite everyone who could fill an open seat in this game.
 *
 * Each recipient gets a unique single-use claim token, written to the
 * `notifications` table here in the request path. The unique index on
 * `(user_id, game_id)` is what stops a player being alerted twice about the
 * same game, whether from two racing fan-outs or from an at-least-once queue
 * redelivery — and it only does that if the row exists before the message
 * does. Keep this ordering.
 *
 * Sending is the consumer's job; see `./notify/queue.ts`.
 */
export async function notifyCandidatesForGame(gameId: string): Promise<FanOutResult> {
  const rows = await db().select().from(games).where(eq(games.id, gameId)).limit(1)
  const game = rows[0]
  if (!game || game.status !== 'open') return { candidates: 0, invited: 0 }

  const openSeeker = await db()
    .select()
    .from(gameSlots)
    .where(
      and(
        eq(gameSlots.gameId, gameId),
        eq(gameSlots.status, 'open'),
        eq(gameSlots.kind, 'seeker'),
      ),
    )
  if (openSeeker.length === 0) return { candidates: 0, invited: 0 }

  // Not used for rendering any more — the consumer re-reads it at send time —
  // but a game whose court or host has gone can't produce a sensible message,
  // so there's no point inviting anyone to it.
  if (!(await getGameBrief(gameId))) return { candidates: 0, invited: 0 }

  const seekerLevels = [
    ...new Set(openSeeker.map((slot) => slot.seekerNtrp).filter((n): n is number => n !== null)),
  ]
  const seekerGenders = [
    ...new Set(
      openSeeker
        .map((slot) => slot.seekerGender)
        .filter((g): g is 'woman' | 'man' => g === 'woman' || g === 'man'),
    ),
  ]
  // The game knows its court; the ordering wants its location.
  const locationRows = await db()
    .select({ locationId: courts.locationId })
    .from(courts)
    .where(eq(courts.id, game.courtId))
    .limit(1)

  const candidates = await findCandidates(
    { ...game, locationId: locationRows[0]?.locationId ?? null },
    seekerLevels,
    seekerGenders,
  )
  const representative = openSeeker[0]!
  const seekerNtrp = representative.seekerNtrp ?? game.minNtrp

  const messages: NotifyMessage[] = []

  for (const candidate of candidates) {
    const claimToken = newToken()

    try {
      await db().insert(notifications).values({
        id: newId(),
        userId: candidate.id,
        gameId,
        slotId: representative.id,
        seekerNtrp,
        channel: candidate.notifyEmail ? 'email' : 'sms',
        claimToken,
        sentAt: Date.now(),
        status: 'sent',
      })
    } catch {
      continue // already notified
    }

    messages.push({ kind: 'seeker-alert', gameId, userId: candidate.id })
  }

  await enqueueNotifications(messages)

  return { candidates: candidates.length, invited: messages.length }
}

/**
 * How many players would be reached if this game were posted right now. Shown
 * in the create-game form so a host knows before committing whether anyone is
 * actually free — an empty result is a prompt to widen the level or move the time.
 */
export async function previewReach(input: {
  hostId: string
  startsAt: number
  endsAt: number
  format: GameFormat
  seekerLevels: number[]
  isMixed?: boolean
  seekerGenders?: Array<'woman' | 'man'>
  /** Only affects ordering, so the count is the same with or without it. */
  locationId?: string | null
}): Promise<number> {
  const [minNtrp, maxNtrp] = [
    Math.min(...input.seekerLevels),
    Math.max(...input.seekerLevels),
  ]
  const candidates = await findCandidates(
    {
      ...input,
      id: '00000000-0000-0000-0000-000000000000',
      minNtrp,
      maxNtrp,
      isMixed: input.isMixed ?? false,
    },
    input.seekerLevels,
    input.seekerGenders ?? [],
    500,
  )
  return candidates.length
}
