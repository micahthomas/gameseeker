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
  format: 'singles' | 'doubles'
  isMixed: boolean
  // A game only reaches this grid once it has a court, so 'unplaceable' is
  // here for the type to line up, not because it can be drawn.
  status: 'open' | 'full' | 'cancelled' | 'completed' | 'unplaceable'
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
                {games
                  .filter((game) => game.courtId === court.id)
                  .map((game) => (
                    <GameBlock key={game.id} game={game} dayStart={dayStart} />
                  ))}

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

function GameBlock({ game, dayStart }: { game: ScheduledGame; dayStart: number }) {
  // A booking could in principle start before or end after the visible day.
  const sameDay = startOfLocalDay(game.startsAt) === dayStart
  const startMinute = sameDay ? localMinutes(game.startsAt) : 0
  const endMinute = localMinutes(game.endsAt) || 24 * 60
  const { top, height } = blockBounds(startMinute, endMinute)

  const open = game.openSlots > 0
  const roster = formatRoster(game.players)

  return (
    <Link
      to="/games/$gameId"
      params={{ gameId: game.id }}
      // data-entry keeps the drag handler off it, so tapping a game opens the
      // game rather than starting a "host here" selection on top of it.
      data-entry
      data-testid="court-game"
      title={`${formatTime(game.startsAt)}–${formatTime(game.endsAt)} · ${roster}`}
      className={`absolute inset-x-0.5 overflow-hidden rounded px-1 py-0.5 text-[10px] leading-tight font-semibold ${
        open
          ? 'border border-dashed border-clay-500 bg-clay-100 text-clay-600 hover:bg-clay-100/70'
          : 'bg-pinon-600 text-white hover:bg-pinon-700'
      }`}
      style={{ top: `${top}%`, height: `${height}%` }}
    >
      <span className="block truncate">{roster}</span>
      {height > 6 ? (
        <span className="block truncate opacity-80">
          {open
            ? `${game.openSlots} spot${game.openSlots === 1 ? '' : 's'} open`
            : game.isMixed
              ? 'mixed'
              : game.format}
        </span>
      ) : null}
    </Link>
  )
}
