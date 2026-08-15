import { useEffect, useRef, useState } from 'react'
import { useRouter } from '@tanstack/react-router'
import { fetchInbox, liveTicket, markRead } from '~/fn/inbox'
import type { InboxEntry } from '~/server/live'

/**
 * The notification bell.
 *
 * The socket carries events, not state: it says "something changed" and this
 * refetches through the same server function the first render used. Sending
 * diffs down the socket would be a second source of truth that could drift
 * from the first; refetching is a few lines and cannot.
 *
 * Reconnection backs off exponentially with jitter, so a Worker restart
 * doesn't produce a thundering herd of reconnects from every open tab.
 */

const MAX_BACKOFF_MS = 30_000

export function InboxBell() {
  const router = useRouter()
  const [entries, setEntries] = useState<InboxEntry[]>([])
  const [unread, setUnread] = useState(0)
  const [open, setOpen] = useState(false)

  const socketRef = useRef<WebSocket | null>(null)
  const attemptRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  async function refresh() {
    try {
      const result = await fetchInbox()
      setEntries(result.entries)
      setUnread(result.unread)
    } catch {
      // A failed refresh leaves the last known state on screen, which is
      // better than blanking the bell because one fetch lost a race.
    }
  }

  useEffect(() => {
    let closed = false

    async function connect() {
      if (closed) return

      // The socket endpoint runs outside Start's request context and can't
      // read the session cookie, so authenticate with a short-lived signed
      // ticket. A fresh one per connection, including per reconnect.
      let ticket: string | null = null
      try {
        ticket = (await liveTicket()).ticket
      } catch {
        return scheduleReconnect()
      }
      if (closed) return
      if (!ticket) return // Signed out; nothing to listen to.

      const url = new URL('/api/live/inbox', window.location.href)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      url.searchParams.set('ticket', ticket)

      let socket: WebSocket
      try {
        socket = new WebSocket(url)
      } catch {
        return scheduleReconnect()
      }
      socketRef.current = socket

      socket.onopen = () => {
        attemptRef.current = 0
        // Catch up on anything missed while this tab was closed or asleep.
        void refresh()
      }
      socket.onmessage = (event) => {
        try {
          const parsed = JSON.parse(String(event.data)) as { type?: string; unread?: number }
          if (typeof parsed.unread === 'number') setUnread(parsed.unread)
          if (parsed.type === 'inbox.new') {
            void refresh()
            // Anything on screen may now be stale — a game just changed.
            void router.invalidate()
          }
        } catch {
          // An unparseable frame is not worth tearing the connection down for.
        }
      }
      socket.onclose = () => {
        socketRef.current = null
        scheduleReconnect()
      }
      socket.onerror = () => socket.close()
    }

    function scheduleReconnect() {
      if (closed) return
      const attempt = Math.min(attemptRef.current++, 5)
      const base = Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS)
      // Jitter, so every tab in every browser doesn't reconnect in lockstep
      // after a Worker restart.
      timerRef.current = setTimeout(() => void connect(), base * (0.5 + Math.random() * 0.5))
    }

    void refresh()
    void connect()

    return () => {
      closed = true
      if (timerRef.current) clearTimeout(timerRef.current)
      socketRef.current?.close()
      socketRef.current = null
    }
    // Mounted once, in the root layout; the router reference is stable.
  }, [])

  async function toggle() {
    const next = !open
    setOpen(next)
    if (next && unread > 0) {
      setUnread(0)
      try {
        await markRead({ data: {} })
        await refresh()
      } catch {
        void refresh()
      }
    }
  }

  return (
    <div className="relative" data-testid="inbox">
      <button
        type="button"
        onClick={toggle}
        className="relative rounded-lg px-2 py-1.5 text-lg leading-none hover:bg-sand-100"
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
        aria-expanded={open}
      >
        <span aria-hidden="true">🔔</span>
        {unread > 0 ? (
          <span
            data-testid="inbox-unread"
            className="absolute -right-0.5 -top-0.5 min-w-[1.15rem] rounded-full bg-clay-600 px-1 text-xs font-bold leading-[1.15rem] text-white"
          >
            {unread > 9 ? '9+' : unread}
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="absolute right-0 z-30 mt-1 w-80 max-w-[85vw] overflow-hidden rounded-xl border border-sand-200 bg-white shadow-lg">
          {entries.length === 0 ? (
            <p className="hint p-4">Nothing yet. Games you're invited to will show up here.</p>
          ) : (
            <ul className="max-h-96 divide-y divide-sand-200 overflow-y-auto">
              {entries.map((entry) => (
                <li key={entry.id}>
                  <a
                    href={entry.url ?? '#'}
                    onClick={() => setOpen(false)}
                    className="block px-4 py-3 hover:bg-sand-100"
                  >
                    <span className="block font-semibold">{entry.title}</span>
                    {entry.body ? (
                      <span className="hint mt-0.5 block">{entry.body}</span>
                    ) : null}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  )
}
