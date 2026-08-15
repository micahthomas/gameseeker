import { useCallback, useEffect, useRef, useState } from 'react'
import { formatMinuteOfDay } from '~/server/time'

/**
 * Shared geometry for the two time grids: the availability week view (columns
 * are days) and the location day view (columns are courts). Keeping the hours,
 * row height, and percentage maths in one place is what makes them read as the
 * same object rather than two similar-looking tables.
 */

/** Courts are unusable before dawn and after dark, and a 6am-10pm window keeps
 *  rows tall enough to hit accurately on a phone. */
export const DAY_START_MIN = 6 * 60
export const DAY_END_MIN = 22 * 60
export const STEP_MIN = 30
export const SLOT_COUNT = (DAY_END_MIN - DAY_START_MIN) / STEP_MIN
export const SPAN_MIN = DAY_END_MIN - DAY_START_MIN
export const ROW_HEIGHT = 20
export const GRID_HEIGHT = SLOT_COUNT * ROW_HEIGHT

/** Vertical position of a minute-of-day, as a percentage of the grid. */
export function minuteToPercent(minute: number): number {
  return ((clampMinute(minute) - DAY_START_MIN) / SPAN_MIN) * 100
}

export function clampMinute(minute: number): number {
  return Math.min(DAY_END_MIN, Math.max(DAY_START_MIN, minute))
}

/** Top and height percentages for a block spanning two minutes-of-day. */
export function blockBounds(startMinute: number, endMinute: number) {
  const top = minuteToPercent(startMinute)
  const height = minuteToPercent(endMinute) - top
  return { top, height: Math.max(height, 3) }
}

export function TimeGutter() {
  const labels: number[] = []
  for (let minute = DAY_START_MIN; minute <= DAY_END_MIN; minute += 120) labels.push(minute)

  return (
    <div className="relative w-12 shrink-0" style={{ height: GRID_HEIGHT }}>
      {labels.map((minute) => (
        <div
          key={minute}
          className="absolute right-1 -translate-y-1/2 text-[10px] text-ink-soft"
          style={{ top: `${minuteToPercent(minute)}%` }}
        >
          {formatMinuteOfDay(minute).replace(':00', '')}
        </div>
      ))}
    </div>
  )
}

/** The horizontal half-hour rules inside a single column. */
export function GridLines({ column }: { column?: number }) {
  return (
    <>
      {Array.from({ length: SLOT_COUNT }, (_, i) => (
        <div
          key={i}
          data-slot={column === undefined ? undefined : `${column}:${DAY_START_MIN + i * STEP_MIN}`}
          className={
            i % 2 === 1
              ? 'h-5 border-b border-sand-200'
              : 'h-5 border-b border-dashed border-sand-100'
          }
        />
      ))}
    </>
  )
}


// ---------------------------------------------------------------------------
// Drag selection
// ---------------------------------------------------------------------------

export type GridSelection = {
  column: number
  startMinute: number
  endMinute: number
}

type DragState = { column: number; from: number; to: number }

/**
 * Click-and-drag range selection over a column grid, shared by the
 * availability week view and the location day view.
 *
 * The column is fixed at pointer-down: dragging sideways would make the
 * selection ambiguous, and one column at a time is what people expect from a
 * calendar.
 */
