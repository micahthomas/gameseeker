import { createStartHandler, defaultStreamHandler } from '@tanstack/react-start/server'
import { runCron } from './server/cron'
import { handleNotifyBatch, type NotifyMessage } from './server/notify/queue'

/**
 * Worker entry point.
 *
 * This replaces the stock "@tanstack/react-start/server-entry" so the same
 * Worker can serve the app, handle cron triggers, *and* consume the outbound
 * notification queue. The fetch handler is built exactly as the default entry
 * builds it; `scheduled` and `queue` are the additions.
 */
const fetch = createStartHandler(defaultStreamHandler)

export default {
  fetch,

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
