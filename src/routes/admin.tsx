import { createFileRoute, redirect, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { FormError, errorMessage } from '~/components/ErrorPanel'
import { LOCATION_KINDS, SURFACES } from '~/db/schema'
import {
  decideOrganizerRequest,
  fetchAdminLocations,
  fetchOrganizerRequests,
  fetchPlayers,
  saveCourt,
  saveLocation,
  setCourtActive,
  setPlayerAdmin,
} from '~/fn/admin'
import { formatDate } from '~/server/time'

export const Route = createFileRoute('/admin')({
  beforeLoad: ({ context }) => {
    if (!context.user) throw redirect({ to: '/login' })
    if (!context.user.isAdmin) throw redirect({ to: '/' })
    return { user: context.user }
  },
  loader: async () => ({
    ...(await fetchAdminLocations()),
    players: await fetchPlayers(),
    organizers: await fetchOrganizerRequests(),
  }),
  component: Admin,
})

function Admin() {
  const data = Route.useLoaderData()
  const router = useRouter()
  const [tab, setTab] = useState<'courts' | 'players' | 'organizers'>('courts')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const pending = data.organizers.filter((r) => r.status === 'requested').length

  async function run(action: () => Promise<unknown>) {
    setError(null)
    setBusy(true)
    try {
      await action()
      await router.invalidate()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold">Admin</h1>
        <p className="hint mt-2">
          The seeded court list came from public information and is a starting point — correct it
          here so hosts only see courts that really exist and are playable.
        </p>
      </header>

      <div className="flex gap-2">
        <button
          className={tab === 'courts' ? 'btn-primary flex-1 !py-2' : 'btn-secondary flex-1 !py-2'}
          onClick={() => setTab('courts')}
        >
          Courts
        </button>
        <button
          className={tab === 'players' ? 'btn-primary flex-1 !py-2' : 'btn-secondary flex-1 !py-2'}
          onClick={() => setTab('players')}
        >
          Players
        </button>
        <button
          className={
            tab === 'organizers' ? 'btn-primary flex-1 !py-2' : 'btn-secondary flex-1 !py-2'
          }
          onClick={() => setTab('organizers')}
        >
          Organizers
          {pending > 0 ? (
            <span className="ml-1.5 rounded-full bg-clay-500 px-1.5 text-xs text-white">
              {pending}
            </span>
          ) : null}
        </button>
      </div>

      <FormError message={error} />

      {tab === 'courts' ? (
        <CourtsTab data={data} run={run} busy={busy} />
      ) : tab === 'players' ? (
        <PlayersTab players={data.players} run={run} busy={busy} />
      ) : (
        <OrganizersTab requests={data.organizers} run={run} busy={busy} />
      )}
    </div>
  )
}

type AdminData = Awaited<ReturnType<typeof fetchAdminLocations>> & {
  players: Awaited<ReturnType<typeof fetchPlayers>>
  organizers: Awaited<ReturnType<typeof fetchOrganizerRequests>>
}

/**
 * Approving clinic organizers.
 *
 * The one thing in the app an admin vouches for on a player's behalf: a clinic
 * holds a public court for weeks, and once people have signed up there is no
 * clean way to take that back. Declined requests stay listed so a decision
 * isn't quietly re-requestable, and so it can be reversed if it was wrong.
 */
function OrganizersTab({
  requests,
  run,
  busy,
}: {
  requests: AdminData['organizers']
  run: (action: () => Promise<unknown>) => Promise<void>
  busy: boolean
}) {
  if (requests.length === 0) {
    return <p className="card p-6 text-center">Nobody has asked to run clinics yet.</p>
  }

  return (
    <ul className="space-y-3" data-testid="organizer-requests">
      {requests.map((request) => (
        <li key={request.id} className="card space-y-2 p-4">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <p className="font-semibold">{request.name}</p>
              <p className="hint">
                {request.email} · {request.ntrp.toFixed(1)} NTRP
                {request.requestedAt ? ` · asked ${formatDate(request.requestedAt)}` : ''}
              </p>
            </div>
            <span
              className={
                request.status === 'approved'
                  ? 'chip shrink-0 bg-pinon-100 text-pinon-700'
                  : request.status === 'declined'
                    ? 'chip shrink-0 bg-sand-200 text-sand-700'
                    : 'chip shrink-0 bg-clay-100 text-clay-600'
              }
            >
              {request.status}
            </span>
          </div>

          {request.note ? (
            <p className="rounded-lg bg-sand-100 px-3 py-2 text-sm">{request.note}</p>
          ) : null}

          <div className="flex gap-2">
            {request.status !== 'approved' ? (
              <button
                className="btn-primary !px-3 !py-1 !text-sm"
                disabled={busy}
                onClick={() =>
                  run(() => decideOrganizerRequest({ data: { userId: request.id, approve: true } }))
                }
              >
                Approve
              </button>
            ) : null}
            {request.status !== 'declined' ? (
              <button
                className="btn-secondary !px-3 !py-1 !text-sm"
                disabled={busy}
                onClick={() =>
                  run(() =>
                    decideOrganizerRequest({ data: { userId: request.id, approve: false } }),
                  )
                }
              >
                {request.status === 'approved' ? 'Revoke' : 'Decline'}
              </button>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  )
}

function CourtsTab({
  data,
  run,
  busy,
}: {
  data: AdminData
  run: (action: () => Promise<unknown>) => Promise<void>
  busy: boolean
}) {
  const [newLocation, setNewLocation] = useState(false)

  return (
    <div className="space-y-4">
      {data.locations.map(({ location }) => {
        const courts = data.courts.filter((c) => c.locationId === location.id)
        return (
          <section key={location.id} className="card p-4">
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <p className="font-semibold">{location.name}</p>
                {location.address ? <p className="hint">{location.address}</p> : null}
              </div>
              {!location.isActive ? (
                <span className="chip bg-sand-200 text-sand-700">hidden</span>
              ) : null}
            </div>

            <ul className="mt-3 space-y-1.5">
              {courts.map((court) => (
                <li
                  key={court.id}
                  className="flex items-center gap-2 rounded-lg bg-sand-100 px-3 py-2 text-sm"
                >
                  <span className={court.isActive ? 'font-semibold' : 'font-semibold line-through'}>
                    {court.name}
                  </span>
                  <span className="text-ink-soft capitalize">{court.surface}</span>
                  {court.hasLights ? <span className="text-ink-soft">· lights</span> : null}
                  <button
                    className="ml-auto underline"
                    disabled={busy}
                    onClick={() =>
                      run(() =>
                        setCourtActive({ data: { courtId: court.id, isActive: !court.isActive } }),
                      )
                    }
                  >
                    {court.isActive ? 'Close' : 'Reopen'}
                  </button>
                </li>
              ))}
            </ul>

            <AddCourtForm locationId={location.id} nextOrder={courts.length + 1} run={run} busy={busy} />
          </section>
        )
      })}

      {newLocation ? (
        <AddLocationForm run={run} busy={busy} onDone={() => setNewLocation(false)} />
      ) : (
        <button className="btn-secondary w-full" onClick={() => setNewLocation(true)}>
          Add a location
        </button>
      )}
    </div>
  )
}

function AddCourtForm({
  locationId,
  nextOrder,
  run,
  busy,
}: {
  locationId: string
  nextOrder: number
  run: (action: () => Promise<unknown>) => Promise<void>
  busy: boolean
}) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState(`Court ${nextOrder}`)
  const [surface, setSurface] = useState<(typeof SURFACES)[number]>('hard')
  const [hasLights, setHasLights] = useState(false)

  if (!open) {
    return (
      <button className="hint mt-3 underline" onClick={() => setOpen(true)}>
        + Add a court
      </button>
    )
  }

  return (
    <div className="mt-3 space-y-2 rounded-lg border border-sand-200 p-3">
      <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
      <div className="flex gap-2">
        <select
          className="input"
          value={surface}
          onChange={(e) => setSurface(e.target.value as (typeof SURFACES)[number])}
        >
          {SURFACES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-2 whitespace-nowrap text-sm">
          <input
            type="checkbox"
            className="size-5 accent-pinon-600"
            checked={hasLights}
            onChange={(e) => setHasLights(e.target.checked)}
          />
          Lights
        </label>
      </div>
      <div className="flex gap-2">
        <button className="btn-secondary flex-1 !py-2" onClick={() => setOpen(false)}>
          Cancel
        </button>
        <button
          className="btn-primary flex-1 !py-2"
          disabled={busy}
          onClick={() =>
            run(async () => {
              await saveCourt({
                data: {
                  locationId,
                  name,
                  surface,
                  hasLights,
                  isActive: true,
                  sortOrder: nextOrder,
                },
              })
              setOpen(false)
            })
          }
        >
          Add court
        </button>
      </div>
    </div>
  )
}

function AddLocationForm({
  run,
  busy,
  onDone,
}: {
  run: (action: () => Promise<unknown>) => Promise<void>
  busy: boolean
  onDone: () => void
}) {
  const [name, setName] = useState('')
  const [address, setAddress] = useState('')
  const [kind, setKind] = useState<(typeof LOCATION_KINDS)[number]>('public_park')

  return (
    <div className="card space-y-3 p-4">
      <p className="font-semibold">New location</p>
      <input
        className="input"
        placeholder="Name"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <input
        className="input"
        placeholder="Address"
        value={address}
        onChange={(e) => setAddress(e.target.value)}
      />
      <select
        className="input"
        value={kind}
        onChange={(e) => setKind(e.target.value as (typeof LOCATION_KINDS)[number])}
      >
        {LOCATION_KINDS.map((k) => (
          <option key={k} value={k}>
            {k.replace('_', ' ')}
          </option>
        ))}
      </select>
      <div className="flex gap-2">
        <button className="btn-secondary flex-1" onClick={onDone}>
          Cancel
        </button>
        <button
          className="btn-primary flex-1"
          disabled={busy || name.trim().length < 2}
          onClick={() =>
            run(async () => {
              await saveLocation({
                data: { name, address: address || undefined, kind, isActive: true },
              })
              onDone()
            })
          }
        >
          Add location
        </button>
      </div>
    </div>
  )
}

function PlayersTab({
  players,
  run,
  busy,
}: {
  players: AdminData['players']
  run: (action: () => Promise<unknown>) => Promise<void>
  busy: boolean
}) {
  return (
    <ul className="space-y-2">
      {players.map((player) => (
        <li key={player.id} className="card flex items-center gap-3 p-3">
          <div className="min-w-0 flex-1">
            <p className="font-semibold">
              {player.name}
              {player.profileCompletedAt === null ? (
                <span className="chip ml-2 bg-sand-100 text-sand-700">incomplete</span>
              ) : null}
            </p>
            <p className="hint truncate">
              {player.email} · {player.ntrp.toFixed(1)} NTRP
              {player.ratingSystem === 'UTR' ? ` (UTR ${player.ratingValue})` : ''}
            </p>
          </div>
          <button
            className={player.isAdmin ? 'btn-danger !px-3 !py-1.5 !text-sm' : 'btn-secondary !px-3 !py-1.5 !text-sm'}
            disabled={busy}
            onClick={() =>
              run(() => setPlayerAdmin({ data: { userId: player.id, isAdmin: !player.isAdmin } }))
            }
          >
            {player.isAdmin ? 'Remove admin' : 'Make admin'}
          </button>
        </li>
      ))}
    </ul>
  )
}
