import { Link, createFileRoute, notFound, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { FormError, errorMessage } from '~/components/ErrorPanel'
import { LevelChip, StatusChip } from '~/components/GameCard'
import { NotFound } from '~/components/NotFound'
import { callOffGame, claimGameSlot, dropOut, fetchGame } from '~/fn/games'
import { playsFormat } from '~/server/formats'
import { playsAtLevel, seekerLabel } from '~/server/rating'
import { formatRange, relativeTime } from '~/server/time'

export const Route = createFileRoute('/games/$gameId')({
  loader: async ({ params }) => {
    const game = await fetchGame({ data: { gameId: params.gameId } })
    if (!game) throw notFound()
    return game
  },
  notFoundComponent: () => <NotFound />,
  component: GameDetail,
})

function GameDetail() {
  const detail = Route.useLoaderData()
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const { game, viewer, slots } = detail
  const openSlots = slots.filter((s) => s.slot.status === 'open')
  const isPast = game.endsAt < Date.now()
  const canClaim =
    viewer &&
    !viewer.isParticipant &&
    !isPast &&
    game.status === 'open' &&
    // Mirrors the server rule in claimSlot: only mixed is gated on opt-in.
    (!game.isMixed || playsFormat(viewer.formats, game.format, true)) &&
    openSlots.some((s) =>
      s.slot.kind === 'invited'
        ? s.slot.invitedUserId === viewer.id
        : playsAtLevel(viewer.playLevels, s.slot.seekerNtrp ?? 0) &&
          (!s.slot.seekerGender || s.slot.seekerGender === viewer.gender),
    )

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
    <div className="mx-auto max-w-lg space-y-6">
      <header>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-lg font-bold capitalize">
            {game.isMixed ? 'Mixed doubles' : game.format}
          </span>
          <LevelChip min={game.minNtrp} max={game.maxNtrp} />
          <StatusChip status={game.status} openSlots={openSlots.length} />
        </div>
        <h1 className="mt-2 text-2xl font-bold">{formatRange(game.startsAt, game.endsAt)}</h1>
        <p className="hint">{isPast ? 'This game has finished.' : relativeTime(game.startsAt)}</p>
      </header>

      <section className="card p-4">
        <p className="font-semibold">
          <Link
            to="/locations/$locationId"
            params={{ locationId: detail.location.id }}
            className="hover:underline"
          >
            {detail.location.name}
          </Link>{' '}
          · {detail.court.name}
        </p>
        {detail.location.address ? <p className="hint">{detail.location.address}</p> : null}
        <div className="mt-2 flex flex-wrap gap-1.5">
          <span className="chip bg-sand-100 text-sand-700 capitalize">{detail.court.surface}</span>
          {detail.court.hasLights ? (
            <span className="chip bg-clay-100 text-clay-600">lights</span>
          ) : null}
        </div>
        {game.notes ? (
          <p className="mt-3 rounded-lg bg-sand-100 px-3 py-2 text-sm">{game.notes}</p>
        ) : null}
      </section>

      <section>
        <h2 className="text-lg font-bold">Players</h2>
        <ul className="mt-3 space-y-2">
          {slots.map(({ slot, player, invited }) => (
            <li key={slot.id} className="card flex items-center gap-3 p-3">
              {player ? (
                <>
                  <span className="grid size-9 shrink-0 place-items-center rounded-full bg-pinon-100 font-bold text-pinon-700">
                    {player.name.charAt(0).toUpperCase()}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold">
                      {player.name}
                      {slot.kind === 'host' ? (
                        <span className="hint font-normal"> · host</span>
                      ) : null}
                    </p>
                    <p className="hint">{player.ntrp.toFixed(1)} NTRP</p>
                  </div>
                </>
              ) : (
                <>
                  <span className="grid size-9 shrink-0 place-items-center rounded-full border-2 border-dashed border-sand-300 text-sand-600">
                    ?
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-ink-soft">
                      {slot.kind === 'invited'
                        ? `Waiting on ${invited?.name ?? 'an invited player'}`
                        : `${seekerLabel(slot.seekerNtrp ?? game.minNtrp)}${
                            slot.seekerGender ? ` · a ${slot.seekerGender}` : ''
                          }`}
                    </p>
                    <p className="hint">Open — first to confirm plays</p>
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      </section>

      <FormError message={error} />

      {!viewer ? (
        <Link to="/login" className="btn-primary w-full">
          Sign in to join
        </Link>
      ) : null}

      {canClaim ? (
        <button
          className="btn-primary w-full"
          disabled={busy}
          onClick={() => run(() => claimGameSlot({ data: { gameId: game.id } }))}
        >
          {busy ? 'Claiming…' : "I'm in — claim a spot"}
        </button>
      ) : null}

      {viewer?.isParticipant && !viewer.isHost && !isPast && game.status !== 'cancelled' ? (
        <button
          className="btn-secondary w-full"
          disabled={busy}
          onClick={() => run(() => dropOut({ data: { gameId: game.id } }))}
        >
          Drop out
        </button>
      ) : null}

      {viewer && (viewer.isHost || viewer.isAdmin) && !isPast && game.status !== 'cancelled' ? (
        <CancelBox busy={busy} onCancel={(reason) => run(() => callOffGame({ data: { gameId: game.id, reason } }))} />
      ) : null}

      {viewer && !viewer.isParticipant && !canClaim && game.status === 'open' && !isPast ? (
        <p className="hint text-center">
          This game is looking for{' '}
          {[...new Set(openSlots.map((s) => s.slot.seekerNtrp).filter(Boolean))]
            .map((n) => (n as number).toFixed(1))
            .join(' or ')}{' '}
          players. Add that level in your profile if you'd like these alerts.
        </p>
      ) : null}
    </div>
  )
}

function CancelBox({
  busy,
  onCancel,
}: {
  busy: boolean
  onCancel: (reason: string | undefined) => void
}) {
  const [confirming, setConfirming] = useState(false)
  const [reason, setReason] = useState('')

  if (!confirming) {
    return (
      <button className="btn-danger w-full" onClick={() => setConfirming(true)}>
        Cancel this game
      </button>
    )
  }

  return (
    <div className="card space-y-3 p-4">
      <p className="font-semibold">Cancel this game?</p>
      <p className="hint">
        Everyone who joined gets a message, and the court is released for someone else.
      </p>
      <input
        className="input"
        placeholder="Reason (optional) — e.g. rain"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <div className="flex gap-2">
        <button className="btn-secondary flex-1" onClick={() => setConfirming(false)}>
          Keep it
        </button>
        <button
          className="btn-danger flex-1"
          disabled={busy}
          onClick={() => onCancel(reason || undefined)}
        >
          {busy ? 'Cancelling…' : 'Cancel game'}
        </button>
      </div>
    </div>
  )
}
