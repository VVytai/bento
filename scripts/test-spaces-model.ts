#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/spaces model rig.
//
//   node scripts/test-spaces-model.ts
//
// WHAT THIS PROVES. Three properties, each of which fails silently and each of
// which is unrecoverable once files exist on disks.
//
//   1. THE LOAD CONTRACT. `parseDoc` must never hand back "here is an empty
//      space" for a document it could not read. The scaffold did — it returned
//      null for anything invalid and the caller fell back to the starter — so
//      opening a slides file, or a document with one hand-edited typo, showed
//      an empty space over live data, and the first ⌘S wrote it to disk.
//      The ONLY path to the starter is an absent or empty block.
//
//   2. ADDITIVITY (PLATFORM §3). Unknown top-level fields, unknown per-node
//      fields and unknown block TYPES all survive a round trip. There is no
//      server to migrate anything, so a version that strips what it does not
//      understand destroys documents written by a later one.
//
//   3. DETERMINISTIC ID REPAIR. Two readers of one file must agree on every
//      id, because links, backlinks and future collaboration key on them. A
//      repair derived from Math.random diverges two readers of the same bytes;
//      one derived from docId does too, because `template: true` re-mints
//      docId on every open.

import {
  parseDoc, buildIndex, docContentKey, homePage, FORMAT, isRemote,
  type SpacesDoc,
} from '../spaces/src/model.ts'
import { countOutsideTags, replaceOutsideTags } from '../spaces/src/findreplace.ts'
import { SPECS, SPEC, MENU_SPECS, MD_SPECS, TAG_OF, LIST_OF } from '../spaces/src/blocks.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

const doc = (over: Record<string, unknown> = {}): string => JSON.stringify({
  format: FORMAT, version: 1, docId: 'd1', title: 'T',
  pages: [{ id: 'p1', title: 'One', blocks: [{ id: 'b1', type: 'p', html: 'hi' }] }],
  theme: {},
  ...over,
})

// ---- 1. the load contract --------------------------------------------------
ok(parseDoc('').ok === false && (parseDoc('') as any).err === 'empty',
  'an empty block is the ONLY thing that yields the starter')
ok(parseDoc('   \n ').ok === false && (parseDoc('  ') as any).err === 'empty',
  'whitespace counts as empty')

for (const [label, input, err] of [
  ['a slides document', JSON.stringify({ format: 'bento/slides', slides: [] }), 'format'],
  ['a hand-edited typo', '{"format":"bento/spaces", pages:[]}', 'json'],
  ['a JSON array', '[]', 'shape'],
  ['pages missing', JSON.stringify({ format: FORMAT }), 'shape'],
] as const) {
  const r = parseDoc(input)
  ok(r.ok === false && r.err === err, `${label} REFUSES with err="${err}" (never the starter)`)
}
{
  const r = parseDoc(JSON.stringify({ format: 'bento/slides', slides: [] }))
  ok(r.ok === false && 'found' in r && r.found === 'bento/slides',
    'refusing names the format it actually found, so the message can say so')
}

// ---- 2. additivity ---------------------------------------------------------
{
  const r = parseDoc(doc({
    futureTopLevel: { a: 1 },
    pages: [{
      id: 'p1', title: 'One', futurePageField: 'keep',
      blocks: [
        { id: 'b1', type: 'p', html: 'hi', futureBlockField: 7 },
        { id: 'b2', type: 'kanban', html: 'fallback text', lanes: 3 },
      ],
    }],
  }))
  ok(r.ok, 'a document carrying unknown fields still parses')
  if (r.ok) {
    ok(JSON.stringify((r.doc as any).futureTopLevel) === '{"a":1}', 'an unknown TOP-LEVEL field survives')
    ok((r.doc.pages[0] as any).futurePageField === 'keep', 'an unknown PAGE field survives')
    ok((r.doc.pages[0].blocks[0] as any).futureBlockField === 7, 'an unknown BLOCK field survives')
    const kb = r.doc.pages[0].blocks[1]
    ok(kb.type === 'kanban' && (kb as any).lanes === 3, 'an unknown block TYPE survives with its data')
    ok(kb.html === 'fallback text', 'and keeps html, so an older build can still show something')
  }
}

