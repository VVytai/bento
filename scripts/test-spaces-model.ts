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
import { parseNote, planImport, inlineHtml, type SourceFile } from '../spaces/src/markdown.ts'

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

// ---- markdown import -------------------------------------------------------
// An import is a MIGRATION: someone's only copy of ten years of notes arrives
// through it, and every way it can go wrong is silent. A link that quietly
// stops being a link, a frontmatter block that quietly vanishes, a code fence
// that quietly eats the rest of the page — none of them raise anything, and
// the author finds out months later with the source folder long deleted.
//
// The parser is pure and DOM-free precisely so all of this can be asserted
// here rather than clicked through.
{
  const note = parseNote([
    '---',
    'tags: [a, b]',
    'title: Not the title',
    '---',
    '',
    '# Real title',
    '',
    'Text with **bold**, *italic*, `co<de>`, ~~gone~~ and [a link](https://x.example).',
    'A second line.',
    '',
    '- one',
    '  - nested',
    '- [ ] open',
    '- [x] done',
    '',
    '> quoted',
    '> more',
    '',
    '```js',
    'if (a < b && c) return "<script>";',
    '```',
    '',
    '---',
    '',
    '![a picture](images/pic.png)',
  ].join('\n'), 'file-name')

  ok(note.title === 'Real title', 'a leading "# Heading" becomes the page title')
  ok(!note.blocks.some((b) => b.type === 'h1' && b.html === 'Real title'),
    '…and is REMOVED from the body, so a page does not open with its own title twice')
  ok(parseNote('no heading here\n', 'file-name').title === 'file-name',
    'without one, the FILE NAME is the title — the name wikilinks resolve by')
  ok(note.title !== 'Not the title',
    'frontmatter `title:` is deliberately NOT consulted (it can disagree with the file name)')

  ok(note.frontmatter === 'tags: [a, b]\ntitle: Not the title',
    'frontmatter is captured VERBATIM, both lines of it')

  const p = note.blocks.find((b) => b.type === 'p')!
  ok(p.html === 'Text with <strong>bold</strong>, <em>italic</em>, <code>co&lt;de&gt;</code>, <s>gone</s> and <a href="https://x.example">a link</a>.<br>A second line.',
    `inline markdown → inline html, with a soft break kept as <br> (got ${p.html})`)

  const types = note.blocks.map((b) => b.type).join(',')
  ok(types.includes('bullet,bullet,todo,todo'), `lists and to-dos (got ${types})`)
  const nested = note.blocks.filter((b) => b.type === 'bullet')
  ok(nested[1].parent === nested[0].id, 'an indented item nests under the one above it')
  const todos = note.blocks.filter((b) => b.type === 'todo')
  ok(todos[0].done === false && todos[1].done === true, '- [ ] and - [x] carry their state')
  ok(note.blocks.find((b) => b.type === 'quote')?.html === 'quoted<br>more',
    'consecutive > lines are one quote')

  const code = note.blocks.find((b) => b.type === 'code')!
  ok(code.lang === 'js', 'a fence keeps its language')
  ok(code.html === 'if (a &lt; b &amp;&amp; c) return &quot;&lt;script&gt;&quot;;',
    `code content is escaped, so a "<" in it cannot eat the page (got ${code.html})`)

  ok(note.blocks.some((b) => b.type === 'divider'), 'a --- rule is a divider')
  ok(note.images.length === 1 && note.images[0].ref === 'images/pic.png',
    'a relative image is reported for the importer to resolve, not left to break')
}

// hostile markdown: the parser is not the security boundary (sanitizeInline is,
// in the browser), but it must not be a way to smuggle live markup past it
{
  const hostile = inlineHtml('<img src=x onerror=alert(1)> <script>alert(2)</script> ' +
    '<a href="javascript:alert(3)">click</a> <b>ok</b> <span onclick="x">s</span>')
  ok(!/onerror|onclick|javascript:|<script/i.test(hostile),
    `no event handler, javascript: url or script tag survives the parser (got ${hostile})`)
  ok(hostile.includes('<b>ok</b>') && hostile.includes('<span>s</span>'),
    'while allowlisted inline tags do survive, stripped of attributes')
  ok(!/<\/a>/.test(hostile),
    'a refused <a> does not leave its closing tag behind')
}

