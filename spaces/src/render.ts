// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// model → DOM. ONE renderer for the editor, the reader, print and (later) the
// file-manager preview, so those surfaces can never disagree about what a
// document looks like.
//
// The renderer emits REAL SEMANTIC TAGS — h1..h3, ul/ol/li, blockquote,
// pre>code, figure — never divs with classes. That buys the screen-reader
// story, native ⌘F, print fidelity and lossless markdown export at once, from
// one decision.

import { type SpacesDoc, type Page, type Block, isRemote } from './model'
import { sanitizeInline, inertBody, esc } from './sanitize'
import { tokenize } from './highlight'
import { t } from './i18n'
import { TAG_OF, LIST_OF, SPEC, TONE } from './blocks'
import { ICONS, type IconName } from './icons'

export interface RenderOpts {
  /** editable per-block hosts (the editor); false for reader/print */
  editable?: boolean
  /** resolve a page id to its title, for link chips and pagelink blocks */
  titleOf?: (pageId: string) => string | undefined
  /** collapsed toggles render OPEN — print always passes this */
  forceOpen?: boolean
  /** rendering to paper: no controls, because paper has no buttons */
  printing?: boolean
  /**
   * Has the READER agreed to load this remote url?
   *
   * A VIEWER-scoped decision, never a document field — the same rule as locale
   * and reduced motion. Putting consent in the file would mean the author
   * decides whether the reader phones home, which is precisely backwards, and
   * it would travel to the next person the file is mailed to.
   */
  allowRemote?: (src: string) => boolean
}

// The tag and list maps come from the block registry (blocks.ts), so a new
// block type declares its element once instead of being added here, to the /
// menu, to the autoformat table and to the markdown exporter separately.


/**
 * Render one page's blocks.
 *
 * Nesting is `Block.parent`, and the array is pre-order, so a child always
 * follows its parent. That is what lets a single forward pass build the tree
 * without a lookup table.
 */
export function renderBlocks(page: Page, doc: SpacesDoc, opts: RenderOpts = {}): DocumentFragment {
  const frag = document.createDocumentFragment()
  // stack of open containers, innermost last: [blockId, element]
  const stack: Array<[string, HTMLElement]> = []
  let list: { el: HTMLElement; kind: 'ul' | 'ol'; under: string } | null = null

  const hostFor = (parent: string | undefined): HTMLElement | DocumentFragment => {
    while (stack.length && stack[stack.length - 1][0] !== parent) stack.pop()
    return stack.length ? stack[stack.length - 1][1] : frag
  }

  for (const b of page.blocks) {
    const host = hostFor(b.parent)
    const kind = LIST_OF[b.type]

    // adjacent same-kind list items share one <ul>/<ol>
    if (kind) {
      if (!list || list.kind !== kind || list.under !== (b.parent ?? '')) {
        const el: HTMLElement = document.createElement(kind)
        el.className = 'sp-list'
        host.appendChild(el)
        list = { el, kind, under: b.parent ?? '' }
      }
    } else {
      list = null
    }

    const node = renderBlock(b, doc, opts)
    ;(kind && list ? list.el : host).appendChild(node)

    // A CONTAINER owns the blocks whose parent is its id. Which types those are
    // is registry data (blocks.ts `container`), not a name test here — the
    // second container type is what turned `b.type === 'toggle'` from a fact
    // into a bug waiting for the third one.
    const container = SPEC.get(b.type)?.container
    if (container) {
      const body = document.createElement('div')
      body.className = `sp-${b.type}-body`
      if (container === 'fold' && !(opts.forceOpen || b.open)) body.hidden = true
      node.appendChild(body)
      stack.push([b.id, body])
      list = null
    } else if (kind) {
      // A LIST ITEM OWNS ITS INDENTED CHILDREN.
      //
      // Tab already wrote `parent` (editor.indent), and nothing rendered it:
      // only registry containers opened a body, so an indented bullet came out
      // flat and Tab was a key that did nothing you could see. The <li> IS the
      // host — that is what HTML nesting is — so a child list starts inside it
      // and `list.under` changing is what makes the grouping open a fresh
      // <ul>/<ol> at the deeper level.
      //
      // Not `container: true` in the registry: a list item does not take a body
      // div, it takes children directly, and the gutter/inline-host rules that
      // `container` implies are wrong for it.
      stack.push([b.id, node])
    }
  }
  return frag
}

