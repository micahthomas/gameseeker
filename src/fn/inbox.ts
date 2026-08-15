import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { getCurrentUser } from '~/server/auth'
import { markInboxRead, readInbox } from '~/server/live'
import { issueLiveTicket } from '~/server/live/ticket'

/**
 * The bell's data.
 *
 * Reads go through an authenticated server function rather than over the
 * WebSocket. The socket only ever says *what changed*; the client refetches
 * through here. That keeps one authenticated path to the data instead of two,
 * and means a client can never ask for someone else's inbox — the id comes
 * from the session, never from the request.
 */

export const fetchInbox = createServerFn({ method: 'GET' }).handler(async () => {
  const user = await getCurrentUser()
  if (!user) return { entries: [], unread: 0 }
  return readInbox(user.id)
})

export const markRead = createServerFn({ method: 'POST' })
  .validator(z.object({ ids: z.array(z.number()).optional() }))
  .handler(async ({ data }) => {
    const user = await getCurrentUser()
    if (!user) return { unread: 0 }
    return markInboxRead(user.id, data.ids)
  })

/**
 * A short-lived ticket for the WebSocket upgrade.
 *
 * Authenticated exactly like every other server function; the socket endpoint
 * itself runs outside Start's request context and so cannot read the session
 * cookie. See src/server/live/ticket.ts for why that is.
 */
export const liveTicket = createServerFn({ method: 'GET' }).handler(async () => {
  const user = await getCurrentUser()
  if (!user) return { ticket: null }
  return { ticket: await issueLiveTicket(user.id) }
})
