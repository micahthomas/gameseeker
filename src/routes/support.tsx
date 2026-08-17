import { createFileRoute } from '@tanstack/react-router'

/**
 * Where the donate link lives. Deliberately a plain constant rather than a
 * `vars` entry in wrangler.jsonc: it is public information, it is the same in
 * every environment, and putting it in config would mean a named environment
 * could silently drop it (named environments inherit nothing).
 */
const KOFI_URL = 'https://ko-fi.com/micahthomas'

export const Route = createFileRoute('/support')({
  head: () => ({
    meta: [
      { title: 'Support GameSeeker' },
      {
        name: 'description',
        content:
          'GameSeeker is free to use and free to run, except for the domain and text messages. Chip in if it has found you a game.',
      },
    ],
  }),
  component: Support,
})

function Support() {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold">Support GameSeeker</h1>
        <p className="hint mt-2">
          GameSeeker is free to use, has no ads, and shows your contact details to nobody. It's a
          neighborhood tool, not a business.
        </p>
      </header>

      <section className="card space-y-3 p-4">
        <h2 className="font-semibold">What it actually costs</h2>
        <p className="text-sm">
          Almost nothing, most months. The app runs on Cloudflare's free tier — the server, the
          database, and the scheduled jobs all fit inside it comfortably at Santa Fe's size — and
          sign-in emails are free at the volume we send.
        </p>
        <p className="text-sm">
          The two things that do cost money are the <strong>gameseeker.app domain</strong>, renewed
          once a year, and <strong>text messages</strong>. SMS is the one feature that isn't free at
          any volume: every carrier charges per message, plus a monthly fee for the number itself.
          That's the honest reason game alerts go out by email today and texting is still switched
          off — the code for it is written and waiting.
        </p>
      </section>

      <section className="card space-y-3 p-4">
        <h2 className="font-semibold">Chip in</h2>
        <p className="text-sm">
          If GameSeeker has found you a game, a one-off tip covers a stretch of running costs.
          There's no membership, nothing is gated behind it, and a game will never fill faster
          because someone donated.
        </p>
        <a
          href={KOFI_URL}
          target="_blank"
          rel="noreferrer"
          className="btn-primary w-full sm:w-auto"
        >
          Donate on Ko-fi
        </a>
        <p className="hint">
          Goes to Micah Thomas, who builds and pays for this. Ko-fi takes card and PayPal; no
          account needed to give.
        </p>
      </section>

      <section className="card space-y-3 p-4">
        <h2 className="font-semibold">Other ways to help</h2>
        <ul className="list-disc space-y-2 pl-5 text-sm">
          <li>
            <strong>Post your availability and keep it current.</strong> The whole thing only works
            if there are enough people to match against, and stale times are worse than none.
          </li>
          <li>
            <strong>Tell someone at the court about it.</strong> Every player who joins makes
            everyone else's games easier to fill.
          </li>
          <li>
            <strong>Report a court that's wrong</strong> — closed, resurfaced, miscounted. The court
            list was checked by hand and against aerial imagery, but parks change.
          </li>
          <li>
            <strong>The code is open.</strong> Bugs and pull requests are welcome at{' '}
            <a
              href="https://github.com/micahthomas/gameseeker"
              target="_blank"
              rel="noreferrer"
              className="font-semibold text-pinon-600 hover:underline"
            >
              github.com/micahthomas/gameseeker
            </a>
            .
          </li>
        </ul>
      </section>
    </div>
  )
}
