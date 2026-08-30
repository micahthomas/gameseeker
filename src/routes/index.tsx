import { Link, createFileRoute } from '@tanstack/react-router'
import { EmptyState, GameCard } from '~/components/GameCard'
import { fetchDashboard } from '~/fn/games'
import { formatDateTime } from '~/server/time'

export const Route = createFileRoute('/')({
  loader: () => fetchDashboard(),
  component: Dashboard,
})

function Dashboard() {
  const data = Route.useLoaderData()

  if (!data.signedIn) return <SignedOutLanding />

  return (
    <div className="space-y-8">
      <section>
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-xl font-bold">Your games</h1>
          <Link to="/games/new" className="btn-primary !px-3 !py-1.5 !text-sm sm:hidden">
            Host a game
          </Link>
        </div>
        <div className="mt-3 space-y-3">
          {data.myGames.length === 0 ? (
            <EmptyState title="Nothing on the calendar yet">
              <Link to="/games/new" className="underline">
                Host a game
              </Link>{' '}
              or claim an open spot below.
            </EmptyState>
          ) : (
            data.myGames.map((item) => <GameCard key={item.game.id} data={item} />)
          )}
        </div>
      </section>

      {data.myClinics.length > 0 ? (
        <section>
          <h2 className="text-xl font-bold">Your clinics</h2>
          <ul className="mt-3 space-y-3" data-testid="my-clinics">
            {data.myClinics.map(({ occurrence, clinic, locationName, courtName }) => (
              <li key={occurrence.id}>
                <Link
                  to="/clinics/$clinicId"
                  params={{ clinicId: clinic.id }}
                  className="card block p-4 transition-colors hover:border-pinon-500"
                >
                  <p className="font-semibold">{clinic.title}</p>
                  <p className="hint">
                    {formatDateTime(occurrence.startsAt)} · {locationName} · {courtName}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section>
        <h2 className="text-xl font-bold">Open at your level</h2>
        <p className="hint mt-1">
          Games looking for a player you match. Anyone can claim these — first to confirm plays.
        </p>
        <div className="mt-3 space-y-3">
          {data.openGames.length === 0 ? (
            <EmptyState title="No open games right now">
              Add your{' '}
              <Link to="/availability" className="underline">
                available times
              </Link>{' '}
              and you'll get notified the moment one is posted.
            </EmptyState>
          ) : (
            data.openGames.map((item) => <GameCard key={item.game.id} data={item} />)
          )}
        </div>
      </section>

      <section>
        <h2 className="text-xl font-bold">Around town</h2>
        <p className="hint mt-1">Everything scheduled on Santa Fe courts.</p>
        <div className="mt-3 space-y-3">
          {data.upcoming.length === 0 ? (
            <EmptyState title="The courts are quiet" />
          ) : (
            data.upcoming.map((item) => <GameCard key={item.game.id} data={item} />)
          )}
        </div>
      </section>
    </div>
  )
}

function SignedOutLanding() {
  return (
    <div className="space-y-8 py-6">
      <section className="text-center">
        <p className="text-5xl">🎾</p>
        <h1 className="mt-4 text-3xl font-bold tracking-tight">Find a tennis game in Santa Fe</h1>
        <p className="hint mx-auto mt-3 max-w-md">
          Post the times you're free. When someone hosts a game at your level in one of those
          windows, you get a message. First to confirm gets the spot.
        </p>
        <Link to="/login" className="btn-primary mt-6">
          Get started
        </Link>
      </section>

      <section className="grid gap-3 sm:grid-cols-3">
        <Step n={1} title="Set your level">
          NTRP or UTR — we translate between them so everyone matches on one scale.
        </Step>
        <Step n={2} title="Share your times">
          Weekly patterns like "Tuesdays 5–7" plus one-offs, and blackouts when you're away.
        </Step>
        <Step n={3} title="Play">
          Host a game and pick a court, or claim a spot someone else opened up.
        </Step>
      </section>

      <p className="hint text-center">
        Covering the public courts at Salvador Perez, Herb Martinez, Alto Park, Larragoite, and
        Atalaya — plus the Chavez Center and the Tennis &amp; Swim Club.
      </p>
    </div>
  )
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className="card p-4">
      <span className="chip bg-pinon-100 text-pinon-700">Step {n}</span>
      <p className="mt-2 font-semibold">{title}</p>
      <p className="hint mt-1">{children}</p>
    </div>
  )
}
