import { Link, createFileRoute, notFound, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { FormError, errorMessage } from '~/components/ErrorPanel'
import { NotFound } from '~/components/NotFound'
import { fetchClinic, joinClinic, leaveClinic } from '~/fn/clinics'
import { formatDate, formatRange, relativeTime } from '~/server/time'

/**
 * Named `.index` so `/clinics/$clinicId/manage` is a sibling rather than a
 * child of this page. Flat routing would otherwise make this file the parent
 * of every deeper path, and a parent that renders no `<Outlet />` swallows
 * them silently — the manage page loads its data and never appears.
 */
export const Route = createFileRoute('/clinics/$clinicId/')({
  // Places are shared state: arriving here after somebody else signed up must
  // show that, so nothing is served from cache.
  staleTime: 0,
  preloadStaleTime: 0,
  shouldReload: true,
  loader: async ({ params }) => {
    const clinic = await fetchClinic({ data: { clinicId: params.clinicId } })
    if (!clinic) throw notFound()
    return clinic
  },
  notFoundComponent: () => <NotFound />,
  component: ClinicDetail,
})

function ClinicDetail() {
  const detail = Route.useLoaderData()
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const { clinic, location, organizer, occurrences, viewer } = detail
  const upcoming = occurrences.filter(
    (o) => o.occurrence.status === 'scheduled' && o.occurrence.endsAt > Date.now(),
  )

  async function run(id: string, action: () => Promise<unknown>) {
    setError(null)
    setBusy(id)
    try {
      await action()
      await router.invalidate()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="mx-auto max-w-lg space-y-6">
      {clinic.heroKey ? (
        <img
          src={`/api/media/${clinic.heroKey}`}
          alt=""
          // Intrinsic size is stored so the space is reserved before the image
          // arrives and the page doesn't jump under someone's thumb.
          width={clinic.heroWidth ?? undefined}
          height={clinic.heroHeight ?? undefined}
          className="aspect-[16/9] w-full rounded-xl object-cover"
        />
      ) : null}

      <header>
        <div className="flex flex-wrap items-center gap-2">
          {clinic.status === 'cancelled' ? (
            <span className="chip bg-sand-200 text-sand-700">Cancelled</span>
          ) : null}
          {clinic.status === 'draft' ? (
            <span className="chip bg-clay-100 text-clay-600">Not published yet</span>
          ) : null}
          <span className="chip bg-sand-100 text-sand-700">{clinic.capacity} places</span>
        </div>
        <h1 className="mt-2 text-2xl font-bold">{clinic.title}</h1>
        <p className="hint mt-1">
          <Link
            to="/locations/$locationId"
            params={{ locationId: location.id }}
            className="hover:underline"
          >
            {location.name}
          </Link>{' '}
          · run by {organizer.name}
        </p>
        {location.address ? <p className="hint">{location.address}</p> : null}
        {clinic.costNote ? (
          <p className="mt-3 rounded-lg bg-sand-100 px-3 py-2 text-sm">{clinic.costNote}</p>
        ) : null}
      </header>

      {clinic.cancelReason ? (
        <p className="card border-clay-500 p-4 text-sm">{clinic.cancelReason}</p>
      ) : null}

      {/* Markdown rendered on the server by `renderMarkdown`, which escapes the
          whole input before applying any rule — so nothing here can be markup
          the organizer didn't get through one. */}
      {detail.descriptionHtml ? (
        <section
          className="text-sm leading-relaxed"
          data-testid="clinic-description"
          dangerouslySetInnerHTML={{ __html: detail.descriptionHtml }}
        />
      ) : null}

      <section>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold">Sessions</h2>
          {viewer?.isOrganizer ? (
            <Link
              to="/clinics/$clinicId/manage"
              params={{ clinicId: clinic.id }}
              className="btn-secondary !px-3 !py-1 !text-sm"
            >
              Manage
            </Link>
          ) : null}
        </div>

        <FormError message={error} />

        {upcoming.length === 0 ? (
          <p className="hint mt-3">No sessions left to come.</p>
        ) : (
          <ul className="mt-3 space-y-2" data-testid="clinic-sessions">
            {upcoming.map(({ occurrence, courtName, taken, viewerSignedUp }) => {
              const left = clinic.capacity - taken
              return (
                <li key={occurrence.id} className="card flex items-center gap-3 p-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold">{formatDate(occurrence.startsAt)}</p>
                    <p className="hint">
                      {formatRange(occurrence.startsAt, occurrence.endsAt)} · {courtName}
                    </p>
                    <p className="hint">
                      {left > 0 ? `${left} of ${clinic.capacity} left` : 'Full'} ·{' '}
                      {relativeTime(occurrence.startsAt)}
                    </p>
                  </div>

                  {clinic.status !== 'published' ? null : viewerSignedUp ? (
                    <button
                      type="button"
                      className="btn-secondary !px-3 !py-1 !text-sm"
                      disabled={busy === occurrence.id}
                      onClick={() =>
                        run(occurrence.id, () =>
                          leaveClinic({ data: { occurrenceId: occurrence.id } }),
                        )
                      }
                    >
                      {busy === occurrence.id ? '…' : "I'm out"}
                    </button>
                  ) : viewer ? (
                    <button
                      type="button"
                      className="btn-primary !px-3 !py-1 !text-sm"
                      disabled={left === 0 || busy === occurrence.id}
                      onClick={() =>
                        run(occurrence.id, () =>
                          joinClinic({
                            data: { clinicId: clinic.id, occurrenceId: occurrence.id },
                          }),
                        )
                      }
                    >
                      {busy === occurrence.id ? '…' : left === 0 ? 'Full' : 'Sign up'}
                    </button>
                  ) : (
                    <Link to="/login" className="btn-secondary !px-3 !py-1 !text-sm">
                      Sign in
                    </Link>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <p className="hint">
        GameSeeker doesn't reserve courts with the city — public courts are first come, first
        served. Signing up tells the organizer to expect you and keeps you from being
        double-booked into a game at the same time.
      </p>
    </div>
  )
}
