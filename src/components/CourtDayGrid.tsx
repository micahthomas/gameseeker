import { Link } from '@tanstack/react-router'
import {
  DemandGutter,
  DemandLayer,
  DragPreview,
  GRID_HEIGHT,
  GridLines,
  GridPopover,
  PendingBlock,
  TimeGutter,
  blockBounds,
  useColumnDrag,
} from './timeGrid'
import { formatTime, localMinutes, startOfLocalDay } from '~/server/time'

/**
 * One day at one location, with a column per court — the view you want when
 * you're deciding where to put a game, or checking whether anyone's on court 3
 * this evening.
 *
 * Same geometry as the availability week view, so the two read as one system.
 */

export type CourtColumn = {
  id: string
  name: string
  surface: string
  hasLights: boolean
}

export type ScheduledGame = {
  id: string
  courtId: string
  startsAt: number
  endsAt: number
  /**
   * A clinic is drawn solid like a placed game — it holds its court from the
   * moment it's created — but in its own colour and linking to its own page.
   * It is never `pending`: there is no state in which a clinic is looking for
   * a court.
   */
  kind?: 'game' | 'clinic'
  /** Clinics only. A game is named by its roster instead. */
  title?: string
  format: 'singles' | 'doubles'
  isMixed: boolean
  // A game only reaches this grid once it has a court, so 'unplaceable' is
  // here for the type to line up, not because it can be drawn.
  status: 'open' | 'full' | 'cancelled' | 'completed' | 'unplaceable'
  /**
   * True for a game that holds no court yet, drawn in outline on the court it
   * would take if it filled right now.
   */
  pending?: boolean
  /** Names of everyone holding a seat. */
  players: string[]
  openSlots: number
}

/** "Micah & Arianna", or "Micah, Ann & Justina" once there are three. */
export function formatRoster(players: string[]): string {
  if (players.length === 0) return 'Open game'
  if (players.length === 1) return players[0]!
  return `${players.slice(0, -1).join(', ')} & ${players[players.length - 1]}`
}

export type CourtSelection = {
  court: CourtColumn
  startMinute: number
  endMinute: number
}

