import { Link } from '@tanstack/react-router'
import { formatRange, relativeTime } from '~/server/time'

export type GameCardData = {
  game: {
    id: string
    startsAt: number
    endsAt: number
    format: 'singles' | 'doubles'
    isMixed: boolean
    status: 'open' | 'full' | 'cancelled' | 'completed'
    minNtrp: number
    maxNtrp: number
  }
  locationName: string
  courtName: string
  hostName: string
  openSlots: number
  filledSlots: number
}

export function LevelChip({ min, max }: { min: number; max: number }) {
  const label = min === max ? min.toFixed(1) : `${min.toFixed(1)}–${max.toFixed(1)}`
  return <span className="chip bg-sand-100 text-sand-700">NTRP {label}</span>
}

export function StatusChip({ status, openSlots }: { status: string; openSlots: number }) {
  if (status === 'cancelled') return <span className="chip bg-sand-200 text-sand-700">Cancelled</span>
  if (status === 'completed') return <span className="chip bg-sand-100 text-sand-600">Played</span>
  if (openSlots === 0) return <span className="chip bg-pinon-100 text-pinon-700">Full</span>
  return (
    <span className="chip bg-clay-100 text-clay-600">
      {openSlots} spot{openSlots === 1 ? '' : 's'} open
    </span>
  )
}

export function GameCard({ data }: { data: GameCardData }) {
  const { game } = data
  return (
    <Link
      to="/games/$gameId"
      params={{ gameId: game.id }}
      className="card block p-4 transition-colors hover:border-pinon-500"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold capitalize">
          {game.isMixed ? 'Mixed doubles' : game.format}
        </span>
        <LevelChip min={game.minNtrp} max={game.maxNtrp} />
        <StatusChip status={game.status} openSlots={data.openSlots} />
        <span className="ml-auto text-xs text-ink-soft">{relativeTime(game.startsAt)}</span>
      </div>

      <p className="mt-2 font-semibold">{formatRange(game.startsAt, game.endsAt)}</p>
      <p className="hint">
        {data.locationName} · {data.courtName}
      </p>
      <p className="hint mt-1">
        Hosted by {data.hostName} · {data.filledSlots} of {data.filledSlots + data.openSlots} in
      </p>
    </Link>
  )
}

export function EmptyState({
  title,
  children,
}: {
  title: string
  children?: React.ReactNode
}) {
  return (
    <div className="card p-6 text-center">
      <p className="font-semibold">{title}</p>
      {children ? <div className="hint mt-1">{children}</div> : null}
    </div>
  )
}
