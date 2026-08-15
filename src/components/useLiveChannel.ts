import { useEffect, useRef } from 'react'
import { liveTicket } from '~/fn/inbox'

/**
 * One socket to a live channel, with reconnection.
 *
 * Shared by the notification bell and the location day view rather than
 * copied into each — the ticket handshake, the backoff and the teardown are
 * the fiddly parts, and a second copy would drift.
 *
 * The channel only ever tells a client *what changed*; callers react by
 * refetching through the loaders they already have. Nothing is sent upward:
 * outgoing frames are free and incoming ones bill at 20:1, and the server
 * wouldn't trust a client's word anyway.
 */

const MAX_BACKOFF_MS = 30_000

export type LiveOptions = {
  /** Path plus any query beyond the ticket, e.g. "/api/live/location?id=x". */
  path: string
  /** Called for every frame the server sends. */
  onEvent: (event: { type?: string; [key: string]: unknown }) => void
  /** Called once each time a connection is established, for catch-up. */
  onOpen?: () => void
  /** Skip connecting entirely — signed out, or nothing to watch yet. */
  enabled?: boolean
}

export function useLiveChannel({ path, onEvent, onOpen, enabled = true }: LiveOptions): void {
  // Refs so a changing callback identity never tears the socket down and
  // reconnects it on every render.
  const onEventRef = useRef(onEvent)
  const onOpenRef = useRef(onOpen)
  onEventRef.current = onEvent
  onOpenRef.current = onOpen

  useEffect(() => {
    if (!enabled) return
    let closed = false
    let socket: WebSocket | null = null
    let attempt = 0
    let timer: ReturnType<typeof setTimeout> | null = null

    function scheduleReconnect() {
      if (closed) return
      const step = Math.min(attempt++, 5)
      const base = Math.min(1000 * 2 ** step, MAX_BACKOFF_MS)
      // Jitter, so every open tab doesn't reconnect in lockstep after a
      // Worker restart.
      timer = setTimeout(() => void connect(), base * (0.5 + Math.random() * 0.5))
    }

    async function connect() {
      if (closed) return

      // The live endpoints run before TanStack Start's handler and so have no
      // request context to read the session cookie from. A short-lived signed
      // ticket from an authenticated server function stands in for it.
      let ticket: string | null = null
      try {
        ticket = (await liveTicket()).ticket
      } catch {
        return scheduleReconnect()
      }
      if (closed) return
      if (!ticket) return // Signed out; nothing to listen to.

      const url = new URL(path, window.location.href)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      url.searchParams.set('ticket', ticket)

      try {
        socket = new WebSocket(url)
      } catch {
        return scheduleReconnect()
      }

      socket.onopen = () => {
        attempt = 0
        onOpenRef.current?.()
      }
      socket.onmessage = (event) => {
        try {
          onEventRef.current(JSON.parse(String(event.data)))
        } catch {
          // An unparseable frame isn't worth tearing the connection down for.
        }
      }
      socket.onclose = () => {
        socket = null
        scheduleReconnect()
      }
      socket.onerror = () => socket?.close()
    }

    void connect()

    return () => {
      closed = true
      if (timer) clearTimeout(timer)
      socket?.close()
      socket = null
    }
  }, [path, enabled])
}
