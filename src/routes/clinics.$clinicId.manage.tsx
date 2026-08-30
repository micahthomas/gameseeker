import { Link, createFileRoute, notFound, redirect, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { FormError, errorMessage } from '~/components/ErrorPanel'
import { NotFound } from '~/components/NotFound'
import {
  cancelClinicSeries,
  cancelClinicSession,
  fetchClinic,
  publishClinic,
} from '~/fn/clinics'
import { formatDate, formatRange } from '~/server/time'

export const Route = createFileRoute('/clinics/$clinicId/manage')({
  beforeLoad: ({ context }) => {
    if (!context.user) throw redirect({ to: '/login' })
    return { user: context.user }
  },
  staleTime: 0,
  preloadStaleTime: 0,
  shouldReload: true,
  loader: async ({ params }) => {
    const clinic = await fetchClinic({ data: { clinicId: params.clinicId } })
    if (!clinic) throw notFound()
    return clinic
  },
  notFoundComponent: () => <NotFound />,
  component: ManageClinic,
})

function ManageClinic() {
  const detail = Route.useLoaderData()
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const { clinic, occurrences, viewer } = detail

  // The server refuses either way; this only keeps the controls off a page
  // somebody arrived at with a shared link.
  if (!viewer?.isOrganizer) {
    return (
      <div className="mx-auto max-w-lg">
        <p className="card p-6 text-center">This isn't your clinic to manage.</p>
      </div>
    )
  }

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
      <header>
        <h1 className="text-2xl font-bold">{clinic.title}</h1>
        <p className="hint mt-1">
          <Link
            to="/clinics/$clinicId"
            params={{ clinicId: clinic.id }}
            className="hover:underline"
          >
            See what players see
          </Link>
        </p>
      </header>

      <FormError message={error} />

      {clinic.status === 'draft' ? (
        <section className="card space-y-3 p-4">
          <h2 className="font-bold">Not published yet</h2>
          <p className="hint">
            The courts are already held, so nobody else can take them. Publishing opens
            signups and emails players who asked to hear about clinics at this park — it
            happens once, so read the description over first.
          </p>
          <button
            type="button"
            className="btn-primary"
            data-testid="publish-clinic"
            disabled={busy === 'publish'}
            onClick={() =>
              run('publish', () => publishClinic({ data: { clinicId: clinic.id } }))
            }
          >
            {busy === 'publish' ? 'Publishing…' : 'Publish and tell players'}
          </button>
        </section>
      ) : null}

      {clinic.status === 'cancelled' ? (
        <p className="card border-clay-500 p-4 text-sm">
          This clinic is cancelled. {clinic.cancelReason}
        </p>
      ) : null}

      <section>
        <h2 className="text-lg font-bold">Sessions</h2>
        {upcoming.length === 0 ? (
          <p className="hint mt-3">No sessions left to come.</p>
        ) : (
          <ul className="mt-3 space-y-2" data-testid="manage-sessions">
            {upcoming.map(({ occurrence, courtName, taken }) => (
              <li key={occurrence.id} className="card flex items-center gap-3 p-3">
                <div className="min-w-0 flex-1">
                  <p className="font-semibold">{formatDate(occurrence.startsAt)}</p>
                  <p className="hint">
                    {formatRange(occurrence.startsAt, occurrence.endsAt)} · {courtName}
                  </p>
                  <p className="hint">
                    {taken} of {clinic.capacity} signed up
                  </p>
                </div>
                <button
                  type="button"
                  className="btn-secondary !px-3 !py-1 !text-sm"
                  disabled={busy === occurrence.id}
                  onClick={() =>
                    run(occurrence.id, () =>
                      cancelClinicSession({
                        data: { clinicId: clinic.id, occurrenceId: occurrence.id },
                      }),
                    )
                  }
                >
                  {busy === occurrence.id ? '…' : 'Cancel'}
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="hint mt-3">
          Cancelling a session frees the court and tells everyone who signed up. There's no
          way to move one yet — cancel it and set up another.
        </p>
      </section>

      {clinic.status !== 'cancelled' ? (
        <section className="card space-y-3 p-4">
          <h2 className="font-bold">Call the whole thing off</h2>
          <p className="hint">
            Every date still to come is cancelled and everyone signed up is told. Dates that
            have already happened are left alone.
          </p>
          <button
            type="button"
            className="btn-danger"
            disabled={busy === 'series'}
            onClick={() =>
              run('series', () => cancelClinicSeries({ data: { clinicId: clinic.id } }))
            }
          >
            {busy === 'series' ? 'Cancelling…' : 'Cancel this clinic'}
          </button>
        </section>
      ) : null}
    </div>
  )
}