// ---- frozen: a newer version opens read-only and byte-exact -----------------
{
  const r = parseDoc(doc({ version: 99 }))
  ok(r.ok && r.frozen === 'version', 'a newer format version opens FROZEN rather than being reinterpreted')
  const p = parseDoc(doc({ policy: 'bento-spaces-2' }))
  ok(p.ok && p.frozen === 'policy', 'an unrecognised policy opens FROZEN')
  // frozen means ids are NOT rewritten, even duplicates: we cannot know the
  // rules this file was written under, so we must not touch it
  const dup = parseDoc(doc({
    version: 99,
    pages: [{ id: 'p1', title: 'A', blocks: [{ id: 'x', type: 'p' }, { id: 'x', type: 'p' }] }],
  }))
  ok(dup.ok && dup.doc.pages[0].blocks.every((b) => b.id === 'x'),
    'frozen documents keep even DUPLICATE ids untouched')
  ok(dup.ok && dup.repaired.length === 0, 'and report no repairs')
}

// ---- 3. deterministic id repair --------------------------------------------
{
  const dupes = doc({
    pages: [
      { id: 'p1', title: 'A', blocks: [{ id: 'b1', type: 'p', html: 'one' }, { id: 'b1', type: 'p', html: 'two' }] },
      { id: 'p1', title: 'B', blocks: [{ id: 'b9', type: 'p', html: 'three' }] },
    ],
  })
  const a = parseDoc(dupes)
  const b = parseDoc(dupes)
  ok(a.ok && b.ok, 'a document with duplicate ids still opens')
  if (a.ok && b.ok) {
    ok(JSON.stringify(a.doc.pages) === JSON.stringify(b.doc.pages),
      'TWO READERS OF THE SAME BYTES PRODUCE THE SAME IDS')
    const ids = new Set<string>()
    let dup = false
    for (const p of a.doc.pages) { if (ids.has(p.id)) dup = true; ids.add(p.id); for (const bl of p.blocks) { if (ids.has(bl.id)) dup = true; ids.add(bl.id) } }
    ok(!dup, 'every id in the repaired document is unique across the WHOLE document')
    ok(a.doc.pages[0].id === 'p1', 'first occurrence in pre-order keeps the id')
    ok(a.doc.pages[1].id !== 'p1', 'the later duplicate is the one that moves')
    ok(a.repaired.length === 2, `repairs are REPORTED, never silent (got ${a.repaired.length})`)
  }
}
{
  // repair must not depend on docId: `template: true` re-mints it every open,
  // so a docId-derived id would give two readers of one file different ids
  const body = { pages: [{ id: 'p', title: 'A', blocks: [{ id: 'z', type: 'p' }, { id: 'z', type: 'p' }] }] }
  const one = parseDoc(doc({ ...body, docId: 'aaa' }))
  const two = parseDoc(doc({ ...body, docId: 'bbb' }))
  ok(one.ok && two.ok &&
    JSON.stringify(one.doc.pages[0].blocks.map((b) => b.id)) ===
    JSON.stringify(two.doc.pages[0].blocks.map((b) => b.id)),
    'repair does NOT depend on docId (which template:true re-mints every open)')
}

// ---- dangling references ---------------------------------------------------
{
  const r = parseDoc(doc({
    pages: [{ id: 'p1', title: 'A', parent: 'nope', blocks: [{ id: 'b1', type: 'p', parent: 'gone' }] }],
  }))
  ok(r.ok && r.doc.pages[0].parent === undefined,
    'a page whose parent does not exist becomes a ROOT page rather than vanishing')
  ok(r.ok && r.doc.pages[0].blocks[0].parent === undefined,
    'a block whose owner does not exist is re-homed rather than never rendering')
}

