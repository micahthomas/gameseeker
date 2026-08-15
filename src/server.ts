import { createStartHandler, defaultStreamHandler } from '@tanstack/react-start/server'
import { runCron } from './server/cron'

/**
 * Worker entry point.
 *
 * This replaces the stock "@tanstack/react-start/server-entry" so the same
 * Worker can serve the app *and* handle cron triggers. The fetch handler is
 * built exactly as the default entry builds it; `scheduled` is the addition.
 */
const fetch = createStartHandler(defaultStreamHandler)

export default {
  fetch,

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