// wikilinks — the reason an Obsidian vault import is worth anything
{
  const files: SourceFile[] = [
    { path: 'Vault/Index.md', text: 'See [[Deep note]], [[notes/Deep note|an alias]] and [[Nowhere]].\n' },
    { path: 'Vault/notes/Deep note.md', text: '# Deep note\n\nBack to [[Index]].\n' },
    { path: 'Vault/notes/notes.md', text: 'I am the folder note.\n' },
  ]
  const plan = planImport(files, { rootTitle: 'Imported notes' })
  const html = plan.pages.flatMap((pg) => pg.blocks).map((b) => b.html ?? '').join('\n')

  ok(plan.stats.linked === 3 && plan.stats.dangling === 1,
    `three wikilinks resolve and one does not (got ${plan.stats.linked}/${plan.stats.dangling})`)
  ok(!/#w\//.test(html),
    'NO #w/ placeholder survives — the sanitizer would strip it and the link would vanish')
  ok(/\[\[Nowhere\]\]/.test(html),
    'a target outside the import stays as the literal [[Nowhere]] the author wrote')
  ok(/>an alias</.test(html), '[[target|alias]] shows the alias')

  const byTitle = new Map(plan.pages.map((pg) => [pg.title, pg]))
  const deep = byTitle.get('Deep note')!
  ok(/href="#p\/[^"]+"/.test(html), 'resolved links are real #p/ hrefs')
  ok(html.includes(`#p/${deep.id}`), 'and they name the page the note actually became')

  // the folder tree
  const ids = new Set(plan.pages.map((pg) => pg.id))
  ok([...plan.pages].every((pg) => !pg.parent || ids.has(pg.parent)),
    'every page parent resolves inside the import (a dangling one silently un-nests a page)')
  const seen = new Set<string>()
  let preorder = true
  for (const pg of plan.pages) { if (pg.parent && !seen.has(pg.parent)) preorder = false; seen.add(pg.id) }
  ok(preorder, 'pages come out in PRE-ORDER — a child never precedes its parent')
  ok(plan.pages.filter((pg) => pg.title === 'notes').length === 1 &&
    byTitle.get('notes')?.blocks.length === 1,
    'a folder note (notes/notes.md) IS the folder page rather than a child of an empty one')
  ok(deep.parent === byTitle.get('notes')!.id, 'and the folder\'s other notes hang off it')
  {
    // measured on a real vault: without this, Meetings/index.md titles the
    // whole section "index"
    const withIndex = planImport([
      { path: 'V/Meetings/index.md', text: 'notes from meetings\n' },
      { path: 'V/Meetings/One.md', text: 'x\n' },
    ], { rootTitle: 'Imported notes' })
    ok(withIndex.pages.some((pg) => pg.title === 'Meetings'),
      'an index.md folder note is titled after its FOLDER, not "index"')
  }
  ok(!plan.pages.some((pg) => pg.title === 'Imported notes'),
    'a picked FOLDER is already the root, so no container page is invented')

  const flat = planImport(
    [{ path: 'a.md', text: 'a' }, { path: 'b.md', text: 'b' }],
    { rootTitle: 'Imported notes' },
  )
  ok(flat.pages[0].title === 'Imported notes' && flat.pages.slice(1).every((pg) => pg.parent === flat.pages[0].id),
    'a flat multi-file selection gets ONE container, so the import is one thing to undo or delete')
  const one = planImport([{ path: 'solo.md', text: 'x' }], { rootTitle: 'Imported notes' })
  ok(one.pages.length === 1 && !one.pages[0].parent, 'a single file is just a page')

  // one note added to a space that already has pages
  const inc = planImport([{ path: 'New.md', text: 'see [[Home]] and [[Index]]\n' }], {
    rootTitle: 'Imported notes',
    resolveExisting: (target) => (target === 'home' ? 'p-existing-home' : undefined),
  })
  ok(/href="#p\/p-existing-home"/.test(inc.pages[0].blocks[0].html ?? ''),
    'a wikilink finds a page the space ALREADY had, so an incremental import is not dead text')
  const both = planImport(
    [{ path: 'Home.md', text: 'me' }, { path: 'Other.md', text: 'see [[Home]]\n' }],
    { rootTitle: 'Imported notes', resolveExisting: () => 'p-existing-home' },
  )
  const other = both.pages.find((pg) => pg.title === 'Other')!
  ok(other.blocks[0].html?.includes(both.pages.find((pg) => pg.title === 'Home')!.id),
    '…but a note IN the import always wins over a stranger page with the same title')
}

