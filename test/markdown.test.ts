import { describe, expect, it } from 'vitest'
import { escapeHtml, markdownSummary, markdownToText, renderMarkdown } from '~/server/markdown'

/**
 * The renderer's whole safety argument is that escaping happens before any
 * formatting rule runs, so no unescaped input can reach the output. These
 * tests are what holds that argument up — if a rule is ever added that formats
 * before escaping, one of them fails.
 */

describe('never emitting markup the author did not get through a rule', () => {
  it('escapes a script tag rather than stripping it', () => {
    const html = renderMarkdown('<script>alert(1)</script>')
    expect(html).not.toContain('<script')
    // Shown, not swallowed: the organizer can see what they actually typed.
    expect(html).toContain('&lt;script&gt;')
  })

  it('escapes an event handler smuggled through an img tag', () => {
    const html = renderMarkdown('<img src=x onerror="alert(1)">')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('onerror="')
  })

  it('refuses a javascript: link and leaves the text as typed', () => {
    const html = renderMarkdown('[click me](javascript:alert(1))')
    expect(html).not.toContain('href')
    expect(html).toContain('[click me]')
  })

  it('refuses a data: link', () => {
    expect(renderMarkdown('[x](data:text/html;base64,PHNjcmlwdD4=)')).not.toContain('href')
  })

  it('refuses a scheme-relative link, which inherits the page scheme', () => {
    expect(renderMarkdown('[x](//evil.test/)')).not.toContain('href')
  })

  it('cannot break out of the href attribute', () => {
    const html = renderMarkdown('[x](https://a.test/?q=" onmouseover="alert(1))')
    expect(html).not.toContain('onmouseover="alert')
  })

  it('escapes the four characters that matter, and only those', () => {
    expect(escapeHtml(`<a href="x">&</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;')
  })

  it('leaves a scheme intact through escaping, which is why the check works', () => {
    // If escapeHtml mangled ':' or '/', safeHref would be testing a different
    // string from the one a browser would see.
    expect(escapeHtml('javascript:alert(1)')).toBe('javascript:alert(1)')
  })
})

describe('the formatting that is supported', () => {
  it('renders paragraphs', () => {
    expect(renderMarkdown('one\n\ntwo')).toBe(
      '<p class="mb-3 last:mb-0">one</p><p class="mb-3 last:mb-0">two</p>',
    )
  })

  it('keeps single line breaks inside a paragraph, as a textarea implies', () => {
    expect(renderMarkdown('one\ntwo')).toContain('one<br />two')
  })

  it('renders the two heading levels', () => {
    expect(renderMarkdown('## Big')).toContain('<h2')
    expect(renderMarkdown('### Small')).toContain('<h3')
  })

  it('renders bullet and numbered lists', () => {
    expect(renderMarkdown('- one\n- two')).toContain('<ul')
    expect(renderMarkdown('- one\n- two')).toContain('<li>one</li><li>two</li>')
    expect(renderMarkdown('1. one\n2. two')).toContain('<ol')
  })

  it('does not turn a mixed block into a list', () => {
    // One marked line among prose is prose, not a list with a stray item.
    expect(renderMarkdown('Bring:\n- balls')).not.toContain('<ul')
  })

  it('renders bold and italic', () => {
    expect(renderMarkdown('**loud**')).toContain('<strong>loud</strong>')
    expect(renderMarkdown('_quiet_')).toContain('<em>quiet</em>')
  })

  it('leaves an underscore inside a word alone', () => {
    // snake_case_names are not emphasis.
    expect(renderMarkdown('snake_case_name')).not.toContain('<em>')
  })

  it('renders an http(s) link', () => {
    const html = renderMarkdown('[book](https://example.test/a)')
    expect(html).toContain('href="https://example.test/a"')
    expect(html).toContain('>book</a>')
  })

  it('leaves an unbalanced marker as literal text', () => {
    expect(renderMarkdown('**not closed')).toContain('**not closed')
    expect(renderMarkdown('[label](')).toContain('[label](')
  })

  it('produces nothing at all for empty input', () => {
    expect(renderMarkdown('')).toBe('')
    expect(renderMarkdown('   \n\n  ')).toBe('')
  })
})

describe('the plain-text form, for emails and the bell', () => {
  it('drops the markers without escaping anything', () => {
    expect(markdownToText('## Cardio Tennis\n\n**Bring** water')).toBe(
      'Cardio Tennis\n\nBring water',
    )
  })

  it('keeps a link readable by writing the URL out', () => {
    expect(markdownToText('[book](https://example.test/a)')).toBe('book (https://example.test/a)')
  })

  it('leaves a refused link exactly as typed', () => {
    expect(markdownToText('[x](javascript:alert(1))')).toContain('[x](javascript:')
  })

  it('summarises to one line, with an ellipsis when it had to cut', () => {
    expect(markdownSummary('## Title\n\nShort body.')).toBe('Title Short body.')
    const long = markdownSummary('a'.repeat(300))
    expect(long).toHaveLength(140)
    expect(long.endsWith('…')).toBe(true)
  })
})