export function renderBlock(b: Block, doc: SpacesDoc, opts: RenderOpts = {}): HTMLElement {
  const type = b.type
  const el = document.createElement(TAG_OF[type] ?? 'div')
  el.dataset.blockId = b.id
  el.dataset.type = type
  el.className = `sp-b sp-b-${type}`

  switch (type) {
    case 'divider':
      el.className = 'sp-b sp-b-divider'
      el.appendChild(document.createElement('hr'))
      return el

    case 'code': {
      const pre = document.createElement('pre')
      const code = document.createElement('code')
      // `language-xx` is the convention every markdown pipeline already reads,
      // and it carries the author's raw tag even when this build cannot
      // highlight it. esc() because it lands in a class attribute.
      if (b.lang) code.className = `language-${esc(String(b.lang))}`
      if (opts.editable) { code.contentEditable = 'true'; code.dataset.edit = b.id }
      paintCode(code, textFromHtml(b.html), b.lang)
      pre.appendChild(code)
      el.appendChild(pre)
      return el
    }

    case 'image': {
      const fig = document.createElement('figure')
      const rawSrc = String(b.src ?? '')

      // A REMOTE image is not loaded until the reader asks for it.
      //
      // Measured: a space carrying <img src="https://…/pixel.png"> requests it
      // on open. In a format whose whole point is that you can mail it, that is
      // a tracking pixel — the recipient's IP and the moment they opened your
      // document, delivered to whoever wrote the file. It also breaks PLATFORM
      // §1: no network is required to open a document.
      //
      // This costs authors nothing, because the editor never writes a remote
      // src: picked images are downscaled, interned by content hash and stored
      // as `asset:`. Only hand- or agent-authored documents carry URLs, and for
      // those the reader gets a placeholder naming the host and a button. One
      // click, per image, informed — the model every mail client settled on.
      if (isRemote(rawSrc) && !opts.allowRemote?.(rawSrc)) {
        fig.appendChild(remoteImagePlaceholder(rawSrc, b, opts))
        if (b.caption) {
          const cap = document.createElement('figcaption')
          cap.innerHTML = sanitizeInline(String(b.caption))
          fig.appendChild(cap)
        }
        el.appendChild(fig)
        return el
      }

      const img = document.createElement('img')
      img.src = resolveSrc(rawSrc, doc)
      img.alt = String(b.alt ?? '')
      if (b.width) img.style.width = `${Math.max(10, Math.min(100, Number(b.width)))}%`
      // intrinsic size holds the aspect box while the image decodes, so the
      // page does not reflow under the reader's cursor
      if (b.w && b.h) { img.width = Number(b.w); img.height = Number(b.h) }
      fig.appendChild(img)
      if (b.caption) {
        const cap = document.createElement('figcaption')
        cap.innerHTML = sanitizeInline(String(b.caption))
        fig.appendChild(cap)
      }
      el.appendChild(fig)
      return el
    }

    case 'pagelink': {
      const a = document.createElement('a')
      const target = String(b.page ?? '')
      a.href = `#p/${target}`
      a.className = 'sp-pagecard'
      const title = opts.titleOf?.(target)
      a.textContent = title ?? '(missing page)'
      if (!title) a.classList.add('sp-dead')
      el.appendChild(a)
      return el
    }

    case 'todo': {
      const box = document.createElement('input')
      box.type = 'checkbox'
      box.checked = !!b.done
      box.className = 'sp-check'
      // the checkbox is a control, not text: it must not be inside the
      // editable host or typing would land in it
      el.appendChild(box)
      el.appendChild(inlineHost(b, opts))
      if (b.done) el.classList.add('sp-done')
      return el
    }

    case 'callout': {
      const raw = String(b.tone ?? 'note')
      const known = TONE.has(raw) ? raw : 'note'
      // Only a KNOWN tone reaches the class name. An unrecognised one keeps the
      // neutral treatment (and its own word as the label) — and a class built
      // from an arbitrary string out of a mailed file is a thing not to have.
      el.className = `sp-b sp-b-callout sp-tone-${known}`

      // The chip is the tone control when there is an editor to change it in,
      // and a plain label otherwise — reading view, print and a locked space
      // must not paint a button that does nothing.
      const chip = document.createElement(opts.editable ? 'button' : 'span')
      chip.className = 'sp-callout-chip'
      if (chip instanceof HTMLButtonElement) {
        chip.type = 'button'
        chip.title = t('Change the kind of callout')
      }
      const mark = document.createElement('span')
      mark.className = 'sp-callout-mark'
      calloutMark(mark, b, known)
      const label = document.createElement('span')
      label.className = 'sp-callout-label'
      // NOT aria-hidden and never a ::before: the tone is content the way a
      // "Warning:" printed on a page is content. A screen reader reading this
      // page linearly must hear it, and a printout must carry it.
      label.textContent = toneLabel(raw)
      chip.append(mark, label)
      el.appendChild(chip)
      el.appendChild(inlineHost(b, opts))
      return el
    }

    case 'toggle': {
      const twist = document.createElement('button')
      twist.className = 'sp-twist'
      twist.type = 'button'
      twist.setAttribute('aria-expanded', String(!!(opts.forceOpen || b.open)))
      twist.setAttribute('aria-label', 'Toggle section')
      twist.textContent = '▸'
      el.appendChild(twist)
      el.appendChild(inlineHost(b, opts))
      return el
    }

    default:
      el.appendChild(inlineHost(b, opts))
      return el
  }
}