// ---- the index -------------------------------------------------------------
{
  const r = parseDoc(doc({
    pages: [
      { id: 'home', title: 'Home', blocks: [{ id: 'h1', type: 'p', html: 'see <a href="#p/sub">Sub</a>' }] },
      { id: 'sub', title: 'Sub', parent: 'home', blocks: [{ id: 's1', type: 'pagelink', page: 'home' }] },
    ],
  }))
  ok(r.ok, 'the linked document parses')
  if (r.ok) {
    const ix = buildIndex(r.doc)
    ok(ix.backlinks.get('sub')?.length === 1, 'an inline #p/ link produces a backlink')
    ok(ix.backlinks.get('home')?.length === 1, 'a pagelink BLOCK produces a backlink too')
    ok(ix.children.get('home')?.[0].id === 'sub', 'the page tree nests by parent')
    ok(ix.children.get('')?.length === 1, 'and only true roots are at the root')
    ok(ix.block.get('s1')?.pageId === 'sub', 'a block resolves to its owning page')
  }
}

// ---- content key -----------------------------------------------------------
{
  const base = parseDoc(doc())
  const same = parseDoc(doc({ modified: '2026-01-01T00:00:00Z' }))
  ok(base.ok && same.ok && docContentKey(base.doc) === docContentKey(same.doc),
    'docContentKey ignores volatile fields, so autosave does not see a phantom edit')
  const other = parseDoc(doc({ title: 'Different' }))
  ok(base.ok && other.ok && docContentKey(base.doc) !== docContentKey(other.doc),
    'and it DOES see a real one')
}
{
  const r = parseDoc(doc({ home: 'p1' }))
  ok(r.ok && homePage(r.doc)?.id === 'p1', 'home names the landing page')
  const noHome = parseDoc(doc())
  ok(noHome.ok && homePage(noHome.doc)?.id === 'p1', 'and falls back to the first page')
}

// ---- the href allowlist is matched against the ATTRIBUTE, not the property --
// Measured: `a.href` returns the RESOLVED ABSOLUTE url, so from file:// a
// stored "#p/abc" reads back as "file:///…#p/abc" and fails an allowlist that
// passes on a static host — stripping every internal link in exactly the two
// environments this format exists for. A behavioural test needs a DOM; this
// pins the discipline in the source, where the mistake is made.
{
  const src = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../spaces/src/sanitize.ts', import.meta.url), 'utf8'))
  ok(src.includes("getAttribute('href')"),
    'sanitize.ts tests the href ATTRIBUTE')
  ok(!/\bel\.href\b|\ba\.href\b/.test(src),
    'sanitize.ts never reads the .href IDL property (it resolves to an absolute URL)')
}

// ---- untrusted html is parsed INERT, never into a live element -------------
// Measured in a browser, 2026-08-03: `document.createElement('div').innerHTML =
// '<img src="404" onerror="…">'` FIRES the handler. The div is detached, but
// its elements belong to the live document, so the resource loads. `DOMParser`,
// `<template>` and `createHTMLDocument` are inert and do not.
//
// That made the SANITIZER its own vector: it must parse hostile markup before
// it can strip it, so the payload ran before the strip — at render time, on
// merely opening a space someone sent you. Two more call sites (textOf, and
// render.ts's code-block text extraction) had the same shape.
//
// Behavioural proof needs a DOM and a network failure; this pins the discipline
// in the source, where the mistake gets made. Any new html-parsing helper must
// go through inertBody().
{
  const fs = await import('node:fs')
  const read = (f: string) => fs.readFileSync(new URL(`../spaces/src/${f}`, import.meta.url), 'utf8')

  // EVERY source file, globbed — never a hand-written list. The list version
  // named the five files that existed when the hole was found, so findreplace.ts
  // and blocks.ts (added days later) were never checked, and any new module
  // could reintroduce the live-parse hole with the guard still green. A guard
  // that only covers the code it was written against is a guard that expires.
  const dir = new URL('../spaces/src/', import.meta.url)
  const walk = (d: URL): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(new URL(`${e.name}/`, d)) : e.name.endsWith('.ts') ? [new URL(e.name, d).pathname.slice(dir.pathname.length)] : [])
  const sources = walk(dir)
  ok(sources.length >= 10 && sources.includes('findreplace.ts') && sources.includes('blocks.ts'),
    `the guard globs every source file (${sources.length} found)`)
  for (const f of sources) {
    const src = read(f)
    // an element made with createElement, then fed innerHTML — the live-parse
    // shape. Assignments of ALREADY-SANITIZED html to a render target are fine
    // and read differently (`x.innerHTML = sanitizeInline(…)`), so the check is
    // on the raw-variable form.
    const live = /\.innerHTML\s*=\s*(html|raw|untrusted|b\.html|String\(html\))\b/.exec(src)
    ok(!live, `${f} never parses raw html into a live element (found: ${live?.[0] ?? 'none'})`)
  }

  const san = read('sanitize.ts')
  ok(/export function inertBody/.test(san), 'sanitize.ts exports inertBody()')
  ok(/new DOMParser\(\)\.parseFromString/.test(san), 'inertBody parses into an inert document')
  ok(/el\.ownerDocument\.createTextNode/.test(san),
    'the unwrap gap node comes from the parsed document, not the live one')
  ok(!/const host = document\.createElement/.test(san),
    'sanitizeInline does not host untrusted html in a live element')

  const ren = read('render.ts')
  ok(/inertBody\(/.test(ren), 'render.ts extracts code-block text through inertBody')
}

