import { useEffect, useState } from 'react'
import { useRouter } from '@tanstack/react-router'
import { fetchInbox, markRead } from '~/fn/inbox'
import type { InboxEntry } from '~/server/live'
import { useLiveChannel } from './useLiveChannel'

/**
 * The notification bell.
 *
 * The socket carries events, not state: it says "something changed" and this
 * refetches through the same server function the first render used. Sending
 * diffs down the socket would be a second source of truth that could drift
 * from the first; refetching is a few lines and cannot.
 *
 * The connection itself lives in useLiveChannel, shared with the location day
 * view.
 */

export function InboxBell() {
  const router = useRouter()
  const [entries, setEntries] = useState<InboxEntry[]>([])
  const [unread, setUnread] = useState(0)
  const [open, setOpen] = useState(false)

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

  // One socket, shared implementation with the location day view. The hub
  // says what changed; this refetches through the same server function the
  // first render used, so the badge cannot drift from the stored inbox.
  useLiveChannel({
    path: '/api/live/inbox',
    onOpen: () => void refresh(),
    onEvent: (event) => {
      if (typeof event.unread === 'number') setUnread(event.unread)
      if (event.type === 'inbox.new') {
        void refresh()
        // Something about a game just changed; whatever is on screen may be stale.
        void router.invalidate()
      }
    },
  })

  useEffect(() => {
    void refresh()
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
