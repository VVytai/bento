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
import { starterDoc } from '../spaces/src/starter.ts'
import {
  validateDoc, outlineDoc, statsDoc, normalizeHtml, jsonSafe,
  planInsertBlocks, planUpdateBlock, planRemoveBlocks, planMoveBlock, planUpdatePage, planRemovePage,
} from '../spaces/src/agent.ts'

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

  for (const f of ['sanitize.ts', 'render.ts', 'editor.ts', 'about.ts', 'main.ts']) {
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

// ---- the agent surface: validate() ------------------------------------------
// A validator that reports something about a perfectly good document is one an
// agent learns to ignore, and then it reports nothing at all. So the bar is
// absolute: ZERO findings on the space every new file opens with. Anything the
// starter does is by definition idiomatic, which makes it the only honest
// baseline available — and it exercises links, a toggle with a child, a code
// block, lists, a divider and five pages on the way past.
{
  const starter = starterDoc()
  starter.docId = 'test'
  const r = validateDoc(starter)
  ok(r.ok, 'the starter space has no ERRORS')
  ok(r.findings.length === 0,
    `validate() is SILENT on the starter space (got ${r.findings.length}: ${r.findings.map((f) => f.code).join(', ') || 'none'})`)
}

// …and fires on a document that is broken in every way it knows about. One
// deliberately awful space, one assertion per code, so a check that stops
// firing is a named failure rather than a smaller number.
{
  const broken = {
    format: FORMAT, version: 1, docId: 'd', title: 'Broken',
    home: 'nowhere',
    theme: {},
    assets: { keep: 'data:image/webp;base64,AAAA', spare: 'data:image/webp;base64,BBBB' },
    fonts: [{ family: 'Ghost', asset: 'missing-font' }],
    pages: [
      {
        id: 'p1', title: 'One', blocks: [
          { id: 'dupe', type: 'p', html: 'see <a href="#p/ghost">a page that is not here</a>' },
          { id: 'dupe', type: 'p', html: 'same id as the block above' },
          { id: 'b3', type: 'kanban', html: 'a type this build does not render' },
          { id: 'b4', type: 'p', html: '<p>block markup</p><p>inside inline html</p>' },
          { id: 'b5', type: 'p', html: 'a <table><tr><td>table</td></tr></table> is dropped whole' },
          { id: 'b6', type: 'p', html: 'a <a href="javascript:alert(1)">bad scheme</a>' },
          { id: 'b7', type: 'image', src: 'https://tracker.example/p.png' },
          { id: 'b8', type: 'image', src: 'asset:gone', alt: 'x', w: 1, h: 1 },
          { id: 'b9', type: 'pagelink', page: 'ghost' },
          { id: 'b10', type: 'p', parent: 'not-a-block', html: 'nested under nothing' },
          { id: 'b11', type: 'code', html: 'const x = <div>1</div>' },
          { id: '', type: 'p', html: 'no id' },
        ],
      },
      { id: 'p2', title: 'Empty', blocks: [] },
      { id: 'p3', title: 'Blank', blocks: [{ id: 'b12', type: 'p', html: '' }] },
      { id: 'p4', title: 'Orphan', parent: 'no-such-page', blocks: [{ id: 'b13', type: 'p', html: 'x' }] },
      { id: 'p5', title: 'Loop', parent: 'p6', blocks: [{ id: 'b14', type: 'p', html: 'x' }] },
      { id: 'p6', title: 'Loop', parent: 'p5', blocks: [{ id: 'b15', type: 'p', html: 'x' }] },
    ],
  } as unknown as SpacesDoc

  const r = validateDoc(broken)
  const by = (code: string) => r.findings.filter((f) => f.code === code)
  const fires = (code: string, severity: string, n = 1) =>
    ok(by(code).length >= n && by(code).every((f) => f.severity === severity),
      `validate() reports ${code} as ${severity} (got ${by(code).length} × ${by(code)[0]?.severity ?? 'nothing'})`)

  ok(!r.ok, 'a document with errors is not ok')
  fires('duplicate-id', 'error')
  fires('missing-id', 'error')
  fires('no-such-home', 'warning')
  fires('no-such-page-parent', 'warning')
  fires('page-cycle', 'error', 2)          // both pages in the loop
  fires('no-such-block-parent', 'warning')
  fires('unknown-block-type', 'warning')
  fires('block-markup', 'warning')
  fires('dropped-markup', 'error')
  fires('dead-href', 'warning')
  fires('markup-in-code', 'warning')
  fires('broken-link', 'error', 2)         // the inline link and the pagelink card
  fires('missing-asset', 'error', 2)       // the image and the font
  fires('remote-image', 'warning')
  fires('image-no-alt', 'warning')
  fires('image-no-size', 'info')
  fires('no-blocks', 'error')
  fires('empty-page', 'info')
  fires('orphan-asset', 'info')
  ok(by('orphan-asset').length === 1, 'orphan assets are ONE finding, not one per key')
  ok(r.findings.every((f) => f.message && f.fix), 'every finding says what is wrong AND how to fix it')
  ok(r.counts.error + r.counts.warning + r.counts.info === r.findings.length, 'the counts add up')
}

// ---- outline() --------------------------------------------------------------
{
  const o = outlineDoc(starterDoc())
  ok(o.tree.length === o.pages && o.pages === 5, 'outline lists every page')
  ok(o.tree[0].home === true, 'the landing page is marked')
  ok(o.tree[0].links?.includes('sd-links') === true, 'a page\'s outgoing links come back with it')
  ok((o.tree[0].headings ?? []).every((h) => h.id && h.text && h.level >= 1 && h.level <= 3),
    'headings carry the block id, so what comes back can be patched directly')
  ok(o.words > 100 && o.blocks > 20, 'the totals are counted, not guessed')

  // a page inside its own subtree is in no walk from the root; dropping it here
  // would make outline() a quiet liar about how many pages a space has
  const looped = parseDoc(doc({
    pages: [
      { id: 'a', title: 'A', blocks: [{ id: 'x', type: 'p' }] },
      { id: 'b', title: 'B', parent: 'c', blocks: [{ id: 'y', type: 'p' }] },
      { id: 'c', title: 'C', parent: 'b', blocks: [{ id: 'z', type: 'p' }] },
    ],
  }))
  const lo = outlineDoc((looped as any).doc)
  ok(lo.tree.length === 3, `an unreachable page still appears in the outline (got ${lo.tree.length})`)
}

// ---- stats() ----------------------------------------------------------------
{
  const d = (parseDoc(doc({
    assets: { used: 'data:image/webp;base64,' + 'A'.repeat(400), spare: 'data:image/png;base64,' + 'B'.repeat(100) },
    pages: [{ id: 'p1', title: 'One', blocks: [
      { id: 'b1', type: 'p', html: 'four <a href="https://x/y">words go</a> here' },
      { id: 'b2', type: 'image', src: 'asset:used', alt: 'a' },
      { id: 'b3', type: 'todo', html: 'done one', done: true },
      { id: 'b4', type: 'todo', html: 'not yet' },
    ] }],
  })) as any).doc as SpacesDoc
  const s = statsDoc(d)
  ok(s.pages === 1 && s.blocks === 4, 'stats counts pages and blocks')
  ok(s.words === 4 + 2 + 2, `words come from the text, not the markup (got ${s.words})`)
  ok(s.todos.done === 1 && s.todos.total === 2, 'todos are counted done vs total')
  ok(s.assets.count === 2 && s.assets.orphans === 1, 'an unreferenced asset is counted as an orphan')
  ok(s.biggest[0].key === 'used' && s.biggest[0].used === 1 && s.biggest[0].mime === 'image/webp',
    'the biggest asset comes first, with its mime and how many blocks use it')
  ok(s.bytes.assets > 500 && s.bytes.document > s.bytes.assets,
    'the byte breakdown separates assets from the document that holds them')
}

// ---- the write verbs --------------------------------------------------------
// Each is ONE undoable step in the app; here they are exercised as plans, which
// is the whole point of splitting plan from apply — the mutation logic is
// reachable without a store, a DOM or an editor.
const fresh = (): SpacesDoc => (parseDoc(doc({
  pages: [
    { id: 'p1', title: 'One', blocks: [
      { id: 'a', type: 'p', html: 'first' },
      { id: 'tog', type: 'toggle', html: 'fold', open: true },
      { id: 'kid', type: 'p', parent: 'tog', html: 'inside the fold' },
      { id: 'grandkid', type: 'p', parent: 'kid', html: 'deeper' },
      { id: 'z', type: 'p', html: 'last' },
    ] },
    { id: 'p2', title: 'Two', parent: 'p1', blocks: [{ id: 'q', type: 'p', html: 'over here' }] },
  ],
})) as any).doc as SpacesDoc

{
  // html an agent supplies is sanitized on the way IN. The editor cannot
  // produce a <script> in a block, so the API must not be a way to put one in
  // the file — rendering strips it, but the bytes would still travel.
  const d = fresh()
  const p = planInsertBlocks(d, 'p1', 'a', [{ type: 'p', html: 'hi <script>alert(1)</script>' }])
  ok(p.ok, 'insertBlocks plans')
  if (p.ok) {
    p.apply()
    const made = d.pages[0].blocks.find((b) => b.id === p.ids[0])!
    ok(!String(made.html).includes('<script'), `supplied html is sanitized on the way in (got ${made.html})`)
    ok(d.pages[0].blocks[1].id === p.ids[0], 'and it lands directly after the block named by afterId')
  }
}
{
  // a batch could not nest inside itself before: ids are re-minted, so a child
  // naming its parent's SUPPLIED id had no way to reach the real one
  const d = fresh()
  const p = planInsertBlocks(d, 'p1', null, [
    { id: 'mine-1', type: 'toggle', html: 'new fold' },
    { id: 'mine-2', type: 'p', parent: 'mine-1', html: 'body' },
    { id: 'mine-3', type: 'p', parent: 'nowhere', html: 'no such owner' },
  ])
  ok(p.ok, 'a nested batch plans')
  if (p.ok) {
    p.apply()
    const [tog, body, loose] = p.ids.map((id) => d.pages[0].blocks.find((b) => b.id === id)!)
    ok(body.parent === tog.id, 'parent is remapped to the minted id of the block in the same batch')
    ok(loose.parent === undefined, 'a parent that resolves to nothing is dropped, not left dangling')
  }
  const bad = planInsertBlocks(fresh(), 'p1', 'no-such-block', [{ type: 'p' }])
  ok(!bad.ok && bad.err === 'no-such-block',
    'an afterId that is not on the page is REFUSED (it used to append silently, somewhere else)')
  ok(!planInsertBlocks(fresh(), 'p1', null, [{ type: 'p', html: () => 'x' }] as any).ok,
    'a value JSON cannot carry is refused rather than vanishing at save time')
}
{
  const d = fresh()
  ok(!planUpdateBlock(d, 'a', { id: 'renamed' }).ok, 'updateBlock REFUSES to change an id (it never silently ignores it)')
  ok(!planUpdateBlock(d, 'nope', { html: 'x' }).ok, 'updateBlock on a block that is not there fails')
  ok(!planUpdateBlock(d, 'tog', { parent: 'grandkid' }).ok, 'a block cannot be re-parented into its own subtree')
  const p = planUpdateBlock(d, 'a', { html: 'now <b>bold</b>', done: null, type: 'todo' })
  ok(p.ok, 'updateBlock plans a type change with content')
  if (p.ok) { p.apply(); ok(d.pages[0].blocks[0].type === 'todo', 'and applies it') }
}
{
  // deleting a toggle takes its body: leaving blocks pointing at an id that no
  // longer exists means they reappear, un-nested, in a document the agent
  // believed it had emptied
  const d = fresh()
  const p = planRemoveBlocks(d, ['tog', 'ghost'])
  ok(p.ok, 'removeBlocks plans')
  if (p.ok) {
    ok(p.removed.length === 3 && p.removed.includes('grandkid'), `the whole subtree goes (got ${p.removed.join(',')})`)
    ok(p.missing[0] === 'ghost', 'an id that was not there is reported, not silently counted as removed')
    p.apply()
    ok(d.pages[0].blocks.length === 2, 'and the page keeps the rest')
  }
}
{
  // a page with no blocks cannot be typed into at all — no caret, no gutter, no
  // / menu. The editor cannot produce one (mergeBack refuses at the first
  // block), so this API must not either.
  const d = fresh()
  const p = planRemoveBlocks(d, ['q'])
  ok(p.ok && p.added.length === 1, 'emptying a page mints a replacement paragraph')
  if (p.ok) {
    p.apply()
    ok(d.pages[1].blocks.length === 1 && d.pages[1].blocks[0].id === p.added[0],
      'so no page is ever left with zero blocks')
  }
}
{
  const d = fresh()
  const p = planMoveBlock(d, 'tog', { beforeId: 'a' })
  ok(p.ok, 'moveBlock plans')
  if (p.ok) {
    p.apply()
    ok(d.pages[0].blocks.map((b) => b.id).join(',') === 'tog,kid,grandkid,a,z',
      `a moved block takes its subtree with it, in order (got ${d.pages[0].blocks.map((b) => b.id).join(',')})`)
  }
  ok(!planMoveBlock(fresh(), 'tog', { afterId: 'kid' }).ok, 'a block cannot be moved inside its own subtree')

  const cross = fresh()
  const c = planMoveBlock(cross, 'kid', { pageId: 'p2', afterId: 'q' })
  ok(c.ok, 'a block can move to another page')
  if (c.ok) {
    c.apply()
    const moved = cross.pages[1].blocks.find((b) => b.id === 'kid')!
    ok(moved !== undefined && moved.parent === undefined,
      'and loses a parent that does not exist on the destination page')
    ok(cross.pages[1].blocks.some((b) => b.id === 'grandkid'), 'its own children travel with it')
  }
}
{
  const d = fresh()
  ok(!planUpdatePage(d, 'p1', { blocks: [] }).ok, 'updatePage REFUSES to assign the blocks array wholesale')
  ok(!planUpdatePage(d, 'p1', { id: 'x' }).ok, 'and refuses to change a page id')
  ok(!planUpdatePage(d, 'p1', { parent: 'p2' }).ok, 'a page cannot be moved inside its own subtree')
  const p = planUpdatePage(d, 'p2', { title: 'A <b>new</b> name', archived: true })
  ok(p.ok, 'updatePage plans')
  if (p.ok) {
    p.apply()
    ok(d.pages[1].title === 'A new name', `a title is plain text — it renders as textContent (got ${d.pages[1].title})`)
    ok(d.pages[1].archived === true, 'archived is set')
    const off = planUpdatePage(d, 'p2', { archived: false })
    if (off.ok) off.apply()
    ok(!('archived' in d.pages[1]), 'and unarchiving DELETES the key, exactly as the editor does')
  }
}
{
  const d = fresh()
  d.home = 'p2'
  d.pages[0].blocks[0].html = 'go <a href="#p/p2">there</a>'
  const p = planRemovePage(d, 'p2')
  ok(p.ok, 'removePage plans')
  if (p.ok) {
    ok(p.links === 1, `it counts the inbound links that are about to go dead (got ${p.links})`)
    p.apply()
    ok(d.home === undefined, 'and clears home when it named the removed page')
  }
  const kids = fresh()
  const k = planRemovePage(kids, 'p1')
  ok(k.ok && k.rehomed === 1, 'a child page moves up a level rather than being deleted with its parent')
  if (k.ok) { k.apply(); ok(kids.pages.length === 1 && kids.pages[0].parent === undefined, 'and lands at the root') }

  const all = fresh()
  const cascade = planRemovePage(all, 'p1', { descendants: true })
  ok(!cascade.ok && cascade.err === 'last-page',
    'removing every page is refused — a space with no pages cannot be edited back to life')
  ok(!planRemovePage((parseDoc(doc()) as any).doc, 'p1').ok, 'and so is removing the only page')
}
{
  // a code block's html is escaped TEXT, not markup: the renderer shows its
  // textContent, so sanitizing it would delete the sample being shown
  ok(normalizeHtml('<div>x</div>', 'code') === '&lt;div&gt;x&lt;/div&gt;', 'code html is escaped, not stripped')
  ok(normalizeHtml('&lt;div&gt;', 'code') === '&lt;div&gt;',
    'already-escaped code passes through untouched (replaying a patch must not double-escape)')
  ok(!normalizeHtml('<img src=x onerror=alert(1)>', 'p').includes('onerror'), 'rich html is sanitized')
  ok(jsonSafe({ a: [1, 'two', null, { b: true }] }), 'plain JSON data is accepted')
  for (const bad of [() => 1, new Date(), new Map(), Symbol('x'), NaN, Infinity]) {
    ok(!jsonSafe(bad), `${String(bad?.constructor?.name ?? typeof bad)} is refused`)
  }
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
