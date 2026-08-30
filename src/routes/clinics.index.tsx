import { Link, createFileRoute } from '@tanstack/react-router'
import { fetchClinics } from '~/fn/clinics'
import { formatDateTime, relativeTime } from '~/server/time'

/**
 * Public, like the location day view: a clinic is something to be found, and
 * requiring a sign-in to see one is a way of having none.
 */
export const Route = createFileRoute('/clinics/')({
  // Signups change what a card says, so this must not come from cache.
  staleTime: 0,
  preloadStaleTime: 0,
  shouldReload: true,
  loader: () => fetchClinics(),
  component: Clinics,
})

function Clinics() {
  const { clinics } = Route.useLoaderData()

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold">Clinics</h1>
        <p className="hint mt-2">
          Coached sessions on the public courts — cardio tennis, drills, juniors. Run by
          local organizers, not by GameSeeker.
        </p>
      </header>

      {clinics.length === 0 ? (
        <p className="card p-6 text-center">
          <span className="font-semibold">Nothing scheduled right now.</span>
          <span className="hint mt-1 block">
            Run one yourself? Ask for organizer access from your profile.
          </span>
        </p>
      ) : (
        <ul className="space-y-3" data-testid="clinic-list">
          {clinics.map(({ clinic, locationName, organizerName, nextStartsAt }) => (
            <li key={clinic.id}>
              <Link
                to="/clinics/$clinicId"
                params={{ clinicId: clinic.id }}
                className="card block p-4 transition-colors hover:border-pinon-500"
              >
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold">{clinic.title}</p>
                    <p className="hint">
                      {locationName} · {organizerName}
                    </p>
                    {nextStartsAt ? (
                      <p className="mt-1 text-sm">
                        Next: {formatDateTime(nextStartsAt)}{' '}
                        <span className="hint">({relativeTime(nextStartsAt)})</span>
                      </p>
                    ) : null}
                  </div>
                  <span className="chip shrink-0 bg-sand-100 text-sand-700">
                    {clinic.capacity} places
                  </span>
                </div>
                {clinic.costNote ? <p className="hint mt-2">{clinic.costNote}</p> : null}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