// frontmatter — a permanent format decision, so it is pinned here
{
  const plan = planImport(
    [{ path: 'n.md', text: '---\nkey: value\nlist:\n  - x\n---\n\nbody\n' }],
    { rootTitle: 'Imported notes' },
  )
  const blocks = plan.pages[0].blocks
  ok(blocks[0].type === 'toggle' && blocks[1].type === 'code',
    'frontmatter lands in a folded toggle with a code block inside it')
  ok(blocks[1].parent === blocks[0].id, 'the yaml is the toggle\'s child, so it folds away')
  ok(blocks[0].open === false, 'and it is folded by default (toggles still print open)')
  ok(blocks[1].lang === 'yaml' && blocks[1].frontmatter === true,
    'marked `frontmatter: true`, so a future properties model can adopt these mechanically')
  ok(blocks[1].html === 'key: value\nlist:\n  - x',
    `the yaml is verbatim, nothing parsed or dropped (got ${JSON.stringify(blocks[1].html)})`)
  ok(blocks.some((b) => b.html === 'body'), 'and the note\'s own content is still there')
}

// blocks: ids unique, parents resolvable, pre-order within a page
{
  const plan = planImport([
    { path: 'v/one.md', text: '- a\n  - b\n    - c\n\ntext\n' },
    { path: 'v/two.md', text: '- x\n  - y\n' },
  ], { rootTitle: 'Imported notes' })
  const ids = new Set<string>()
  let dup = false
  for (const pg of plan.pages) {
    const own = new Set<string>()
    let order = true
    for (const b of pg.blocks) {
      if (ids.has(b.id)) dup = true
      ids.add(b.id)
      if (b.parent && !own.has(b.parent)) order = false
      own.add(b.id)
    }
    ok(order, `blocks of "${pg.title}" are in pre-order (the renderer needs one forward pass)`)
  }
  for (const pg of plan.pages) if (ids.has(pg.id)) { /* pages share the id space */ }
  ok(!dup, 'every imported block id is unique across the import')
  const deep = plan.pages.find((pg) => pg.title === 'one')!.blocks
  ok(deep[2].parent === deep[1].id && deep[1].parent === deep[0].id,
    'three levels of indentation nest three levels deep')
}

// images: what a browser can and cannot open
{
  const plan = planImport([{
    path: 'v/n.md',
    text: '![local](pics/a.png)\n\n![web](https://e.example/b.png)\n\n![[c.png]]\n\n![[Some note]]\n',
  }], { rootTitle: 'Imported notes' })
  ok(plan.images.length === 2, `two local images await resolution (got ${plan.images.length})`)
  ok(plan.images[0]?.dir === 'v', 'each carries the folder its note lived in, for relative paths')
  ok(plan.stats.remoteImages === 1, 'a web image is kept as-is and counted, never fetched here')
  const page = plan.pages.find((pg) => pg.title === 'n')!
  ok(page.blocks.filter((b) => b.type === 'image').length === 3,
    `![[c.png]] is an image (got ${page.blocks.filter((b) => b.type === 'image').length} image blocks)`)
  ok(page.blocks.some((b) => b.type !== 'image' && /\[\[Some note\]\]/.test(b.html ?? '')),
    '…while ![[Some note]] is a note embed: a link, and dangling here, so it stays as text')
}

