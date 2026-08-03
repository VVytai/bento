// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Inline-html sanitizer + canonicalizer for block content.
//
// A block's `html` is INLINE ONLY. Block structure is `Block.type`, and the
// renderer emits the semantic tag — so a `<p>` or `<div>` inside a block's html
// is always a mistake, either a paste that smuggled structure in or a browser
// that inserted one during editing.
//
// This is a fork of slides' sanitizer, not a parameterisation, because the
// policies differ in BOTH directions: spaces must reject DIV/P (slides permits
// them) and spaces adds the suite's first attribute allowlist.

/** Inline tags a block may contain. Nothing here can carry block structure. */
const ALLOWED = new Set([
  'B', 'I', 'U', 'S', 'EM', 'STRONG', 'CODE', 'BR', 'SPAN', 'MARK', 'SUB', 'SUP', 'A',
])

/**
 * The only attribute any tag may keep, and only on `A`.
 *
 * MATCHED AGAINST `getAttribute('href')`, NEVER the `.href` IDL property.
 *
 * `.href` returns the RESOLVED ABSOLUTE url, so from file:// the stored
 * `#p/abc` reads back as `file:///…/space.html#p/abc` and fails this test —
 * stripping every internal link — while on a static host it becomes
 * `https://…#p/abc` and passes. Measured. The bug would be invisible in the
 * environment an author develops in and total in the two environments the
 * format exists for (file://, and bento/tray on iOS).
 *
 * `#p/` is an intra-space page link. There is deliberately no second fragment
 * form: an undefined entry in this list is a one-way data hazard, because an
 * href written under a permissive build gets STRIPPED by a stricter later one,
 * silently, on the next edit that touches the block.
 */
const HREF_OK = /^(https?:|mailto:|#p\/)/i

/** Tags whose CONTENT should survive when the tag itself is dropped. */
const UNWRAP = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'LI', 'UL', 'OL', 'H1', 'H2', 'H3', 'H4', 'BLOCKQUOTE', 'PRE', 'FONT'])

/**
 * Strip everything outside the allowlist, in place.
 *
 * Structure-carrying tags are UNWRAPPED (their text survives) rather than
 * deleted — losing a paragraph's words because it arrived wrapped in a `<p>`
 * would be the worst possible reading of "inline only".
 */
export function sanitizeInline(html: string): string {
  if (typeof document === 'undefined') return stripAllTags(html)
  const host = document.createElement('div')
  host.innerHTML = html

  const walk = (node: Node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === Node.TEXT_NODE) continue
      if (child.nodeType !== Node.ELEMENT_NODE) { child.remove(); continue }
      const el = child as HTMLElement
      const tag = el.tagName

      if (!ALLOWED.has(tag)) {
        walk(el)
        if (UNWRAP.has(tag)) {
          // a block boundary inside inline content becomes a space, not a join:
          // "<p>a</p><p>b</p>" must not become "ab"
          const needsGap = el.nextSibling || el.previousSibling
          while (el.firstChild) el.parentNode!.insertBefore(el.firstChild, el)
          if (needsGap) el.parentNode!.insertBefore(document.createTextNode(' '), el)
        }
        el.remove()
        continue
      }

      for (const attr of [...el.attributes]) {
        const keep = tag === 'A' && attr.name === 'href' && HREF_OK.test(attr.value)
        if (!keep) el.removeAttribute(attr.name)
      }
      // an <a> that lost its href is no longer a link — unwrap it
      if (tag === 'A' && !el.getAttribute('href')) {
        walk(el)
        while (el.firstChild) el.parentNode!.insertBefore(el.firstChild, el)
        el.remove()
        continue
      }
      // external links open away from the document; internal ones must not
      if (tag === 'A') {
        const href = el.getAttribute('href')!
        if (!href.startsWith('#')) { el.setAttribute('rel', 'noopener noreferrer'); el.setAttribute('target', '_blank') }
      }
      walk(el)
    }
  }
  walk(host)
  return host.innerHTML
}

/** No-DOM fallback (node tooling): drop every tag, keep the words. */
function stripAllTags(html: string): string {
  return html
    .replace(/<(p|div|br|li|h[1-6]|blockquote|pre)\b[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Canonical form, run at typing-run close (never mid-run — it would move the
 * caret).
 *
 * MUST BE IDEMPOTENT. A future materialize → DOM → re-serialize round trip
 * runs this again, and a canonicalizer that keeps changing its own output
 * would re-trip text merging on every keystroke.
 */
export function canonicalize(html: string): string {
  let out = sanitizeInline(html)
  // one pass of adjacent-run coalescing per tag, repeated to a fixed point so
  // <b>a</b><b>b</b><b>c</b> collapses fully
  for (let i = 0; i < 4; i++) {
    const before = out
    for (const tag of ['b', 'i', 'u', 's', 'em', 'strong', 'code', 'mark']) {
      out = out.replaceAll(`</${tag}><${tag}>`, '')
    }
    out = out.replace(/<(b|i|u|s|em|strong|code|mark)><\/\1>/g, '') // empty runs
    if (out === before) break
  }
  return out
}

/** Plain text of a block, for search and for markdown export. */
export function textOf(html: string | undefined): string {
  if (!html) return ''
  if (typeof document === 'undefined') return stripAllTags(html)
  const d = document.createElement('div')
  d.innerHTML = html
  return d.textContent ?? ''
}

/** Escape for safe insertion as text. */
export const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