/**
 * A callout tone's name, in the reader's language.
 *
 * Written out as t() calls rather than read from a table in blocks.ts: the i18n
 * sweep (scripts/build-spaces-i18n.mjs) collects t() calls with a LITERAL
 * STRING out of the source, so a name held as data would ship English to all
 * eight locales. A tone with no case here fails scripts/test-spaces-model.ts.
 *
 * (The sweep reads comments too, so do not write an example call in one.)
 *
 * An UNRECOGNISED tone returns its own word. A file from a future build that
 * says `success` should say "success", not "Note" — the label is the one place
 * that can tell the reader the truth about a tone we cannot draw.
 */
export function toneLabel(tone: string): string {
  switch (tone) {
    case 'note': return t('Note')
    case 'tip': return t('Tip')
    case 'important': return t('Important')
    case 'warning': return t('Warning')
    case 'caution': return t('Caution')
    default: return tone
  }
}

/**
 * Fill a callout's mark: the author's override if there is one, else the tone's
 * own shape.
 *
 * The override follows the same rule as a page icon (editor.ts pageIcon) — a
 * name from the icon set, or any other string as literal TEXT, which is how an
 * emoji works. textContent, never innerHTML: this string came out of a file
 * someone sent you.
 *
 * `Object.hasOwn`, not `in`: ICONS is an object literal, so `'toString' in
 * ICONS` is TRUE and the lookup hands back a function, which would then be
 * stringified into the page as markup.
 */
function calloutMark(host: HTMLElement, b: Block, known: string): void {
  const custom = typeof b.icon === 'string' ? b.icon : ''
  if (custom) {
    if (Object.hasOwn(ICONS, custom)) host.innerHTML = ICONS[custom as IconName]
    else host.textContent = custom
    return
  }
  host.innerHTML = ICONS[(TONE.get(known) ?? TONE.get('note')!).icon]
}

/** The editable text host. Per-block, never one big editable container — that
 *  is what keeps Selection block-scoped and stops a merge re-minting ids. */
function inlineHost(b: Block, opts: RenderOpts): HTMLElement {
  const inner = document.createElement('span')
  inner.className = 'sp-text'
  inner.dataset.edit = b.id
  // direction is per-block from the CONTENT, inside a container pinned by the
  // document's theme.dir — PLATFORM §8's two-layer rule
  inner.dir = 'auto'
  if (opts.editable) inner.contentEditable = 'true'
  inner.innerHTML = sanitizeInline(b.html ?? '')
  if (!b.html) inner.dataset.empty = '1'
  return inner
}

// Untrusted html — parse INERT. A detached div still loads what it creates,
// so `<img src="404" onerror>` in a code block would run its handler here.
// See sanitize.ts inertBody().
const textFromHtml = (html: string | undefined): string => {
  if (!html) return ''
  return inertBody(html).textContent ?? ''
}

/**
 * Paint highlighted code into a `<code>` element — the ONE place colour is
 * applied, so the editor, the reader and print can never disagree.
 *
 * NOTHING IS BUILT AS A STRING. `tokenize` returns ranges into `text`, and
 * every node here comes from `createTextNode`/`textContent`. Code is text
 * someone mailed you; the model never gains markup and neither does the DOM.
 *
 * IT RECONCILES RATHER THAN REPLACING, and that is the whole answer to
 * highlighting a live contenteditable. On `input` the browser has ALREADY
 * applied the keystroke to the DOM, so re-tokenising the same text usually
 * yields byte-identical nodes: typing inside a string, a comment or an
 * identifier changes that token's text and nothing else, the existing text node
 * already holds the new value, and this function performs ZERO mutations. The
 * caret is not restored because it was never disturbed.
 *
 * Only a keystroke that moves a token BOUNDARY — opening a quote, completing a
 * keyword — restructures anything, and then `changed` is true and the caller
 * puts the caret back by character offset. Assigning `Text.data` wholesale is
 * specified to collapse a live range inside it to offset 0, so a restore is
 * genuinely required there; it is just rare.
 *
 * Returns whether the DOM changed.
 */