// tables: no table block exists yet, and reformatting one loses it
{
  const plan = planImport(
    [{ path: 'n.md', text: '| a | b |\n|---|---|\n| 1 | 2 |\n\nafter\n' }],
    { rootTitle: 'Imported notes' },
  )
  const code = plan.pages[0].blocks.find((b) => b.type === 'code')
  ok(!!code && code.html === '| a | b |\n|---|---|\n| 1 | 2 |',
    'a markdown table is kept VERBATIM as text rather than shredded into paragraphs')
  ok(plan.stats.tables === 1, 'and it is reported, so the author knows it is there')
  ok(plan.pages[0].blocks.some((b) => b.html === 'after'), 'the table does not swallow what follows')
}

// scale: a real vault, parsed in node
{
  const files: SourceFile[] = []
  for (let i = 0; i < 300; i++) {
    files.push({
      path: `Vault/${i % 7}/note-${i}.md`,
      text: `# Note ${i}\n\nSee [[Note ${(i + 1) % 300}]].\n\n- item\n- item\n`,
    })
  }
  const t0 = Date.now()
  const plan = planImport(files, { rootTitle: 'Imported notes' })
  const ms = Date.now() - t0
  ok(plan.stats.linked === 300, `300 notes cross-link completely (got ${plan.stats.linked})`)
  ok(ms < 3000, `300 notes plan in ${ms}ms`)
}

// the round trip: an imported space must REOPEN clean. Id repair is the
// backstop, and it is a lossy one — a repaired id is a NEW id, so every link
// pointing at the old one is now pointing at the wrong page. An importer that
// leans on it produces a space whose links quietly rot on the second open.
{
  const files: SourceFile[] = []
  for (let i = 0; i < 40; i++) {
    files.push({ path: `V/${i % 5}/n${i}.md`, text: `# n${i}\n\nto [[n${(i + 3) % 40}]]\n` })
  }
  const plan = planImport(files, { rootTitle: 'Imported notes' })
  const doc = {
    format: FORMAT, version: 1, docId: 'd1', title: 'T', theme: {},
    pages: [{ id: 'p-existing', title: 'Existing', blocks: [{ id: 'b-existing', type: 'p', html: 'here first' }] },
      ...plan.pages],
  }
  const r = parseDoc(JSON.stringify(doc))
  ok(r.ok, 'an imported space parses')
  if (r.ok) {
    ok(r.repaired.length === 0, `and needs NO id repair (got ${r.repaired.length})`)
    ok(r.doc.pages[0].id === 'p-existing', 'the pages that were already there are still first')
    const ix = buildIndex(r.doc)
    const hrefs = r.doc.pages.flatMap((pg) => pg.blocks)
      .flatMap((b) => [...(b.html ?? '').matchAll(/href="#p\/([^"]+)"/g)].map((m) => m[1]))
    ok(hrefs.length === 40, `every resolved link survives the round trip (got ${hrefs.length})`)
    ok(hrefs.every((id) => ix.page.has(id)), 'and every one of them still names a real page')
  }
}

// the import ADDS. Replacing someone's space with their import is the one
// mistake that cannot be walked back, so the discipline is pinned in source.
{
  const fs = await import('node:fs')
  const ed = fs.readFileSync(new URL('../spaces/src/editor.ts', import.meta.url), 'utf8')
  const body = ed.slice(ed.indexOf('async importFiles'), ed.indexOf('// ---- find and replace'))
  ok(/doc\.pages\.push\(\.\.\.plan\.pages\)/.test(body),
    'importFiles APPENDS the imported pages')
  ok(!/replaceDoc|pages\s*=\s*/.test(body),
    'and never replaces the document or reassigns its pages')
  ok((body.match(/\.commit\(/g) ?? []).length === 1,
    'in exactly ONE commit, so the whole import is one ⌘Z')
  ok(/resolveExisting:/.test(body),
    'and it hands the resolver the pages the space already has (browser-only wiring, pinned here)')
  // `>= 0 &&` is load-bearing: without it, DELETING the sanitize pass passes
  // this check (indexOf returns -1, which is "before" everything). Measured by
  // deleting it.
  const san = body.indexOf('sanitizeInline')
  ok(san >= 0 && san < body.indexOf('.commit('),
    'and every block is sanitized BEFORE it reaches the document')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
