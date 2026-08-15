import { createStartHandler, defaultStreamHandler } from '@tanstack/react-start/server'
import { runCron } from './server/cron'
import { connectToInbox, connectToLocation } from './server/live'
import { verifyLiveTicket } from './server/live/ticket'
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

export default {
  async fetch(request: Request, _env: Env, _ctx: ExecutionContext) {
    // Checked before Start's handler, which otherwise claims every path.
    const url = new URL(request.url)
    if (url.pathname.startsWith('/api/live/')) {
      return handleLive(request, url)
    }
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