export function paintCode(code: HTMLElement, text: string, lang?: unknown): boolean {
  let changed = false
  let node: ChildNode | null = code.firstChild

  for (const tk of tokenize(text, lang)) {
    const s = text.slice(tk.a, tk.b)
    if (tk.k) {
      const cls = `sp-t-${tk.k}`
      const fit = node?.nodeType === 1 && (node as HTMLElement).className === cls &&
        node.firstChild?.nodeType === 3 && !node.firstChild.nextSibling
      if (fit) {
        if (node!.firstChild!.nodeValue !== s) { (node!.firstChild as Text).data = s; changed = true }
      } else {
        const span = document.createElement('span')
        span.className = cls
        span.textContent = s
        code.insertBefore(span, node)
        changed = true
        continue   // `node` still has to be matched against the NEXT token
      }
    } else if (node?.nodeType === 3) {
      if (node.nodeValue !== s) { (node as Text).data = s; changed = true }
    } else {
      code.insertBefore(document.createTextNode(s), node)
      changed = true
      continue
    }
    node = node!.nextSibling
  }

  while (node) { const next = node.nextSibling; node.remove(); node = next; changed = true }
  return changed
}

export function resolveSrc(src: string, doc: SpacesDoc): string {
  // hasOwn, not a bare index: `assets['toString']` returns a FUNCTION, which is
  // truthy, so the `?? ''` never fired and the stringified function was assigned
  // to img.src. Same class as the icon lookup — an author-supplied key reaching
  // a lookup table through the prototype chain.
  if (src.startsWith('asset:')) {
    const key = src.slice(6)
    const table = doc.assets
    return table && Object.hasOwn(table, key) ? table[key] : ''
  }
  return src
}


/** The host a reader is being asked to trust, or the raw src if it will not parse. */
function remoteHost(src: string): string {
  try { return new URL(src, 'https://x.invalid').host || src } catch { return src }
}

/**
 * What stands in for an unloaded remote image: what it is, WHERE it would come
 * from, and a button. Naming the host is the point — "load images" with no
 * indication of who is being contacted is not consent.
 */
function remoteImagePlaceholder(src: string, b: Block, opts: RenderOpts): HTMLElement {
  const box = document.createElement('div')
  box.className = 'sp-remote'
  box.dataset.remoteSrc = src

  const line = document.createElement('div')
  line.className = 'sp-remote-line'
  line.textContent = t('Image from {host}', { host: remoteHost(src) })
  box.appendChild(line)

  const why = document.createElement('div')
  why.className = 'sp-remote-why'
  why.textContent = t('Not loaded — opening it would tell that site you opened this space.')
  box.appendChild(why)

  const alt = String(b.alt ?? '')
  if (alt) {
    const a = document.createElement('div')
    a.className = 'sp-remote-alt'
    a.textContent = alt
    box.appendChild(a)
  }

  // `allowRemote` is passed by print too, so this clause was always truthy there
  // and paper carried a live "Load this image" button. Print asks for it
  // explicitly instead.
  if (opts.printing !== true && (opts.editable !== false || opts.allowRemote)) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'sp-btn sp-remote-load'
    btn.textContent = t('Load this image')
    btn.dataset.loadRemote = src
    box.appendChild(btn)
  }
  return box
}

/**
 * A whole page, including its title. The OUTER wrapper stays ltr — scrollLeft
 * and every coordinate calculation change meaning under rtl — and the INNER
 * container carries the document's declared base direction.
 */
export function renderPage(page: Page, doc: SpacesDoc, opts: RenderOpts = {}): HTMLElement {
  const art = document.createElement('article')
  art.className = 'sp-page'
  art.style.direction = 'ltr'

  const inner = document.createElement('div')
  inner.className = 'sp-page-inner'
  inner.dir = doc.theme.dir ?? 'ltr'
  if (doc.theme.measure) inner.style.maxWidth = `${doc.theme.measure}px`

  const h = document.createElement('h1')
  h.className = 'sp-title'
  h.dataset.pageTitle = page.id
  h.dir = 'auto'
  if (opts.editable) h.contentEditable = 'true'
  h.textContent = page.title
  inner.appendChild(h)

  inner.appendChild(renderBlocks(page, doc, opts))
  art.appendChild(inner)
  return art
}
