#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/home identity-reading rig.
//
//   node scripts/test-home.ts        (Node ≥ 23.6 strips types natively)
//
// WHAT THIS PROVES. Home shows a deck's title and format without EXECUTING the
// file, because a `.bento.html` is arbitrary HTML with arbitrary script and
// home holds a store of writable file handles. The parser is therefore a
// security boundary, not a convenience, and its failure modes matter:
//
//   1. A PASSWORD-PROTECTED deck must never surface a title. The whole point of
//      encrypting it is that the contents are not readable; a launcher that
//      listed "Q4 Board Review — encrypted" would leak the thing the password
//      exists to hide.
//   2. It must not be fooled into treating non-Bento HTML as a deck, and must
//      not throw on it either — home lists what it can and stays quiet about
//      the rest.
//   3. It must survive the `<` escaping the splice contract mandates,
//      because that is how every real Bento file on disk is written.

import { metaFromText, isBento, displayName } from '../home/src/deckmeta.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

const shell = (body: string, generator = 'bento-slides') =>
  `<!doctype html><html><head><meta name="generator" content="${generator}">` +
  `<script type="application/bento+json" id="bento-doc">${body}</${'script'}></head><body></body></html>`

// ---- an ordinary deck -------------------------------------------------------
const plain = metaFromText(shell(JSON.stringify({ format: 'bento/slides', title: 'Q4 Review', docId: 'x' })))
ok(plain.format === 'bento/slides', 'reads the format')
ok(plain.title === 'Q4 Review', 'reads the title')
ok(plain.generator === 'bento-slides', 'reads the generator meta')
ok(isBento(plain), 'recognises a Bento document')

// ---- the escaping every real file uses --------------------------------------
// The splice contract escapes `<` as < so the block can never contain
// `</script>`. JSON.parse handles the escape, so a title with markup survives.
const escaped = shell('{"format":"bento/slides","title":"A \\u003cb\\u003ebold\\u003c/b\\u003e title"}')
ok(metaFromText(escaped).title === 'A <b>bold</b> title', 'survives \\u003c escaping')

// ---- the case that was silently broken --------------------------------------
// A deck with two embedded photos carries 720KB of JSON, one with video 3.2MB.
// The head read deliberately stops long before that, so the block's CLOSING tag
// is not in it. Requiring the close before parsing meant every deck with an
// image in it showed no title at all — found by testing real files, not
// fixtures, which is the only reason it was found.
{
  const huge = '<!doctype html><html><head><meta name="generator" content="bento-slides">' +
    '<script type="application/bento+json" id="bento-doc">' +
    '{"format":"bento/slides","version":"1.0.0","docId":"x","title":"Deck With Photos",' +
    '"assets":{"ph-1":"data:image/jpeg;base64,' + 'A'.repeat(400_000)
  // …and the file simply continues past the end of what we read: no close tag.
  const m = metaFromText(huge.slice(0, 256 * 1024))
  ok(m.title === 'Deck With Photos', 'reads the title of a deck whose block exceeds the head read')
  ok(m.format === 'bento/slides', 'reads the format of a truncated block')
  ok(isBento(m), 'a truncated block still identifies as Bento')
}

// A truncated ENCRYPTED block must still refuse to show a title — the fallback
// path must not be a way around the check that matters.
{
  const encHuge = '<html><head><script id="bento-doc">' +
    '{"format":"bento/enc","v":1,"title":"SECRET","salt":"' + 'B'.repeat(400_000)
  const m = metaFromText(encHuge.slice(0, 256 * 1024))
  ok(m.encrypted === true, 'a truncated encrypted envelope is still marked encrypted')
  ok(!JSON.stringify(m).includes('SECRET'), 'a truncated encrypted envelope leaks no title')
}

// ---- encryption: the leak that must not happen ------------------------------
for (const [label, body] of [
  ['a bento/enc envelope', JSON.stringify({ format: 'bento/enc', v: 1, title: 'SECRET', salt: 's', iv: 'i', data: 'd' })],
  ['a minimal envelope', JSON.stringify({ format: 'bento/enc', title: 'SECRET' })],
] as const) {
  const m = metaFromText(shell(body))
  ok(m.encrypted === true, `${label} is marked encrypted`)
  ok(m.title === undefined, `${label} exposes NO title`)
  ok(!JSON.stringify(m).includes('SECRET'), `${label} leaks nothing anywhere in the result`)
}

// ---- things that are not decks ----------------------------------------------
ok(!isBento(metaFromText('<html><body>hello</body></html>')), 'plain HTML is not a Bento document')
ok(!isBento(metaFromText('')), 'empty input is not a Bento document')
ok(metaFromText('<html>' + '<scr' + 'ipt id="bento-doc">not json</' + 'script>').title === undefined,
  'a non-JSON block yields no title rather than throwing')
ok(metaFromText(shell('')).format === undefined,
  'a pristine shell (empty block) has no format — it is a real file with no document yet')
ok(metaFromText(shell('')).generator === 'bento-slides',
  '…but its generator still identifies it')

// ---- display naming ---------------------------------------------------------
ok(displayName({ title: 'Real Title' }, 'file.bento.html') === 'Real Title', 'prefers the deck title')
ok(displayName({}, 'Q3-board.bento.html') === 'Q3-board', 'falls back to the file name, suffix stripped')
ok(displayName({ title: '   ' }, 'Q3-board.bento.html') === 'Q3-board', 'a blank title falls back too')
ok(displayName({ title: undefined }, 'notes.html') === 'notes', 'strips a plain .html suffix')

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
