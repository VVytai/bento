#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The document-shape seam: one engine, two document shapes.
//
//   node scripts/test-sync-shape.ts
//
// WHAT THIS IS FOR. scripts/test-sync-equiv.ts proves the parameterized engine
// still mints the bytes every shipped bento/slides file was written with — it
// is a NEGATIVE property, and a parameterization that quietly did nothing
// would sail through it. Nothing yet proved the POSITIVE one: that binding a
// second shape produces an engine that actually works on a document of that
// shape.
//
// This is that check, and it is deliberately small. The full bento/spaces
// convergence rig belongs with the spaces binding; what belongs here is the
// evidence that the seam is real — because the seam is what the whole
// collaboration project rests on, and "it compiles" is not evidence.
//
// It is also where the constructor contract is pinned: the engine takes its
// shape with NO DEFAULT. A default is precisely how a spaces call site ends up
// silently holding slides' shape, and the resulting room cannot be repaired in
// the field.

import { SyncEngine, SyncState, SLIDES_SHAPE } from '../slides/src/sync/crdt.ts'
import type { DocShape } from '../slides/src/sync/crdt.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

console.log('bento-sync — the document-shape seam\n')

/** bento/spaces: pages hold blocks. The binding spaces will ship. */
const SPACES_SHAPE: DocShape = {
  parents: 'pages',
  children: 'blocks',
  skipDoc: new Set(['pages', 'modified', 'collab', 'format', 'version']),
}
class SpacesSync extends SyncEngine {
  constructor(actor: string) { super(actor, SPACES_SHAPE) }
}

const spacesDoc = (blocks: unknown[]) => ({
  format: 'bento/spaces', version: 1, docId: 'd', title: 'S', home: 'p1',
  pages: [{ id: 'p1', title: 'Page one', blocks }],
}) as never

// ---- a second shape produces a WORKING engine ------------------------------
{
  const A = new SpacesSync('alice')
  const B = new SpacesSync('bob')
  const dA = spacesDoc([{ id: 'b1', type: 'p', html: 'hello' }]) as never as Record<string, never>
  A.adopt(dA as never)
  const dB = JSON.parse(JSON.stringify(dA))
  B.adopt(dB)

  // concurrent: alice types into a block, bob adds one
  const beforeA = JSON.parse(JSON.stringify(dA))
  ;(dA as never as { pages: { blocks: { html: string }[] }[] }).pages[0].blocks[0].html = 'hello world'
  const opsA = A.diff(beforeA, dA as never, { text: true })

  const beforeB = JSON.parse(JSON.stringify(dB))
  dB.pages[0].blocks.push({ id: 'b2', type: 'todo', html: 'a task', done: false })
  const opsB = B.diff(beforeB, dB, { text: true })

  ok(opsA.length === 1 && opsA[0].op === 'txt',
    'a text edit on a BLOCK becomes one RGA delta, exactly as it does for an element')
  ok(String(opsA[0].el) === 'p1' + '\u001f' + 'b1',
    `the node key is the composite pageId\u001fblockId — the page, not the slide (got ${JSON.stringify(String(opsA[0].el))})`)
  ok(opsB.length === 1 && opsB[0].op === 'ins' && opsB[0].sl === 'p1',
    'a new block is an insert parented to its page')

  A.apply(dA as never, opsB)
  B.apply(dB, opsA)
  ok(JSON.stringify(dA) === JSON.stringify(dB), 'the two replicas converge')
  const blocks = (dA as never as { pages: { blocks: { html: string }[] }[] }).pages[0].blocks
  ok(blocks.length === 2 && blocks[0].html === 'hello world',
    'and neither edit was lost: the typed text AND the new block survive')
}

// ---- the shape is per-instance, not per-module -----------------------------
// The failure this prevents is one engine quietly serving both apps with one
// binding, which is unrecoverable once a room exists.
{
  const s = new SyncState('a')
  const p = new SpacesSync('a')
  ok(s.S === SLIDES_SHAPE, 'the slides binding carries the slides shape')
  ok(p.S === SPACES_SHAPE, 'the spaces binding carries the spaces shape')
  ok(s.S !== p.S, 'two engines alive at once do not share one shape')
  ok(SLIDES_SHAPE.skipDoc.has('slides') && SPACES_SHAPE.skipDoc.has('pages'),
    'each shape skips its own container — syncing it as a value would make the whole document one register')
}

// ---- restoring a saved state yields the SAME binding -----------------------
// `static fromJSON` used to construct the base class literally, so a subclass
// restored as something else. For an app binding that means a saved spaces
// file reopening with slides' shape.
{
  const p = new SpacesSync('a')
  const d = spacesDoc([{ id: 'b1', type: 'p', html: 'x' }])
  p.adopt(d)
  const back = SpacesSync.fromJSON('a', p.toJSON())
  ok(back instanceof SpacesSync, 'a restored spaces engine is a spaces engine')
  ok(back.S === SPACES_SHAPE, '…and still carries the spaces shape')
  const slides = SyncState.fromJSON('a', new SyncState('a').toJSON())
  ok(slides instanceof SyncState && slides.S === SLIDES_SHAPE,
    'and the slides binding restores as itself, unchanged')
}

// ---- the slides shape is untouched by any of this --------------------------
{
  ok(SLIDES_SHAPE.parents === 'slides' && SLIDES_SHAPE.children === 'elements',
    'slides still means slides → elements')
  ok([...SLIDES_SHAPE.skipDoc].sort().join(',') === 'collab,format,modified,slides,version',
    'and its skip set is exactly what the shipped engine hardcoded')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
