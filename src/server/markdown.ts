/**
 * A small, deliberately incomplete Markdown renderer for clinic descriptions.
 *
 * **Escape first, then format.** The entire input is HTML-escaped before any
 * rule runs, and every rule afterwards only ever recognises patterns in the
 * already-escaped text. No path exists by which raw input reaches the output,
 * so there is nothing for a sanitizer to catch and nothing to get wrong later:
 * a new rule added to this file cannot introduce an injection, because there
 * is no unescaped input left to inject.
 *
 * That also means anything unrecognised is shown literally rather than
 * stripped. An organizer typing `<3` gets `<3`, not a swallowed tag.
 *
 * There is no `@tailwindcss/typography` plugin in this project, so classes go
 * on each tag rather than relying on a `prose` wrapper.
 */

const CLASSES = {
  h2: 'mt-6 mb-2 text-xl font-bold first:mt-0',
  h3: 'mt-5 mb-2 text-lg font-bold first:mt-0',
  p: 'mb-3 last:mb-0',
  ul: 'mb-3 list-disc space-y-1 pl-5 last:mb-0',
  ol: 'mb-3 list-decimal space-y-1 pl-5 last:mb-0',
  a: 'text-pinon-600 underline',
} as const

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Only http(s), and only in that exact form.
 *
 * Checked against the *escaped* text, which is safe to do because escaping
 * touches none of the characters a scheme is made of — `javascript:alert(1)`
 * comes out of `escapeHtml` unchanged, so a scheme that would survive to the
 * browser is still visible here.
 */
function safeHref(url: string): string | null {
  return /^https?:\/\/[^\s]+$/i.test(url) ? url : null
}

/** Inline rules, applied to text that has already been escaped. */
function inline(text: string): string {
  return (
    text
      // Links first: their label would otherwise pick up emphasis markers that
      // belong to the surrounding sentence.
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (whole, label: string, url: string) => {
        const href = safeHref(url)
        // A refused link keeps its literal text rather than vanishing, so an
        // organizer can see that what they typed didn't become a link.
        return href ? `<a href="${href}" class="${CLASSES.a}">${label}</a>` : whole
      })
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])_([^_]+)_(?=[\s).,!?]|$)/g, '$1<em>$2</em>')
  )
}

type Block = { kind: 'ul' | 'ol'; items: string[] } | { kind: 'h2' | 'h3' | 'p'; text: string }

function blocksOf(escaped: string): Block[] {
  const blocks: Block[] = []

  for (const chunk of escaped.split(/\n\s*\n/)) {
    const lines = chunk.split('\n').map((l) => l.trim()).filter(Boolean)
    if (lines.length === 0) continue

    // A list is a run of marked lines; anything else in the chunk stays a
    // paragraph, so one stray line can't silently swallow the rest.
    if (lines.every((l) => /^[-*] /.test(l))) {
      blocks.push({ kind: 'ul', items: lines.map((l) => l.slice(2)) })
      continue
    }
    if (lines.every((l) => /^\d+\. /.test(l))) {
      blocks.push({ kind: 'ol', items: lines.map((l) => l.replace(/^\d+\. /, '')) })
      continue
    }

    // Tracked per chunk, not across the whole document: a blank line ends the
    // paragraph, which is the one thing every Markdown dialect agrees on.
    let paragraph: { kind: 'p'; text: string } | null = null

    for (const line of lines) {
      if (line.startsWith('### ') || line.startsWith('## ')) {
        paragraph = null
        const level = line.startsWith('### ') ? ('h3' as const) : ('h2' as const)
        blocks.push({ kind: level, text: line.slice(level === 'h3' ? 4 : 3) })
        continue
      }
      // Consecutive plain lines join into one paragraph with hard breaks,
      // which is what someone typing into a textarea expects.
      if (paragraph) paragraph.text += `<br />${line}`
      else {
        paragraph = { kind: 'p', text: line }
        blocks.push(paragraph)
      }
    }
  }

  return blocks
}

/** Render to an HTML fragment safe to pass to `dangerouslySetInnerHTML`. */
export function renderMarkdown(source: string): string {
  return blocksOf(escapeHtml(source))
    .map((block) => {
      const items =
        'items' in block ? block.items.map((i) => `<li>${inline(i)}</li>`).join('') : null
      const body = items ?? inline((block as { text: string }).text)
      return `<${block.kind} class="${CLASSES[block.kind]}">${body}</${block.kind}>`
    })
    .join('')
}

/**
 * The same content as plain text, for the text part of an email and for an
 * inbox entry. Markers are dropped rather than escaped — this output is never
 * HTML.
 */
export function markdownToText(source: string): string {
  return source
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (whole, label: string, url: string) =>
      safeHref(url) ? `${label} (${url})` : whole,
    )
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|[\s(])_([^_]+)_(?=[\s).,!?]|$)/g, '$1$2')
    .replace(/^#{2,3} /gm, '')
    .replace(/^[-*] /gm, '- ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** A one-line summary, for a card or a notification body. */
export function markdownSummary(source: string, limit = 140): string {
  const text = markdownToText(source).replace(/\s+/g, ' ').trim()
  return text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`
}
