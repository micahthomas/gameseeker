import { Link, createFileRoute, notFound, useRouter } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { CourtDayGrid, type CourtSelection } from '~/components/CourtDayGrid'
import { useLiveChannel } from '~/components/useLiveChannel'
import { NotFound } from '~/components/NotFound'
import { fetchDemand, fetchLocationCalendar } from '~/fn/games'
import {
  SLOT_MS,
  addLocalDays,
  formatDate,
  formatMinuteOfDay,
  startOfLocalDay,
  toDateInput,
} from '~/server/time'

/** The grid shows 6am-10pm, so the heatmap has to line up with that window. */
const GRID_FIRST_MINUTE = 6 * 60
const GRID_SLOTS = 32

/**
 * How often the demand heatmap refetches while the tab is visible.
 *
 * A minute is well inside "advisory" for a number that answers "roughly how
 * many people are free then", and cheap: one small query per open tab.
 */
const DEMAND_REFRESH_MS = 60_000

export const Route = createFileRoute('/locations/$locationId')({
  // A shared booking calendar must never be served from cache: someone else
  // may have taken a court since this route was last visited or preloaded,
  // and arriving here straight after posting a game must show that game.
  staleTime: 0,
  preloadStaleTime: 0,
  shouldReload: true,
  loader: async ({ params }) => {
    const data = await fetchLocationCalendar({
      data: {
        locationId: params.locationId,
        // A week's worth so paging a day either way needs no round trip.
        fromMs: startOfLocalDay(addLocalDays(Date.now(), -1)),
        days: 9,
      },
    })
    if (!data) throw notFound()
    return data
  },
  notFoundComponent: () => <NotFound />,
  component: LocationDetail,
})

