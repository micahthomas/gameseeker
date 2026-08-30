import { createStartHandler, defaultStreamHandler } from '@tanstack/react-start/server'
import { runCron } from './server/cron'
import { getGameBrief } from './server/games'
import { connectToInbox, connectToLocation } from './server/live'
import { verifyLiveTicket } from './server/live/ticket'
import { isMediaKey, readMedia, storeUpload, verifyUploadTicket } from './server/media'
import { buildIcs } from './server/notify/calendar'
import { gameCalendarEvent } from './server/notify/templates'
import { getConfig } from './server/config'
import { handleNotifyBatch, type NotifyMessage } from './server/notify/queue'

/**
 * Worker entry point.
 *
 * This replaces the stock "@tanstack/react-start/server-entry" so the same
 * Worker can serve the app, handle cron triggers, consume the outbound
 * notification queue, and terminate realtime WebSockets. The fetch handler is
 * built exactly as the default entry builds it; the rest are additions.
 */
const startFetch = createStartHandler(defaultStreamHandler)

// The Durable Object class has to be exported from the Worker entry for
// wrangler to find it. See the "migrations" entry in wrangler.jsonc.
export { PlayerInbox, LocationHub } from './server/live'

/**
 * Realtime endpoint.
 *
 * This runs *before* Start's handler, which otherwise claims every path and
 * would not pass a 101 response through. That also puts it outside Start's
 * request context, so the session cookie can't be read here — the client
 * presents a short-lived signed ticket instead. See ./server/live/ticket.ts.
 *
 * The player id comes out of the ticket's signature, so a client still never
 * names its own id.
 */
async function handleLive(request: Request, url: URL): Promise<Response> {
  const userId = await verifyLiveTicket(url.searchParams.get('ticket'))
  if (!userId) return new Response('Sign in first', { status: 401 })

  if (url.pathname === '/api/live/inbox') return connectToInbox(userId, request)

  // The location day view is public, but subscribing to it still requires a
  // signed-in ticket: it adds no unauthenticated socket surface, and a signed
  // out visitor simply gets the static page they get today. The ticket proves
  // "a player", not "a player entitled to this location" — the calendar is
  // already visible to anyone with the link.
  const locationId = url.searchParams.get('locationId')
  if (!locationId) return new Response('Missing locationId', { status: 400 })
  return connectToLocation(locationId, request)
}

/**
 * Download the calendar entry for a game.
 *
 * Handled here rather than as a Start route for the same reason `/api/live/*`
 * is: this needs to answer with `text/calendar`, not an HTML document.
 *
 * Unauthenticated, which matches the game page — that is already readable by
 * anyone with the link. This copy carries **no ATTENDEE line**, so unlike the
 * one attached to an email it names nobody at all.
 */
async function handleGameCalendar(gameId: string): Promise<Response> {
  const brief = await getGameBrief(gameId)
  // A game that hasn't filled holds no court, so there is nothing to put in a
  // calendar yet — it has no address and might never happen.
  if (!brief?.courtName) return new Response('Not found', { status: 404 })

  const { appUrl } = getConfig()
  const body = buildIcs(gameCalendarEvent(brief, `${appUrl}/games/${gameId}`))

  return new Response(body, {
    headers: {
      'content-type': 'text/calendar; charset=utf-8',
      'content-disposition': `attachment; filename="tennis-${gameId}.ics"`,
      // Short: a game can be cancelled, and a stale invite is worse than a
      // second round trip.
      'cache-control': 'public, max-age=60',
    },
  })
}

/**
 * Uploading and serving clinic hero images.
 *
 * Both halves live here rather than as Start routes because one takes a raw
 * request body and the other answers with image bytes — neither is an HTML
 * document, which is all Start's handler knows how to produce.
 *
 * The upload is authenticated by a signed ticket for the same reason the live
 * socket is: this code runs before Start, so there is no session to read. See
 * ./server/media.ts.
 */
async function handleMedia(request: Request, url: URL): Promise<Response> {
  if (url.pathname === '/api/media/upload') {
    if (request.method !== 'PUT') return new Response('Method not allowed', { status: 405 })
    const userId = await verifyUploadTicket(url.searchParams.get('ticket'))
    if (!userId) return new Response('Sign in first', { status: 401 })

    const result = await storeUpload(request.body)
    return Response.json(result, { status: result.ok ? 200 : 400 })
  }

  const key = url.pathname.slice('/api/media/'.length)
  if (!isMediaKey(key)) return new Response('Not found', { status: 404 })

  const object = await readMedia(key)
  if (!object) return new Response('Not found', { status: 404 })

  return new Response(object.body, {
    headers: {
      'content-type': object.httpMetadata?.contentType ?? 'application/octet-stream',
      // The key *is* the content hash, so it can never come to mean something
      // else and never needs invalidating.
      'cache-control': 'public, max-age=31536000, immutable',
      etag: object.httpEtag,
    },
  })
}

export default {
  async fetch(request: Request, _env: Env, _ctx: ExecutionContext) {
    // Checked before Start's handler, which otherwise claims every path.
    const url = new URL(request.url)
    if (url.pathname.startsWith('/api/live/')) {
      return handleLive(request, url)
    }

    const calendar = url.pathname.match(/^\/api\/calendar\/game\/([^/]+)\.ics$/)
    if (calendar) return handleGameCalendar(calendar[1]!)

    if (url.pathname.startsWith('/api/media/')) return handleMedia(request, url)
    // Start takes only the request; it reaches bindings through
    // `cloudflare:workers` the same way src/server/config.ts does.
    return startFetch(request)
  },

  async queue(batch: MessageBatch<NotifyMessage>, _env: Env, _ctx: ExecutionContext) {
    await handleNotifyBatch(batch)
  },

  async scheduled(controller: ScheduledController, _env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      runCron(controller.cron)
        .then((report) => {
          console.log(`cron ${controller.cron} ->`, JSON.stringify(report))
        })
        .catch((error) => {
          console.error(`cron ${controller.cron} failed:`, error)
        }),
    )
  },
}
