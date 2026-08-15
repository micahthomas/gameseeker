import { Link, createFileRoute } from '@tanstack/react-router'
import { fetchLocations } from '~/fn/games'

export const Route = createFileRoute('/locations/')({
  loader: () => fetchLocations(),
  component: Locations,
})

const KIND_LABELS: Record<string, string> = {
  public_park: 'City park',
  club: 'Private club',
  rec_center: 'Rec center',
  school: 'School',
}

function Locations() {
  const locations = Route.useLoaderData()

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold">Courts around Santa Fe</h1>
        <p className="hint mt-2">
          Tap a location to see what's already booked on each court this week.
        </p>
      </header>

      <ul className="space-y-3">
        {locations.map((loc) => (
          <li key={loc.id}>
            <Link
              to="/locations/$locationId"
              params={{ locationId: loc.id }}
              className="card block p-4 transition-colors hover:border-pinon-500"
            >
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <p className="font-semibold">{loc.name}</p>
                  {loc.address ? <p className="hint">{loc.address}</p> : null}
                  {loc.notes ? <p className="hint mt-1">{loc.notes}</p> : null}
                </div>
                <span className="chip shrink-0 bg-sand-100 text-sand-700">
                  {KIND_LABELS[loc.kind] ?? loc.kind}
                </span>
              </div>
            </Link>
          </li>
        ))}
      </ul>

      <p className="hint">
        Missing a court, or is one closed for resurfacing? An admin can fix it under Admin →
        Courts.
      </p>
    </div>
  )
}
