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
import { tokenize, normLang, langLabel, CODE_LANGS } from '../spaces/src/highlight.ts'
import { escText } from '../spaces/src/sanitize.ts'

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

// ---- syntax highlighting: the tokenizer is TOTAL, and cannot emit text ------
// Highlighting is applied at render time and must never touch the document, so
// the guarantee has to be structural rather than a promise. `tokenize` returns
// {kind, a, b} ranges into the caller's string — it has no way to produce a
// character the input did not contain, let alone markup — and the tokens
// PARTITION the input exactly. Sum the slices and you get the source back,
// byte for byte, for every language, including on input designed to break a
// lexer: an unterminated string, a lone backslash at EOF, a `</script>`, a
// smuggled `<img onerror>`.
//
// The partition is also what makes the renderer's job safe: it walks the ranges
// and builds one text node per token, so a bug here degrades to wrong COLOUR,
// never to wrong text and never to markup.
{
  const LANGS = CODE_LANGS.map((l) => l.id)
  ok(LANGS.length >= 9 && LANGS[0] === '', 'the picker offers plain text first, then the languages')

  const corpus = [
    '',
    'plain words with no syntax at all',
    'const a = 1 // done\n/* block\n   comment */\nfoo("bar", `t${x}`)',
    'def f(x):\n    """doc"""\n    return {\'k\': [1, 2.5e-3, 0xff]}\n@dec\nclass C: pass',
    '#!/bin/sh\nset -eu\necho "${HOME}/x" | grep -c \'a\'  # trailing note\ncurl host/p#frag',
    '{"a": 1, "b": [true, null], "c": {"d": "e"}}',
    'on: push\njobs:\n  build:\n    runs-on: ubuntu-latest   # comment\n    steps: []',
    "SELECT * FROM t WHERE name = 'it''s' -- note\n/* x */ ORDER BY id DESC;",
    '<!doctype html>\n<div class="a" data-x=\'y\'>text &amp; more</div><!-- c -->\n<br/>',
    ':root { --x: 1; }\n.a:hover, #main { color: #1c4fb5; margin: -2.5rem 0 !important }\n@media print { }',
    // hostile / degenerate
    '</script><script>alert(1)</script>',
    '<img src=x onerror="alert(1)">',
    '"never closed',
    "'\\",
    '/* never closed',
    '`multi\nline\ntemplate`',
    '<div attr="never closed',
    '<<<>>>< <',
    '\r\n\t\u0000\u00a0',
    '\\\\\\',
    '𝔘𝔫𝔦 "🎉" — 中文 # x',
    '#',
    '@',
    '$',
    '0x',
    '1e',
    '...',
    '---',
    'a'.repeat(5000),
  ]

  let bad = 0
  let lossy = 0
  let split = 0
  let stringy = 0
  for (const lang of [...LANGS, 'rust', 'NOT-A-LANGUAGE', 'JavaScript', '.py']) {
    for (const text of corpus) {
      const toks = tokenize(text, lang)
      let at = 0
      let joined = ''
      for (const tk of toks) {
        if (tk.a !== at || tk.b <= tk.a || tk.b > text.length) bad++
        // a token carrying a STRING would be a way for markup to appear; the
        // shape is the guarantee, so it is asserted rather than assumed
        if (Object.values(tk).some((v) => typeof v !== 'number' && typeof v !== 'string')) stringy++
        if (typeof (tk as Record<string, unknown>).text === 'string') stringy++
        // never cut a surrogate pair in half — the renderer makes one text node
        // per token, and half a pair renders as U+FFFD
        if (tk.a > 0 && text.charCodeAt(tk.a - 1) >= 0xd800 && text.charCodeAt(tk.a - 1) <= 0xdbff) split++
        joined += text.slice(tk.a, tk.b)
        at = tk.b
      }
      if (at !== text.length) bad++
      if (joined !== text) lossy++
    }
  }
  ok(bad === 0, `tokens PARTITION the input exactly, for every language and every input (${bad} violations)`)
  ok(lossy === 0, `reassembling the tokens reproduces the source byte for byte (${lossy} losses)`)
  ok(stringy === 0, 'a token is offsets only — it carries no text, so it cannot carry markup')
  ok(split === 0, 'no token boundary falls inside a surrogate pair')

  // an unknown or absent language is ONE plain token, deliberately: the
  // fallback has to look like a decision, not like a lexer that gave up midway
  for (const lang of [undefined, '', 'rust', 'brainfuck', 42, null]) {
    const toks = tokenize('let x = "s" // c', lang)
    ok(toks.length === 1 && toks[0].k === '' && toks[0].a === 0 && toks[0].b === 16,
      `lang=${JSON.stringify(lang)} renders as one plain run`)
  }

  // aliases people actually type in a fence
  for (const [raw, want] of [
    ['javascript', 'js'], ['JS', 'js'], ['  tsx ', 'ts'], ['.py', 'py'], ['bash', 'sh'],
    ['yml', 'yaml'], ['psql', 'sql'], ['svg', 'html'], ['rust', ''], ['', ''],
  ] as const) {
    ok(normLang(raw) === want, `normLang(${JSON.stringify(raw)}) = ${JSON.stringify(want)}`)
  }
  ok(langLabel('bash') === 'Shell', 'a known tag shows its language name')
  ok(langLabel('rust') === 'rust', 'an UNKNOWN tag shows itself, so a plain block explains why it is plain')

  /** The kind of the token covering `needle`'s first occurrence. */
  const kindAt = (text: string, lang: string, needle: string, nth = 0): string => {
    let at = -1
    for (let i = 0; i <= nth; i++) at = text.indexOf(needle, at + 1)
    const tk = tokenize(text, lang).find((t) => t.a <= at && t.b >= at + needle.length)
    return tk ? tk.k : '?'
  }

  const cases: Array<[string, string, string, string]> = [
    // language, source, needle, expected kind
    ['js', 'const x = 1 // hi', 'const', 'k'],
    ['js', 'const x = 1 // hi', '// hi', 'c'],
    ['js', 'const x = 1 // hi', '1', 'n'],
    ['js', 'f("a\\"b", 2)', '"a\\"b"', 's'],
    ['js', 'x = `a\nb`', '`a\nb`', 's'],
    ['js', 'JSON.parse(s)', 'JSON', 'l'],
    ['ts', 'let a: string = "x"', 'string', 'l'],
    ['py', 'def f():\n  return None', 'def', 'k'],
    ['py', 'x = """a\nb"""', '"""a\nb"""', 's'],
    ['py', '@cache\ndef f(): pass', '@cache', 'k'],
    ['sh', 'echo "$HOME"', 'echo', 'l'],
    ['sh', 'echo $HOME', '$HOME', 'l'],
    ['sh', 'curl host/p#frag', '#frag', ''],            // NOT a comment
    ['sh', 'ls  # really a comment', '# really a comment', 'c'],
    ['sh', "echo 'C:\\'", "'C:\\'", 's'],               // no backslash escapes
    ['json', '{"a": 1}', '"a"', 'p'],                   // a key, not a value
    ['json', '{"a": "b"}', '"b"', 's'],
    ['json', '{"a": null}', 'null', 'l'],
    ['yaml', 'on: push', 'on', 'p'],                    // key beats the literal
    ['yaml', 'x: on', 'on', 'l'],
    ['yaml', 'runs-on: x', 'runs-on', 'p'],
    ['sql', 'select * from t', 'select', 'k'],
    ['sql', 'SELECT * FROM t', 'SELECT', 'k'],          // case-insensitive
    ['sql', "a = 'it''s'", "'it''s'", 's'],
    ['sql', 'x -- note', '-- note', 'c'],
    ['css', '.a { color: red }', 'color', 'p'],
    ['css', '.a { color: #1c4fb5 }', '#1c4fb5', 'n'],
    ['css', '#main { }', '#main', ''],                  // an id is not a colour
    ['css', '@media print {}', '@media', 'k'],
    ['css', 'a { margin: 10px }', '10px', 'n'],
    ['html', '<div class="a">t</div>', '<div', 'k'],
    ['html', '<div class="a">t</div>', 'class', 'p'],
    ['html', '<div class="a">t</div>', '"a"', 's'],
    ['html', '<div>text</div>', 'text', ''],
    ['html', '<!-- c --><p>', '<!-- c -->', 'c'],
  ]
  for (const [lang, src, needle, want] of cases) {
    const got = kindAt(src, lang, needle)
    ok(got === want, `${lang}: ${JSON.stringify(needle)} in ${JSON.stringify(src).slice(0, 34)} → "${got}" (want "${want}")`)
  }

  // an unterminated string stops at the line, not at end of file: half-written
  // code is the normal state of a code block, and one stray quote must not turn
  // the rest of the block into a string while you are typing
  {
    const src = 'a = "oops\nb = 2\nc = 3'
    ok(kindAt(src, 'js', '"oops') === 's' && kindAt(src, 'js', 'b = ') === '',
      'an unterminated string ends at the newline, not at end of file')
  }
}

