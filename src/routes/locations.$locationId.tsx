import { Link, createFileRoute, notFound } from '@tanstack/react-router'
import { NotFound } from '~/components/NotFound'
import { fetchLocationCalendar } from '~/fn/games'
import { formatDate, formatTime, localDayRanges, startOfLocalDay } from '~/server/time'

const VIEW_DAYS = 7

export const Route = createFileRoute('/locations/$locationId')({
  loader: async ({ params }) => {
    const data = await fetchLocationCalendar({
      data: {
        locationId: params.locationId,
        fromMs: startOfLocalDay(Date.now()),
        days: VIEW_DAYS,
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
  const days = localDayRanges(Date.now(), VIEW_DAYS)

  return (
    <div className="space-y-6">
      <header>
        <Link to="/locations" className="hint hover:underline">
          ← All courts
        </Link>
        <h1 className="mt-2 text-2xl font-bold">{location.name}</h1>
        {location.address ? <p className="hint">{location.address}</p> : null}
        {location.notes ? <p className="hint mt-2">{location.notes}</p> : null}
        <p className="hint mt-2">
          {courts.length} court{courts.length === 1 ? '' : 's'}
        </p>
      </header>

      <section>
        <h2 className="text-lg font-bold">This week</h2>
        <p className="hint mt-1">
          Games other players have scheduled here. A court with a game on it is off limits for that
          time.
        </p>

        <div className="mt-3 space-y-3">
          {days.map((day) => {
            const dayGames = games.filter(
              (g) => g.startsAt >= day.start && g.startsAt < day.end,
            )
            return (
              <div key={day.start} className="card p-4">
                <p className="font-semibold">{formatDate(day.start)}</p>
                {dayGames.length === 0 ? (
                  <p className="hint mt-1">All courts open.</p>
                ) : (
                  <ul className="mt-2 space-y-1.5">
                    {dayGames.map((g) => {
                      const court = courts.find((c) => c.id === g.courtId)
                      return (
                        <li key={g.id}>
                          <Link
                            to="/games/$gameId"
                            params={{ gameId: g.id }}
                            className="flex items-center gap-2 rounded-lg bg-sand-100 px-3 py-2 text-sm hover:bg-sand-200"
                          >
                            <span className="font-semibold">
                              {formatTime(g.startsAt)}–{formatTime(g.endsAt)}
                            </span>
                            <span className="text-ink-soft">{court?.name ?? 'Court'}</span>
                            <span className="ml-auto capitalize text-ink-soft">{g.format}</span>
                          </Link>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </div>
            )
          })}
        </div>
      </section>

      <section>
        <h2 className="text-lg font-bold">Courts</h2>
        <ul className="mt-3 grid gap-2 sm:grid-cols-2">
          {courts.map((court) => (
            <li key={court.id} className="card flex items-center gap-2 p-3">
              <span className="font-semibold">{court.name}</span>
              <span className="chip bg-sand-100 text-sand-700 capitalize">{court.surface}</span>
              {court.hasLights ? (
                <span className="chip bg-clay-100 text-clay-600">lights</span>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      <Link to="/games/new" search={{ locationId: location.id }} className="btn-primary w-full">
        Host a game here
      </Link>
    </div>
  )
}