function LocationDetail() {
  const { location, courts, games } = Route.useLoaderData()
  const router = useRouter()

  /**
   * Live calendar. The hub only says *what* changed; this refetches through
   * the loader that already exists rather than patching state from the event,
   * so what's on screen can never drift from the database.
   *
   * Signed-out visitors get the static page, exactly as before — the socket
   * needs a ticket, and issuing one requires a session.
   */
  useLiveChannel({
    path: `/api/live/location?locationId=${encodeURIComponent(location.id)}`,
    onEvent: (event) => {
      if (event.type === 'game.changed') void router.invalidate()
    },
  })

  // Opens on today, which is the question people actually arrive with.
  const [dayStart, setDayStart] = useState(() => startOfLocalDay(Date.now()))
  const [loading, setLoading] = useState(false)
  const [selection, setSelection] = useState<CourtSelection | null>(null)
  const [showDemand, setShowDemand] = useState(true)
  const [allLevels, setAllLevels] = useState(false)
  const [demand, setDemand] = useState<number[] | null>(null)
  // So a failed refresh can tell "never loaded" from "had data a moment ago".
  const demandRef = useRef<number[] | null>(null)
  demandRef.current = demand

  /**
   * How many players are free in each half hour of the day on screen.
   *
   * Refreshed on a timer rather than pushed from a Durable Object. Availability
   * changes are infrequent and the heatmap is advisory — nobody is harmed by it
   * being a minute stale — so a periodic refetch buys almost all of the value
   * of a `demand.changed` broadcast for none of the machinery it would need
   * (fan-out to every location's hub, plus alarm-based coalescing so one player
   * editing a week doesn't fire twenty events).
   *
   * Only while the tab is actually being looked at: a background tab polling
   * every minute is pure waste, and the visibility listener catches up the
   * moment someone returns to it.
   */
  useEffect(() => {
    if (!showDemand) {
      setDemand(null)
      return
    }
    let cancelled = false

    const load = () =>
      fetchDemand({ data: { dayStart, allLevels } })
        .then((result) => {
          if (cancelled) return
          // The response covers midnight to midnight; the grid starts at 6am.
          const byStart = new Map(result.slots.map((s) => [s.slotStart, s.count]))
          setDemand(
            Array.from({ length: GRID_SLOTS }, (_, i) => {
              const at = dayStart + (GRID_FIRST_MINUTE / 30) * SLOT_MS + i * SLOT_MS
              return byStart.get(at) ?? 0
            }),
          )
        })
        .catch(() => {
          // Leave the last good heatmap on screen rather than blanking it
          // because one poll lost a race.
          if (!cancelled && demandRef.current === null) setDemand(null)
        })

    void load()

    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load()
    }, DEMAND_REFRESH_MS)

    const onVisible = () => {
      if (document.visibilityState === 'visible') void load()
    }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      cancelled = true
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [dayStart, showDemand, allLevels])

  const dayEnd = startOfLocalDay(addLocalDays(dayStart, 1))
  const todayStart = startOfLocalDay(Date.now())

  const dayGames = games.filter((g) => g.startsAt < dayEnd && g.endsAt > dayStart)

  /**
   * The loader holds a nine-day window. Stepping outside it refetches, so you
   * can browse further ahead without the page going blank in the common case.
   */
  async function goToDay(next: number) {
    setSelection(null)
    setDayStart(next)
    const loaded = games.length > 0
    const outsideWindow =
      next < startOfLocalDay(addLocalDays(Date.now(), -1)) ||
      next > startOfLocalDay(addLocalDays(Date.now(), 7))
    if (!loaded && !outsideWindow) return
    if (outsideWindow) {
      setLoading(true)
      await router.invalidate()
      setLoading(false)
    }
  }

  return (
    <div className="space-y-5">
      <header>
        <Link to="/locations" className="hint hover:underline">
          ← All courts
        </Link>
        <h1 className="mt-2 text-2xl font-bold">{location.name}</h1>
        {location.address ? <p className="hint">{location.address}</p> : null}
        {location.notes ? <p className="hint mt-2">{location.notes}</p> : null}
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <button
          className="btn-secondary !px-3 !py-1.5 !text-sm"
          aria-label="Previous day"
          onClick={() => goToDay(startOfLocalDay(addLocalDays(dayStart, -1)))}
        >
          ←
        </button>
        <button
          className="btn-secondary !px-3 !py-1.5 !text-sm"
          onClick={() => goToDay(todayStart)}
        >
          Today
        </button>
        <button
          className="btn-secondary !px-3 !py-1.5 !text-sm"
          aria-label="Next day"
          onClick={() => goToDay(startOfLocalDay(addLocalDays(dayStart, 1)))}
        >
          →
        </button>
        <input
          type="date"
          aria-label="Jump to a date"
          className="input !w-auto !py-1.5 !text-sm"
          value={toDateInput(dayStart)}
          onChange={(e) => {
            const [y, m, d] = e.target.value.split('-').map(Number)
            if (y && m && d) goToDay(startOfLocalDay(new Date(y, m - 1, d, 12).getTime()))
          }}
        />
        <p className="ml-auto text-sm font-semibold" data-testid="day-label">
          {dayStart === todayStart ? 'Today · ' : ''}
          {formatDate(dayStart)}
        </p>
      </div>

      <CourtDayGrid
        dayStart={dayStart}
        courts={courts}
        games={dayGames}
        selection={selection}
        demand={demand}
        onSelect={setSelection}
        popover={
          selection ? (
            <HostHerePopover
              locationId={location.id}
              dayStart={dayStart}
              selection={selection}
              onCancel={() => setSelection(null)}
            />
          ) : null
        }
      />

      <div className="flex flex-wrap items-center gap-3 text-xs text-ink-soft">
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            className="size-4 accent-pinon-600"
            checked={showDemand}
            onChange={(e) => setShowDemand(e.target.checked)}
          />
          Show who's free
        </label>
        {showDemand ? (
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              className="size-4 accent-pinon-600"
              checked={allLevels}
              onChange={(e) => setAllLevels(e.target.checked)}
            />
            All levels
          </label>
        ) : null}
      </div>

      {showDemand ? (
        <p className="hint" data-testid="demand-summary">
          {demand && demand.some((n) => n > 0)
            ? `Darker bands are busier times — up to ${Math.max(...demand)} player${
                Math.max(...demand) === 1 ? '' : 's'
              } free${allLevels ? '' : ' at your levels'}. Host there and more people get the alert.`
            : `Nobody has posted availability for this day${allLevels ? '' : ' at your levels'} yet.`}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-4 text-xs text-ink-soft">
        <span className="flex items-center gap-1.5">
          <span className="size-3 rounded-sm bg-pinon-600" /> Full game
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-3 rounded-sm border border-dashed border-clay-500 bg-clay-100" />{' '}
          Spots open — tap to join
        </span>
        {loading ? <span>Loading…</span> : null}
      </div>

      {dayGames.length === 0 ? (
        <p className="hint">
          Nothing booked here {dayStart === todayStart ? 'today' : 'that day'}. Every court is free.
        </p>
      ) : null}

      <Link to="/games/new" search={{ locationId: location.id }} className="btn-primary w-full">
        Host a game here
      </Link>

      <p className="hint">Tip: drag on a court above to host at that exact time.</p>

      <p className="hint">
        {courts.length} court{courts.length === 1 ? '' : 's'}. These are agreements between players,
        not reservations with the city — public park courts are first come, first served.
      </p>
    </div>
  )
}

/**
 * The card that appears after dragging out a slot on a court. It doesn't
 * create anything itself — it hands the choice to the normal create form with
 * the location, court, date, and time already filled in, so the host still
 * sees the level and format questions before anything is booked.
 */
function HostHerePopover({
  locationId,
  dayStart,
  selection,
  onCancel,
}: {
  locationId: string
  dayStart: number
  selection: CourtSelection
  onCancel: () => void
}) {
  const duration = selection.endMinute - selection.startMinute

  return (
    <div
      className="card space-y-2 p-3 shadow-lg shadow-ink/10"
      role="dialog"
      aria-label="Host a game here"
    >
      <div>
        <p className="text-sm font-bold">
          {formatMinuteOfDay(selection.startMinute)} – {formatMinuteOfDay(selection.endMinute)}
        </p>
        <p className="text-xs text-ink-soft">
          {selection.court.name} · {formatDate(dayStart)}
        </p>
      </div>
      <Link
        to="/games/new"
        search={{
          locationId,
          courtId: selection.court.id,
          date: toDateInput(dayStart),
          startMinute: selection.startMinute,
          duration,
        }}
        className="btn-primary w-full !py-2 !text-sm"
      >
        Host a game here
      </Link>
      <button className="w-full text-xs text-ink-soft underline" onClick={onCancel}>
        Cancel
      </button>
    </div>
  )
}