export function CourtDayGrid({
  dayStart,
  courts,
  games,
  selection,
  onSelect,
  popover,
  demand,
}: {
  dayStart: number
  courts: CourtColumn[]
  games: ScheduledGame[]
  /** A pending "host here" selection, kept drawn while the popover is open. */
  selection?: CourtSelection | null
  onSelect?: (selection: CourtSelection) => void
  popover?: React.ReactNode
  /** One count per half hour: how many players are free. */
  demand?: number[] | null
}) {
  const { gridProps, drag } = useColumnDrag({
    columnCount: courts.length,
    disabled: !onSelect,
    onSelect: ({ column, startMinute, endMinute }) => {
      const court = courts[column]
      if (court && onSelect) onSelect({ court, startMinute, endMinute })
    },
  })

  if (courts.length === 0) {
    return (
      <div className="card p-6 text-center">
        <p className="font-semibold">No courts listed here yet</p>
        <p className="hint mt-1">An admin can add them under Admin → Courts.</p>
      </div>
    )
  }

  return (
    // overflow-x-auto would clip the popover, so scrolling lives on an inner
    // wrapper and the card itself stays visible.
    <div className="card">
      {/* A narrow phone can't show eight columns, so the grid scrolls
          sideways rather than squeezing every court into 30 pixels. */}
      <div
        className="overflow-x-auto"
        style={{
          ['--min-w' as string]: `${Math.max(courts.length * 92 + (demand ? 72 : 48), 320)}px`,
        }}
      >
        <div className="min-w-[var(--min-w)]">
        <div className="flex border-b border-sand-200">
          <div className="w-12 shrink-0" />
          {demand ? <div className="w-6 shrink-0" /> : null}
          <div
            className="grid flex-1"
            style={{ gridTemplateColumns: `repeat(${courts.length}, minmax(0, 1fr))` }}
          >
            {courts.map((court) => (
              <div key={court.id} className="px-1 py-2 text-center" data-testid="court-heading">
                <div className="truncate text-sm font-semibold">{court.name}</div>
                <div className="truncate text-[10px] text-ink-soft">
                  {court.surface}
                  {court.hasLights ? ' · lights' : ''}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="flex">
          <TimeGutter />
          {demand ? <DemandGutter counts={demand} /> : null}
          <div
            {...gridProps}
            className={`relative grid flex-1 touch-none ${onSelect ? 'cursor-crosshair' : ''}`}
            style={{
              height: GRID_HEIGHT,
              gridTemplateColumns: `repeat(${courts.length}, minmax(0, 1fr))`,
            }}
            role="application"
            aria-label="Court schedule. Drag to host a game."
          >
            {demand ? <DemandLayer counts={demand} max={Math.max(...demand)} /> : null}

            {courts.map((court, columnIndex) => (
              <div key={court.id} className="relative border-l border-sand-200 first:border-l-0">
                <GridLines column={columnIndex} />
                {laneOut(games.filter((game) => game.courtId === court.id)).map(
                  ({ game, lane, lanes }) => (
                    <GameBlock
                      key={game.id}
                      game={game}
                      dayStart={dayStart}
                      lane={lane}
                      lanes={lanes}
                    />
                  ),
                )}

                {selection?.court.id === court.id ? (
                  <PendingBlock
                    startMinute={selection.startMinute}
                    endMinute={selection.endMinute}
                  />
                ) : null}

                {drag && drag.column === columnIndex ? <DragPreview drag={drag} /> : null}
              </div>
            ))}

            {selection && popover ? (
              <GridPopover
                column={courts.findIndex((c) => c.id === selection.court.id)}
                columnCount={courts.length}
                startMinute={selection.startMinute}
                maxHeight={190}
              >
                {popover}
              </GridPopover>
            ) : null}
          </div>
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * Split overlapping blocks in one column into side-by-side lanes.
 *
 * Placed games never overlap — the court locks see to that — so this is a
 * no-op for them. Projected pending games can: two games at the same hour will
 * both want the best free court, and both really are competing for it. Drawing
 * them stacked would hide one entirely.
 */
function laneOut(
  games: ScheduledGame[],
): Array<{ game: ScheduledGame; lane: number; lanes: number }> {
  const sorted = [...games].sort((a, b) => a.startsAt - b.startsAt)
  const laneEnds: number[] = []
  const placed = sorted.map((game) => {
    let lane = laneEnds.findIndex((end) => end <= game.startsAt)
    if (lane === -1) lane = laneEnds.length
    laneEnds[lane] = game.endsAt
    return { game, lane }
  })

  // One lane count for the whole column keeps widths consistent down it,
  // which matters more than squeezing every block to its own cluster width.
  const lanes = Math.max(1, laneEnds.length)
  return placed.map((entry) => ({ ...entry, lanes }))
}

function GameBlock({
  game,
  dayStart,
  lane = 0,
  lanes = 1,
}: {
  game: ScheduledGame
  dayStart: number
  lane?: number
  lanes?: number
}) {
  // A booking could in principle start before or end after the visible day.
  const sameDay = startOfLocalDay(game.startsAt) === dayStart
  const startMinute = sameDay ? localMinutes(game.startsAt) : 0
  const endMinute = localMinutes(game.endsAt) || 24 * 60
  const { top, height } = blockBounds(startMinute, endMinute)

  const open = game.openSlots > 0
  const clinic = game.kind === 'clinic'
  const label = clinic ? (game.title ?? 'Clinic') : formatRoster(game.players)

  // Outline for a game that hasn't taken this court yet, solid once it has.
  // The distinction the calendar has to carry is "is this court actually
  // spoken for", and a pending game's answer is no. A clinic's is always yes.
  const look = clinic
    ? 'bg-sand-700 text-white hover:bg-sand-600'
    : game.pending
      ? 'border border-dashed border-sand-400 bg-white/70 text-ink-soft hover:bg-white'
      : open
        ? 'border border-dashed border-clay-500 bg-clay-100 text-clay-600 hover:bg-clay-100/70'
        : 'bg-pinon-600 text-white hover:bg-pinon-700'

  const when = `${formatTime(game.startsAt)}–${formatTime(game.endsAt)}`
  const width = 100 / lanes
  const style = {
    top: `${top}%`,
    height: `${height}%`,
    left: `calc(${lane * width}% + 2px)`,
    width: `calc(${width}% - 4px)`,
  }
  // data-entry keeps the drag handler off it, so tapping a booking opens it
  // rather than starting a "host here" selection on top of it.
  const className = `absolute overflow-hidden rounded px-1 py-0.5 text-[10px] leading-tight font-semibold ${look}`

  const detail = clinic
    ? open
      ? `${game.openSlots} place${game.openSlots === 1 ? '' : 's'} left`
      : 'full'
    : game.pending
      ? 'not booked yet'
      : open
        ? `${game.openSlots} spot${game.openSlots === 1 ? '' : 's'} open`
        : game.isMixed
          ? 'mixed'
          : game.format

  const body = (
    <>
      <span className="block truncate">{label}</span>
      {height > 6 ? <span className="block truncate opacity-80">{detail}</span> : null}
    </>
  )

  if (clinic) {
    return (
      <Link
        to="/clinics/$clinicId"
        params={{ clinicId: game.id }}
        data-entry
        data-testid="court-clinic"
        title={`${when} · ${label} · clinic`}
        className={className}
        style={style}
      >
        {body}
      </Link>
    )
  }

  return (
    <Link
      to="/games/$gameId"
      params={{ gameId: game.id }}
      data-entry
      data-testid={game.pending ? 'court-game-pending' : 'court-game'}
      title={
        game.pending
          ? `${when} · ${label} · not booked yet, would land here`
          : `${when} · ${label}`
      }
      className={className}
      style={style}
    >
      {body}
    </Link>
  )
}
