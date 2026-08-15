import { createFileRoute, redirect, useRouter } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { z } from 'zod'
import { FormError, errorMessage } from '~/components/ErrorPanel'
import type { GameFormat } from '~/db/schema'
import { fetchFreeCourts, fetchLocations, fetchReach, postGame } from '~/fn/games'
import { searchPlayers } from '~/fn/profile'
import { NTRP_LEVELS } from '~/server/rating'
import {
  DAY,
  MINUTE,
  courtHourOptions,
  formatRange,
  toDateInput,
  zonedToUtc,
} from '~/server/time'

export const Route = createFileRoute('/games/new')({
  validateSearch: z.object({ locationId: z.string().optional() }),
  beforeLoad: ({ context }) => {
    if (!context.user) throw redirect({ to: '/login' })
    return { user: context.user }
  },
  loader: () => fetchLocations(),
  component: NewGame,
})

const DURATIONS = [
  { minutes: 60, label: '1 hour' },
  { minutes: 90, label: '1½ hours' },
  { minutes: 120, label: '2 hours' },
  { minutes: 180, label: '3 hours' },
]

type SeatChoice =
  | { kind: 'seeker'; seekerNtrp: number }
  | { kind: 'invited'; invitedUserId: string; invitedName: string }

function NewGame() {
  const locations = Route.useLoaderData()
  const { user } = Route.useRouteContext()
  const search = Route.useSearch()
  const router = useRouter()

  const [locationId, setLocationId] = useState(
    search.locationId ?? user.homeLocationId ?? locations[0]?.id ?? '',
  )
  const [date, setDate] = useState(toDateInput(Date.now() + DAY))
  const [startMinute, setStartMinute] = useState(17 * 60)
  const [duration, setDuration] = useState(90)
  const [format, setFormat] = useState<GameFormat>(user.playsDoubles ? 'doubles' : 'singles')
  const [courtId, setCourtId] = useState('')
  const [notes, setNotes] = useState('')
  const [seats, setSeats] = useState<SeatChoice[]>([])

  const [freeCourts, setFreeCourts] = useState<Array<{ id: string; name: string }> | null>(null)
  const [reach, setReach] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const [y, m, d] = date.split('-').map(Number)
  const startsAt =
    y && m && d ? zonedToUtc(y, m, d, 0, startMinute) : Number.NaN
  const endsAt = startsAt + duration * MINUTE
  const timesValid = Number.isFinite(startsAt) && startsAt > Date.now()

  const seatCount = format === 'singles' ? 1 : 3

  // Keep the seat list the right length whenever the format changes.
  useEffect(() => {
    setSeats((current) => {
      const next = current.slice(0, seatCount)
      while (next.length < seatCount) {
        next.push({ kind: 'seeker', seekerNtrp: roundToLevel(user.ntrp) })
      }
      return next
    })
  }, [seatCount, user.ntrp])

  // Which courts are actually open for this window.
  useEffect(() => {
    if (!locationId || !timesValid) {
      setFreeCourts(null)
      return
    }
    let cancelled = false
    void fetchFreeCourts({ data: { locationId, startsAt, endsAt } })
      .then((courts) => {
        if (cancelled) return
        setFreeCourts(courts)
        setCourtId((current) =>
          courts.some((c) => c.id === current) ? current : (courts[0]?.id ?? ''),
        )
      })
      .catch(() => {
        if (!cancelled) setFreeCourts([])
      })
    return () => {
      cancelled = true
    }
  }, [locationId, startsAt, endsAt, timesValid])

  // How many players would hear about this. An early zero is the useful
  // signal: move the time or widen the level before posting into the void.
  const seekerLevel = seats.find((s) => s.kind === 'seeker')?.seekerNtrp
  useEffect(() => {
    if (!timesValid || seekerLevel === undefined) {
      setReach(null)
      return
    }
    let cancelled = false
    void fetchReach({ data: { startsAt, endsAt, format, seekerNtrp: seekerLevel } })
      .then((result) => !cancelled && setReach(result.count))
      .catch(() => !cancelled && setReach(null))
    return () => {
      cancelled = true
    }
  }, [startsAt, endsAt, format, seekerLevel, timesValid])

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      const result = await postGame({
        data: {
          courtId,
          startsAt,
          endsAt,
          format,
          notes: notes || undefined,
          slots: seats.map((seat) =>
            seat.kind === 'seeker'
              ? { kind: 'seeker' as const, seekerNtrp: seat.seekerNtrp }
              : { kind: 'invited' as const, invitedUserId: seat.invitedUserId },
          ),
        },
      })
      await router.invalidate()
      router.navigate({ to: '/games/$gameId', params: { gameId: result.gameId } })
    } catch (err) {
      setError(errorMessage(err))
      setSubmitting(false)
    }
  }

  const hours = courtHourOptions()

  return (
    <form onSubmit={handleSubmit} className="mx-auto max-w-lg space-y-6">
      <header>
        <h1 className="text-2xl font-bold">Host a game</h1>
        <p className="hint mt-2">
          Pick a court and time, say who you're looking for, and we'll message players at that
          level who are free.
        </p>
      </header>

      <section className="card space-y-4 p-4">
        <p className="font-semibold">Where and when</p>

        <div>
          <label className="label" htmlFor="location">
            Location
          </label>
          <select
            id="location"
            className="input"
            value={locationId}
            onChange={(e) => setLocationId(e.target.value)}
          >
            {locations.map((loc) => (
              <option key={loc.id} value={loc.id}>
                {loc.name}
              </option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label" htmlFor="date">
              Date
            </label>
            <input
              id="date"
              type="date"
              className="input"
              value={date}
              min={toDateInput(Date.now())}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
          <div>
            <label className="label" htmlFor="start">
              Start
            </label>
            <select
              id="start"
              className="input"
              value={startMinute}
              onChange={(e) => setStartMinute(Number(e.target.value))}
            >
              {hours.map((h) => (
                <option key={h.minute} value={h.minute}>
                  {h.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <span className="label">How long?</span>
          <div className="flex flex-wrap gap-2">
            {DURATIONS.map((option) => (
              <button
                key={option.minutes}
                type="button"
                onClick={() => setDuration(option.minutes)}
                className={
                  duration === option.minutes
                    ? 'chip bg-pinon-600 text-white'
                    : 'chip bg-sand-100 text-sand-700 hover:bg-sand-200'
                }
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        {timesValid ? (
          <p className="hint">{formatRange(startsAt, endsAt)} — Santa Fe time</p>
        ) : (
          <p className="hint text-clay-600">Pick a start time in the future.</p>
        )}

        <div>
          <label className="label" htmlFor="court">
            Court
          </label>
          {freeCourts === null ? (
            <p className="hint">Choose a time to see open courts.</p>
          ) : freeCourts.length === 0 ? (
            <p className="hint text-clay-600">
              Every court here is already claimed for that time. Try another time or location.
            </p>
          ) : (
            <>
              <select
                id="court"
                className="input"
                value={courtId}
                onChange={(e) => setCourtId(e.target.value)}
              >
                {freeCourts.map((court) => (
                  <option key={court.id} value={court.id}>
                    {court.name}
                  </option>
                ))}
              </select>
              <p className="hint mt-1">
                {freeCourts.length} court{freeCourts.length === 1 ? '' : 's'} open. Courts already
                claimed by another GameSeeker game are hidden.
              </p>
            </>
          )}
        </div>
      </section>

      <section className="card space-y-4 p-4">
        <p className="font-semibold">Who's playing</p>

        <div className="flex gap-2">
          {(['singles', 'doubles'] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setFormat(option)}
              className={
                format === option ? 'btn-primary flex-1 !py-2' : 'btn-secondary flex-1 !py-2'
              }
            >
              <span className="capitalize">{option}</span>
            </button>
          ))}
        </div>

        <div className="rounded-lg bg-sand-100 px-3 py-2 text-sm">
          <strong>You</strong> — {user.ntrp.toFixed(1)} NTRP (host)
        </div>

        {seats.map((seat, index) => (
          <SeatPicker
            key={index}
            index={index}
            seat={seat}
            defaultLevel={roundToLevel(user.ntrp)}
            onChange={(next) =>
              setSeats((current) => current.map((s, i) => (i === index ? next : s)))
            }
          />
        ))}
      </section>

      <section className="card space-y-3 p-4">
        <label className="label" htmlFor="notes">
          Note for players <span className="font-normal text-ink-soft">(optional)</span>
        </label>
        <input
          id="notes"
          className="input"
          placeholder="Bring a can of balls — I'll bring water"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </section>

      {reach !== null ? (
        <div
          className={
            reach === 0
              ? 'rounded-lg border border-clay-500/40 bg-clay-100 px-3 py-2.5 text-sm text-clay-600'
              : 'rounded-lg border border-pinon-500/30 bg-pinon-50 px-3 py-2.5 text-sm text-pinon-700'
          }
        >
          {reach === 0 ? (
            <>
              No one has posted availability for this time at this level. You can still post it —
              it'll show up on the dashboard — but nobody will be messaged.
            </>
          ) : (
            <>
              <strong>{reach}</strong> player{reach === 1 ? '' : 's'} will be notified.
            </>
          )}
        </div>
      ) : null}

      <FormError message={error} />

      <button
        type="submit"
        className="btn-primary w-full"
        disabled={
          submitting ||
          !timesValid ||
          !courtId ||
          seats.length !== seatCount ||
          // An "invite someone" seat with nobody picked yet isn't postable.
          seats.some((seat) => seat.kind === 'invited' && !seat.invitedUserId)
        }
      >
        {submitting ? 'Posting…' : 'Post game'}
      </button>
    </form>
  )
}

function roundToLevel(ntrp: number): number {
  const first = NTRP_LEVELS[0]!
  const last = NTRP_LEVELS[NTRP_LEVELS.length - 1]!
  return Math.min(last, Math.max(first, Math.round(ntrp * 2) / 2))
}

function SeatPicker({
  index,
  seat,
  defaultLevel,
  onChange,
}: {
  index: number
  seat: SeatChoice
  defaultLevel: number
  onChange: (seat: SeatChoice) => void
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Array<{ id: string; name: string; ntrp: number }>>([])

  useEffect(() => {
    if (seat.kind !== 'invited' || query.trim().length < 2) {
      setResults([])
      return
    }
    let cancelled = false
    void searchPlayers({ data: { query } })
      .then((rows) => !cancelled && setResults(rows))
      .catch(() => !cancelled && setResults([]))
    return () => {
      cancelled = true
    }
  }, [query, seat.kind])

  return (
    <div className="rounded-lg border border-sand-200 p-3">
      <p className="mb-2 text-sm font-semibold text-ink-soft">Player {index + 2}</p>

      <div className="mb-3 flex gap-2">
        <button
          type="button"
          onClick={() => onChange({ kind: 'seeker', seekerNtrp: defaultLevel })}
          className={
            seat.kind === 'seeker'
              ? 'chip bg-pinon-600 text-white'
              : 'chip bg-sand-100 text-sand-700'
          }
        >
          Open to anyone
        </button>
        <button
          type="button"
          onClick={() => onChange({ kind: 'invited', invitedUserId: '', invitedName: '' })}
          className={
            seat.kind === 'invited'
              ? 'chip bg-pinon-600 text-white'
              : 'chip bg-sand-100 text-sand-700'
          }
        >
          Invite someone
        </button>
      </div>

      {seat.kind === 'seeker' ? (
        <div>
          <label className="label" htmlFor={`level-${index}`}>
            Level to look for
          </label>
          <select
            id={`level-${index}`}
            className="input"
            value={seat.seekerNtrp}
            onChange={(e) => onChange({ kind: 'seeker', seekerNtrp: Number(e.target.value) })}
          >
            {NTRP_LEVELS.map((level) => (
              <option key={level} value={level}>
                GameSeeker {level.toFixed(1)}
              </option>
            ))}
          </select>
          <p className="hint mt-1">
            Players from {(seat.seekerNtrp - 0.5).toFixed(1)} to {(seat.seekerNtrp + 0.5).toFixed(1)}{' '}
            will be messaged.
          </p>
        </div>
      ) : (
        <div>
          {seat.invitedUserId ? (
            <div className="flex items-center gap-2">
              <span className="chip bg-pinon-100 text-pinon-700">{seat.invitedName}</span>
              <button
                type="button"
                className="hint underline"
                onClick={() => onChange({ kind: 'invited', invitedUserId: '', invitedName: '' })}
              >
                change
              </button>
            </div>
          ) : (
            <>
              <input
                className="input"
                placeholder="Search players by name"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <ul className="mt-2 space-y-1">
                {results.map((player) => (
                  <li key={player.id}>
                    <button
                      type="button"
                      className="w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-sand-100"
                      onClick={() =>
                        onChange({
                          kind: 'invited',
                          invitedUserId: player.id,
                          invitedName: player.name,
                        })
                      }
                    >
                      {player.name}{' '}
                      <span className="text-ink-soft">{player.ntrp.toFixed(1)}</span>
                    </button>
                  </li>
                ))}
                {query.trim().length >= 2 && results.length === 0 ? (
                  <li className="hint">No players found.</li>
                ) : null}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  )
}