export function useColumnDrag({
  columnCount,
  disabled,
  onSelect,
}: {
  columnCount: number
  disabled?: boolean
  onSelect: (selection: GridSelection) => void
}) {
  const gridRef = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<DragState | null>(null)

  const locate = useCallback(
    (clientX: number, clientY: number) => {
      const grid = gridRef.current
      if (!grid) return null
      const rect = grid.getBoundingClientRect()
      const column = Math.floor(((clientX - rect.left) / rect.width) * columnCount)
      const slot = Math.floor(((clientY - rect.top) / rect.height) * SLOT_COUNT)
      if (column < 0 || column >= columnCount) return null
      return { column, slot: Math.min(SLOT_COUNT - 1, Math.max(0, slot)) }
    },
    [columnCount],
  )

  // A drag interrupted by tab-switching should not stick to the pointer.
  useEffect(() => {
    if (!drag) return
    const cancel = () => setDrag(null)
    window.addEventListener('blur', cancel)
    return () => window.removeEventListener('blur', cancel)
  }, [drag])

  const gridProps = {
    ref: gridRef,
    onPointerDown(event: React.PointerEvent) {
      if (disabled) return
      // Existing blocks and the popover live inside the grid, so a bare
      // pointerdown here would start a drag on top of them -- and the
      // preventDefault below would swallow their click entirely.
      const target = event.target as HTMLElement
      if (target.closest('[data-entry]') || target.closest('[data-popover]')) return
      const hit = locate(event.clientX, event.clientY)
      if (!hit) return
      event.preventDefault()
      ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
      setDrag({ column: hit.column, from: hit.slot, to: hit.slot })
    },
    onPointerMove(event: React.PointerEvent) {
      if (!drag) return
      const hit = locate(event.clientX, event.clientY)
      if (!hit) return
      setDrag({ ...drag, to: hit.slot })
    },
    onPointerUp() {
      if (!drag) return
      const first = Math.min(drag.from, drag.to)
      const last = Math.max(drag.from, drag.to)
      setDrag(null)
      onSelect({
        column: drag.column,
        startMinute: DAY_START_MIN + first * STEP_MIN,
        endMinute: DAY_START_MIN + (last + 1) * STEP_MIN,
      })
    },
    onPointerCancel() {
      setDrag(null)
    },
  }

  return { gridProps, drag }
}

/** The live rectangle drawn while dragging. */
export function DragPreview({ drag }: { drag: { from: number; to: number } }) {
  const first = Math.min(drag.from, drag.to)
  const last = Math.max(drag.from, drag.to)
  const startMinute = DAY_START_MIN + first * STEP_MIN
  const endMinute = DAY_START_MIN + (last + 1) * STEP_MIN
  const { top, height } = blockBounds(startMinute, endMinute)

  return (
    <div
      className="pointer-events-none absolute inset-x-0.5 z-10 rounded border-2 border-pinon-600 bg-pinon-500/40 px-1 text-[10px] font-semibold text-pinon-700"
      style={{ top: `${top}%`, height: `${height}%` }}
    >
      {formatMinuteOfDay(startMinute).replace(' ', '')}–{formatMinuteOfDay(endMinute).replace(' ', '')}
    </div>
  )
}

/** A confirmed-but-unsaved selection, kept on the grid while you decide. */
export function PendingBlock({
  startMinute,
  endMinute,
  label,
}: {
  startMinute: number
  endMinute: number
  label?: string
}) {
  const { top, height } = blockBounds(startMinute, endMinute)
  return (
    <div
      data-pending
      className="pointer-events-none absolute inset-x-0.5 z-10 rounded border-2 border-dashed border-pinon-700 bg-pinon-500/60 px-1 text-[10px] leading-tight font-semibold text-white"
      style={{ top: `${top}%`, height: `${height}%` }}
    >
      {label ?? formatMinuteOfDay(startMinute).replace(' ', '')}
    </div>
  )
}

/**
 * Pins a card beside the column it refers to, docking to the bottom of the
 * viewport on narrow screens where there is no room beside anything.
 *
 * One positioned element, not a positioned wrapper around a positioned card:
 * nesting them made `left` a percentage of a shrink-wrapped box, which pushed
 * the card off the edge. The coordinates live in CSS variables so they only
 * take effect at the `sm` breakpoint.
 */
export function GridPopover({
  column,
  columnCount,
  startMinute,
  maxHeight = 230,
  children,
}: {
  column: number
  columnCount: number
  startMinute: number
  maxHeight?: number
  children: React.ReactNode
}) {
  // Flip to the left of the column past the midpoint so the card never hangs
  // off the right edge of the grid.
  const flip = column > (columnCount - 1) / 2
  const left = ((flip ? column : column + 1) / columnCount) * 100
  const rawTop = (minuteToPercent(startMinute) / 100) * GRID_HEIGHT
  const top = Math.min(rawTop, Math.max(0, GRID_HEIGHT - maxHeight))

  return (
    <div
      data-popover
      className={`pointer-events-auto fixed inset-x-3 bottom-3 z-30 sm:absolute sm:inset-x-auto sm:bottom-auto sm:w-64 sm:left-[var(--pop-x)] sm:top-[var(--pop-y)] ${
        flip ? 'sm:-translate-x-full sm:-ml-2' : 'sm:ml-2'
      }`}
      style={{
        ['--pop-x' as string]: `${left}%`,
        ['--pop-y' as string]: `${top}px`,
      }}
    >
      {children}
    </div>
  )
}