// ---- a document must not phone home when it is merely OPENED ---------------
// Measured: a space carrying <img src="https://…/pixel.png"> requested it on
// open. That is a tracking pixel in a format whose whole point is that you mail
// it — the recipient's IP and the moment they read your document, handed to
// whoever wrote the file — and it breaks PLATFORM §1 (no network required to
// open). Remote images now wait for the reader to ask.
//
// The predicate is an ALLOWLIST of the two local forms. A blocklist of `http:`
// would miss the cases that actually matter.
{
  for (const local of ['asset:sABC123', 'data:image/webp;base64,AAAA']) {
    ok(!isRemote(local), `${local.slice(0, 24)}… is local`)
  }
  for (const remote of [
    'https://tracker.example/p.png',
    'http://tracker.example/p.png',
    '//tracker.example/p.png',            // protocol-relative
    'photos/holiday.jpg',                 // relative — a real request on a host
    '/abs/path.png',
    'HTTPS://Tracker.Example/p.png',
    'blob:https://x/y',
    'filesystem:https://x/y',
  ]) {
    ok(isRemote(remote), `${remote} is remote`)
  }
  ok(!isRemote(''), 'an empty src is not a remote fetch')

  // and the renderer must actually consult it
  const fs = await import('node:fs')
  const ren = fs.readFileSync(new URL('../spaces/src/render.ts', import.meta.url), 'utf8')
  ok(/isRemote\(rawSrc\)\s*&&\s*!opts\.allowRemote/.test(ren),
    'render.ts gates remote images on the reader\'s consent')
  ok(!/allowRemote/.test(fs.readFileSync(new URL('../spaces/src/model.ts', import.meta.url), 'utf8')),
    'consent is NOT a document field — it belongs to the reader, not the file')
}