// ---- what a code block STORES is plain text, and it round-trips -------------
// Colour is applied at render time; `Block.html` stays what it always was.
// `escText` is what the editor writes back, and it must be the exact inverse of
// the html parser's text decode — otherwise every save of an untouched block
// differs from the one before it, forever, in a format with no server to fix it.
{
  const decode = (s: string): string =>
    s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

  const texts = [
    'const a = 1',
    'if (a < b && c > d) {}',
    '</script><script>alert(1)</script>',
    '<img src=x onerror="alert(1)">',
    'q = "double" and \'single\'',
    'a &amp; b',                 // already-escaped-looking text must survive
    'tab\there\nnewline\n\n',
    '𝔘𝔫𝔦 🎉 中文',
  ]
  let round = 0
  for (const s of texts) if (decode(escText(s)) !== s) round++
  ok(round === 0, 'escText round-trips through an html text decode, exactly')
  ok(!escText('say "hi"').includes('&quot;'),
    'escText leaves quotes alone — escaping them would make every save differ from the last')
  ok(escText('a & b') === 'a &amp; b' && escText('<i>') === '&lt;i&gt;',
    'escText escapes &, < and > — so a code block can never close its own tag')

  // and the whole document round-trips with code blocks in it
  const withCode = doc({
    pages: [{
      id: 'p1', title: 'Code', blocks: [
        { id: 'b1', type: 'code', lang: 'js', html: escText('const a = "<b>" // &') },
        { id: 'b2', type: 'code', lang: 'rust', html: escText('fn main() {}') },
        { id: 'b3', type: 'code', html: escText('no language at all') },
      ],
    }],
  })
  const r = parseDoc(withCode)
  ok(r.ok, 'a document full of code blocks parses')
  if (r.ok) {
    ok(r.doc.pages[0].blocks[0].html === 'const a = "&lt;b&gt;" // &amp;',
      'a code block\'s html survives parse untouched')
    ok(r.doc.pages[0].blocks[1].lang === 'rust',
      'a language this build cannot highlight is PRESERVED, not normalised away')
    const again = parseDoc(JSON.stringify(r.doc))
    ok(again.ok && JSON.stringify(again.doc.pages) === JSON.stringify(r.doc.pages),
      'and a second round trip changes nothing')
  }
}

