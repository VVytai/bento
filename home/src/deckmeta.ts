// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Reading a Bento file's identity WITHOUT running it.
//
// Home shows a deck's title and which app wrote it. Getting that must never
// involve executing the file: a `.bento.html` is arbitrary HTML with arbitrary
// script, and home holds a store of writable file handles. Anything that ran
// deck code on home's origin would hand that store to the deck.
//
// So this is pure text work. The splice contract (docs/PLATFORM.md §2) is what
// makes it possible: the document is always PLAINTEXT JSON in a `#bento-doc`
// block near the top of the file, in every Bento file ever shipped, precisely
// so that tools which are not Bento can read and rewrite it. Home is such a
// tool. It reads the first 256KB, finds the block, and parses it — no DOM, no
// script, no `document.write`.

/** Everything home wants to know about a file it did not open. */
export interface DeckMeta {
  /** `bento/slides`, `bento/spaces`, … — absent if this is not a Bento file */
  format?: string
  title?: string
  /** true when the body is a `bento/enc` envelope: title is not readable */
  encrypted?: boolean
  /** the app that wrote the shell, from <meta name="generator"> */
  generator?: string
}

/**
 * How much of the file to read.
 *
 * NOT enough to contain the whole document block, and it does not need to be.
 * A deck with two embedded photos runs to 720KB of JSON and one with video to
 * 3.2MB, so requiring the CLOSING tag before parsing anything would mean
 * reading whole multi-megabyte files to show a title — and, until this was
 * measured against real files, silently showing no title at all for every deck
 * that has an image in it. The identity fields sit at the very start of the
 * document (`title` is at a constant +38 bytes in every file checked), so a
 * small head read is enough as long as the parser does not insist on the end.
 */
const HEAD_BYTES = 256 * 1024

const OPEN = /<script[^>]*id=["']bento-doc["'][^>]*>/i
// An HTML parser ends a script element at `</script` followed by whitespace,
// `/` or `>` — so the close form carries no ">" here either (kernel/save.ts
// makes the same point about what counts as closing the block).
const CLOSE = '</script'
const GENERATOR = /<meta[^>]+name=["']generator["'][^>]+content=["']([^"']+)["']/i

/** Pull one leading string field out of a JSON prefix, escapes intact. */
function leadingString(json: string, key: string): string | undefined {
  const m = new RegExp(`"${key}"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*")`).exec(json)
  if (!m) return undefined
  try {
    return JSON.parse(m[1]) as string
  } catch {
    return undefined
  }
}

/**
 * Parse identity out of Bento file text.
 *
 * Returns `{}` for anything that is not recognisably a Bento file, rather than
 * throwing — home lists what it can and says nothing confident about the rest.
 */
export function metaFromText(head: string): DeckMeta {
  const out: DeckMeta = {}
  const gen = head.match(GENERATOR)
  if (gen) out.generator = gen[1]

  const open = OPEN.exec(head)
  if (!open) return out
  const start = open.index + open[0].length
  const close = head.toLowerCase().indexOf(CLOSE, start)
  // The block is `<`-escaped as < so it can never contain `</script>`;
  // JSON.parse handles that escape natively, so no un-escaping step is needed.
  const body = (close >= 0 ? head.slice(start, close) : head.slice(start)).trim()
  if (!body) return out // a pristine shell: real file, no document yet

  // Whole block in hand: parse it properly. Truncated (the common case for any
  // deck carrying images): read the leading fields off the prefix instead.
  let doc: Record<string, unknown> | null = null
  if (close >= 0) {
    try {
      doc = JSON.parse(body) as Record<string, unknown>
    } catch {
      /* not JSON — not a document block we understand */
    }
  }
  const format = doc ? doc.format : leadingString(body, 'format')
  const title = doc ? doc.title : leadingString(body, 'title')
  if (typeof format === 'string') out.format = format
  if (typeof title === 'string') out.title = title

  // A password-protected deck stores a `bento/enc` envelope here instead of the
  // document (kernel/save.ts `parseEnvelope`: format 'bento/enc', v, data,
  // salt, iv). There is no title to show, and not showing one is the point of
  // having encrypted it — a launcher listing "Q4 Board Review — encrypted"
  // would leak exactly what the password exists to hide.
  if (out.format === 'bento/enc') {
    out.encrypted = true
    delete out.title
  }
  return out
}

/** Read a file's identity. Reads only the head of the file, never all of it. */
export async function metaFromFile(file: File): Promise<DeckMeta> {
  const head = await file.slice(0, HEAD_BYTES).text()
  return metaFromText(head)
}

/** Does this look like a Bento document at all? */
export const isBento = (m: DeckMeta) => typeof m.format === 'string' && m.format.startsWith('bento/')

/** What to show as the entry's name. */
export const displayName = (m: DeckMeta, fileName: string) =>
  m.title?.trim() || fileName.replace(/\.bento\.html$/i, '').replace(/\.html$/i, '')
