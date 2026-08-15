import { and, eq, sql } from 'drizzle-orm'
import { db } from '~/db/client'
import { gameSlots, games, notifications, type Game, type GameFormat } from '~/db/schema'
import { availabilityCoverageSql, describeWindow } from './availability'
import { getConfig } from './config'
import { getGameBrief } from './games'
import { notifyUser, seekerAlertEmail, seekerAlertSms } from './notify'
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
  >,
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
  const formatColumn = game.format === 'singles' ? sql`u.plays_singles` : sql`u.plays_doubles`

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
      AND ${formatColumn} = 1
      ${game.isMixed ? sql`AND u.plays_mixed = 1` : sql``}
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
    ORDER BY ABS(u.ntrp - ${seekerLevels[0]}) ASC, u.created_at ASC
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
  delivered: number
  failed: number
}

/**
 * Notify everyone who could fill an open seat in this game.
 *
 * Each recipient gets a unique single-use claim token. Delivery failures are
 * recorded on the notification row rather than thrown — one bad address must
 * not stop the fan-out.
 */
export async function notifyCandidatesForGame(gameId: string): Promise<FanOutResult> {
  const rows = await db().select().from(games).where(eq(games.id, gameId)).limit(1)
  const game = rows[0]
  if (!game || game.status !== 'open') return { candidates: 0, delivered: 0, failed: 0 }

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
  if (openSeeker.length === 0) return { candidates: 0, delivered: 0, failed: 0 }

  const brief = await getGameBrief(gameId)
  if (!brief) return { candidates: 0, delivered: 0, failed: 0 }

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
  const candidates = await findCandidates(game, seekerLevels, seekerGenders)
  const { appUrl } = getConfig()
  const representative = openSeeker[0]!
  const seekerNtrp = representative.seekerNtrp ?? game.minNtrp

  let delivered = 0
  let failed = 0

  for (const candidate of candidates) {
    const claimToken = newToken()
    const claimUrl = `${appUrl}/claim/${claimToken}`

    // Insert first: the unique (user_id, game_id) index is what guarantees a
    // player is never alerted twice about the same game, even if two fan-outs
    // race (create + cron retry).
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

    const result = await notifyUser(
      candidate,
      seekerAlertEmail(brief, seekerNtrp, claimUrl),
      seekerAlertSms(brief, seekerNtrp, claimUrl),
    )

    if (result.channels.length > 0) {
      delivered += 1
    } else {
      failed += 1
      await db()
        .update(notifications)
        .set({ status: 'failed', error: result.errors.map((e) => e.message).join('; ') })
        .where(eq(notifications.claimToken, claimToken))
    }
  }

  return { candidates: candidates.length, delivered, failed }
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
