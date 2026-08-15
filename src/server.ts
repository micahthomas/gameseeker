import { createStartHandler, defaultStreamHandler } from '@tanstack/react-start/server'
import { runCron } from './server/cron'
import { connectToInbox } from './server/live'
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
export { PlayerInbox } from './server/live'

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
async function handleLive(request: Request): Promise<Response> {
  const ticket = new URL(request.url).searchParams.get('ticket')
  const userId = await verifyLiveTicket(ticket)
  if (!userId) return new Response('Sign in first', { status: 401 })
  return connectToInbox(userId, request)
}

export default {
  async fetch(request: Request, _env: Env, _ctx: ExecutionContext) {
    // Checked before Start's handler, which otherwise claims every path.
    if (new URL(request.url).pathname === '/api/live/inbox') {
      return handleLive(request)
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