// ---- highlighting builds NODES, never a string of markup -------------------
// The tokenizer cannot emit text (above), so the only place markup could enter
// is the painter. It must build with createElement/createTextNode and assign
// through textContent/Text.data — never innerHTML, which is how every other
// highlighter on the web does it and why they all need their own escaper.
{
  const fs = await import('node:fs')
  const read = (f: string) => fs.readFileSync(new URL(`../spaces/src/${f}`, import.meta.url), 'utf8')

  const hl = read('highlight.ts')
  ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\./.test(hl),
    'highlight.ts touches no DOM at all — it is a pure string→ranges function')

  const ren = read('render.ts')
  const paint = /export function paintCode[\s\S]*?\n}\n/.exec(ren)?.[0] ?? ''
  ok(paint.length > 0, 'render.ts exports paintCode')
  ok(!/innerHTML/.test(paint), 'paintCode never assigns innerHTML')
  ok(/createTextNode/.test(paint) && /createElement/.test(paint),
    'paintCode builds text nodes and elements')
  ok(/text\.slice\(tk\.a, tk\.b\)/.test(paint),
    'every painted string is a SLICE OF THE INPUT, so colouring cannot invent a character')

  // and the editor must read a code host as TEXT. Reading innerHTML there would
  // write the colour spans into the document — a permanent format change for a
  // render-time feature.
  const ed = read('editor.ts')
  const wireCode = /private wireCode[\s\S]*?\n  }\n/.exec(ed)?.[0] ?? ''
  ok(wireCode.length > 0, 'editor.ts has a dedicated code-block host')
  ok(!/innerHTML/.test(wireCode) && /host\.textContent/.test(wireCode),
    'the code host is read as textContent — colour spans never reach the model')
  ok(/escText\(text\)/.test(wireCode), 'and stored through escText')

  // A code block is TEXT: Enter must insert a newline rather than split the
  // block, because the model is now read from textContent and a `<br>` or a
  // wrapping `<div>` (which is what some engines insert) would vanish from it.
  ok(/b\.type === 'code'[\s\S]{0,400}insertText\('\\n'\)/.test(ed),
    'Enter inside a code block inserts a newline instead of splitting the block')

  // THE TRAILING SPACE IS NOT A SPACE. Measured in Chrome on the built shell:
  // after typing "## " into an empty block, `host.textContent` is
  // ['#','#',160] — the engine inserts U+00A0 so the space cannot collapse — so
  // `/^## $/` never matched and EVERY space-completed markdown trigger was
  // dead. The ```lang fence needs the same trailing space, which is how this
  // surfaced. The normalisation is applied to the test text only, never to the
  // model.
  ok(/replace\(\/\\u00a0\/g, ' '\)/.test(ed),
    'autoformat normalises the NBSP a browser inserts for a trailing space')
  ok(!/\u00a0/.test(ed), 'and editor.ts carries no LITERAL invisible NBSP, which would not survive retyping')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