// ---- an encrypted space is never written to disk in the clear ---------------
// The recovery snapshot is the document as plain JSON. `putRecovery` does NOT
// guard on encryption — the CALLER must — so an unguarded call site puts in
// IndexedDB precisely what the password exists to keep off the disk, every few
// seconds, for the one author who has demonstrably asked for secrecy.
//
// Measured before the guard: the marker text appeared in the `recovery` store
// within 3 seconds of typing. After: setting a password clears the snapshot
// already written, and later edits write none.
{
  const fs = await import('node:fs')
  const main = fs.readFileSync(new URL('../spaces/src/main.ts', import.meta.url), 'utf8')
  const about = fs.readFileSync(new URL('../spaces/src/about.ts', import.meta.url), 'utf8')

  // the debounce body must stand down when encryption is on
  const guarded = /if \(isEncryptionActive\(\)\) return[\s\S]{0,200}?putRecovery/.test(main)
  ok(guarded, 'main.ts skips the recovery snapshot while a space is encrypted')

  // and turning encryption ON must remove what was written before it
  ok(/clearVersions\(/.test(about) && /clearRecovery\(/.test(about),
    'setting a password clears BOTH the version timeline and the recovery snapshot')
}

// ---- find & replace: the number shown IS the number changed ----------------
// Replace-all is destructive and lands in one commit, so the count in the
// readout, the count in the confirmation and the count of things that change
// must be one number. They were three: the readout counted matching BLOCKS
// ("2 found"), the dialog quoted that as "2 occurrences", and the sweep then
// changed 4. Counting from `textOf()` would have been wrong in the other
// direction — a needle split across markup reads as one word but cannot be
// replaced, so it would promise a change that never happens.
//
// Both functions now share one traversal, and this pins them together.
{
  const cases: Array<[string, number]> = [
    ['Widget and widget and WIDGET', 3],       // case-insensitive
    ['a <b>widget</b> inside markup', 1],      // inside a tag's content
    ['wid<b>get</b> split across tags', 0],    // NOT replaceable, so not counted
    ['<b>widget</b><i>widget</i>', 2],
    ['nothing here', 0],
    ['widgetwidget', 2],                       // adjacent, no overlap-skipping
    ['<a href="https://widget.example">x</a>', 0],  // an attribute is not text
  ]
  for (const [html, expect] of cases) {
    const n = countOutsideTags(html, 'widget')
    ok(n === expect, `count ${JSON.stringify(html).slice(0, 40)} → ${n} (expected ${expect})`)

    // the property that matters: whatever was counted is what changes
    const after = replaceOutsideTags(html, 'widget', 'gadget')
    const made = (after.match(/gadget/g) ?? []).length
    ok(made === expect, `…and replacing changes exactly ${expect} (changed ${made})`)
  }

  // an empty needle must never "match everything"
  ok(countOutsideTags('anything', '') === 0, 'an empty needle counts nothing')
  ok(replaceOutsideTags('anything', '', 'X') === 'anything', 'an empty needle replaces nothing')
  // markup must survive the sweep untouched
  ok(replaceOutsideTags('a <b class="x">widget</b>!', 'widget', 'gadget') === 'a <b class="x">gadget</b>!',
    'tags and their attributes are preserved verbatim')
}

// ---- every topbar action stays reachable at every width --------------------
// Measured at 375px before the ⋯ menu existed: the bar wanted 678px, so seven
// of eleven controls sat off the right edge — Save among them. The file could
// not be saved on a phone, and nothing said so: the controls were in the DOM,
// laid out, and simply painted past the edge.
//
// The rule (slides' rule) is: drop text and fold, never scroll. The failure
// mode to guard is not the CSS — it is the SECOND LIST: a ⋯ menu maintained by
// hand as a copy of the desktop row drifts the first time either changes, and
// the drift is invisible until someone opens the app on a phone.
{
  const fs = await import('node:fs')
  const ed = fs.readFileSync(new URL('../spaces/src/editor.ts', import.meta.url), 'utf8')
  const css = fs.readFileSync(new URL('../spaces/src/styles.css', import.meta.url), 'utf8')

  ok(/const secondary: Array<\{/.test(ed), 'the secondary topbar actions are declared as ONE list')
  ok(/secondary\.map\(/.test(ed), '…the inline row is built from that list')
  ok(/for \(const a of secondary\)/.test(ed), '…and the ⋯ menu is built from the SAME list')

  ok(/@media \(max-width: 720px\)/.test(css), 'there is a narrow-width breakpoint')
  const narrow = css.slice(css.indexOf('@media (max-width: 720px)'))
  ok(/\.sp-sec \{ display: none/.test(narrow), 'narrow hides the inline secondary row')
  ok(/\.sp-more \{ display: inline-flex/.test(narrow), 'narrow reveals the ⋯ menu')

  // the bar must never become a scroller — that hides the same controls, just
  // less honestly, and it is the fix everyone reaches for first
  const barRule = css.slice(css.indexOf('.sp-bar {'), css.indexOf('}', css.indexOf('.sp-bar {')))
  ok(!/overflow-x:\s*(auto|scroll)/.test(barRule), 'the topbar does not scroll horizontally')

  // a menu opened from the right end must open inward
  ok(/\.sp-dd-end \.sp-ddmenu \{ inset-inline-start: auto; inset-inline-end: 0/.test(css),
    'right-end dropdowns open inward')
  ok(/more\.classList\.add\('sp-more', 'sp-dd-end'\)/.test(ed) &&
     /saveMore\.classList\.add\('sp-caret', 'sp-dd-end'\)/.test(ed),
    '…and both right-end menus say so')
}

// ---- one declaration per block type ---------------------------------------
// Adding a type used to mean five edits across four files — the renderer's tag
// map and list map, the / menu, the markdown-autoformat table, and the markdown
// exporter. Four out of five looked finished and exported as a bare paragraph.
//
// It is also the merge-conflict surface: several people adding block types in
// parallel all edited the same four hot files. One registry, and each type is
// an independent entry.
{
  ok(SPECS.length >= 13, `the registry holds every block type (${SPECS.length})`)
  ok(new Set(SPECS.map((s) => s.type)).size === SPECS.length, 'block types are unique')
  for (const sp of SPECS) {
    ok(!!sp.label && !!sp.hint && !!sp.icon, `${sp.type}: has a label, hint and icon`)
    ok(!!sp.tag, `${sp.type}: declares its semantic element`)
  }

  // a list item must actually be an <li>, or it renders outside its <ul>
  for (const sp of SPECS.filter((s) => s.list)) {
    ok(sp.tag === 'li', `${sp.type}: a list block is an <li> (got <${sp.tag}>)`)
  }
  // …and the derived map must keep CUSTOM list types, which is the mistake that
  // would silently lift every to-do out of its list
  ok(TAG_OF.todo === 'li', 'todo keeps its <li> despite rendering custom')
  ok(LIST_OF.todo === 'ul' && LIST_OF.bullet === 'ul' && LIST_OF.number === 'ol',
    'the list map is derived correctly')

  // the autoformat triggers, ALIASES INCLUDED — "- " and "* " both start a
  // bullet, "[] " and "[ ] " both start a to-do. A registry that allowed one
  // pattern per type would have dropped half of these silently.
  const triggers = MD_SPECS.map(([re, type]) => `${re.source}=>${type}`).sort()
  const expected = [
    '^# $=>h1', '^## $=>h2', '^### $=>h3',
    '^- $=>bullet', '^\\* $=>bullet',
    '^1\\. $=>number', '^> $=>quote',
    '^\\[\\] $=>todo', '^\\[ \\] $=>todo',
    '^```$=>code', '^--- $=>divider',
  ].sort()
  ok(JSON.stringify(triggers) === JSON.stringify(expected),
    `every markdown trigger survives the registry (${triggers.length} of ${expected.length})`)

  // the to-do trigger must still initialise `done`, or the checkbox renders
  // from an absent field
  const todoInit = MD_SPECS.find(([, type]) => type === 'todo')?.[2]
  const probe: Record<string, unknown> = {}
  todoInit?.(probe as never)
  ok(probe.done === false, 'the to-do trigger initialises done:false')

  ok(MENU_SPECS.length === SPECS.length, 'every type is offered in the / menu')
  ok(SPEC.get('futuretype') === undefined, 'an unknown type has no spec — and must still render as text')
  ok(SPECS.filter((s) => s.type !== 'p').every((s) => !!s.toMd),
    'every type but plain text says how it exports to markdown')

  // and the consumers must actually derive, rather than keeping a second copy
  const fs = await import('node:fs')
  const read = (f: string) => fs.readFileSync(new URL(`../spaces/src/${f}`, import.meta.url), 'utf8')
  const ren = read('render.ts'), ed = read('editor.ts'), ab = read('about.ts')
  ok(/import \{ TAG_OF, LIST_OF \} from '\.\/blocks'/.test(ren) &&
     !/const TAG_OF: Record/.test(ren) && !/const LIST_OF: Record/.test(ren),
    'render.ts derives its tag and list maps rather than repeating them')
  ok(/const SLASH_ITEMS = MENU_SPECS/.test(ed), 'the / menu is the registry')
  ok(/const AUTOFORMAT = MD_SPECS/.test(ed), 'autoformat is the registry')
  ok(/SPEC\.get\(b\.type\)/.test(ab) && !/case 'bullet': out\.push/.test(ab),
    'markdown export is the registry, not a parallel switch')
}

// ---- four things that were wrong in a shipped file ------------------------
{
  const fs2 = await import('node:fs')
  const rd = (f: string) => fs2.readFileSync(new URL(`../spaces/src/${f}`, import.meta.url), 'utf8')
  const main = rd('main.ts'), ed = rd('editor.ts'), mod = rd('model.ts')

  // 1. "Save a copy…" must not become the ⌘S target. saveFile(doc, true)
  //    ASSIGNS the picked handle to the module's in-place handle, so every
  //    later save wrote to the copy while the original stayed frozen at the
  //    moment it was taken. The code even carried a comment claiming the
  //    kernel did the opposite.
  ok(/writeUpdatedFileAs\(html, store\.doc/.test(main),
    'a copy is written through writeUpdatedFileAs (keepHandle defaults false)')
  ok(!/saveFile\(store\.doc, true\)/.test(main),
    '…and never through saveFile(doc, true), which retargets ⌘S to the copy')

  // 2. doc.readonly was declared in the format and read by nothing: a space
  //    saved as a reading copy opened fully editable.
  ok(/if \(frozen \|\| doc\.readonly\) store\.readOnly = true/.test(main),
    'doc.readonly opens the space read-only')

  // 3. the agent API must not report ids for blocks it did not write —
  //    store.commit early-returns on a read-only document, and the ids came
  //    back anyway.
  for (const verb of ['insertBlocks', 'newPage']) {
    const at = main.indexOf(`${verb}: (`)
    const body = main.slice(at, at + 900)
    ok(/if \(store\.readOnly\) return null/.test(body),
      `bento.${verb} refuses on a read-only document instead of returning phantom ids`)
  }

  // 4. #p/<page>/<block> is ALREADY admissible under sanitize.ts's allowlist,
  //    so it can arrive in a file this build did not write. It used to resolve
  //    to nothing — not even the page — and produced a backlink keyed on a
  //    page id that does not exist.
  ok(/private resolveAnchor\(/.test(ed), 'there is one anchor resolver')
  ok(/const id = this\.resolveAnchor\(href\)/.test(ed), '…and clicks go through it')
  ok(/function linkTarget\(/.test(mod) && /linkTarget\(m\[1\], page\)/.test(mod),
    'backlinks are keyed on the PAGE segment of a link target')
}

// ---- markdown triggers must survive a real keystroke -----------------------
// A trailing space typed at the end of a contentEditable line is inserted as
// U+00A0, not U+0020. So `/^## $/` matched nothing anyone typed and EVERY
// markdown trigger was dead from 0.1.0 — in the feature the starter space
// advertises on its Writing page.
//
// It survived because a test set `host.textContent` directly, with a real
// space. That is not typing, and it is why this assertion is about the FIX
// rather than the behaviour: the behaviour needs a browser and
// execCommand('insertText'), which is the only way to reproduce the NBSP.
{
  const fs2 = await import('node:fs')
  const ed = fs2.readFileSync(new URL('../spaces/src/editor.ts', import.meta.url), 'utf8')
  const fn = ed.slice(ed.indexOf('private autoformat('), ed.indexOf('private autoformat(') + 1600)
  ok(/replace\(\/\\u00a0\/g, ' '\)/.test(fn),
    'autoformat normalises U+00A0 before testing its patterns')
  // …and only for the test: rewriting the author's text would be worse
  ok(!/b\.html = .*replace\(\/\\u00a0/.test(ed),
    '…and never rewrites the stored text to make a pattern match')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
