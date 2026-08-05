#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The bento/spaces agent surface: validate() and the seven patch verbs.
//
//   node scripts/test-spaces-agent.ts
//
// WHY THIS EXISTS. `spaces/src/agent.ts` is ~900 lines and shipped with ZERO
// automated coverage — the slides validator has its own rig, and the spaces
// model rig never imported this file. Two of the five defects an adversarial
// review found in round 2 were in here, including a page-cycle walk that hung
// the tab forever, and both were found by a person reading code rather than by
// anything that runs.
//
// WHAT IS WORTH ASSERTING, and what is not:
//
//  · validate() is only useful if it is TRUSTED, and trust is destroyed by
//    false positives, not by misses. An agent that gets warnings for good
//    documents learns to ignore warnings — so "silent on documents that are
//    unusual but CORRECT" matters more here than any single check firing.
//
//  · The patch verbs are an API other code will be built on. Each one must
//    refuse a read-only document, refuse input it cannot honour, and — the
//    thing that actually bites — never produce a document THIS BUILD COULD NOT
//    HAVE PRODUCED ITSELF: no unsanitized html, no duplicate ids, no parent
//    cycles, no block parented across pages.
//
//  · Termination. A walk over author-supplied parent links must end. The
//    review found one that did not, and `parseDoc` preserves the cycle that
//    triggers it, so it arrives from any hand-edited or mailed file.
//
// These run in node against the real modules. agent.ts is DOM-free by
// construction (it plans mutations; the editor applies them), which is what
// makes this rig possible at all — and is worth preserving.

import { parseDoc, FORMAT, type SpacesDoc } from '../spaces/src/model.ts'
import { starterDoc } from '../spaces/src/starter.ts'
import {
  validateDoc, outlineDoc, statsDoc,
  planInsertBlocks, planUpdateBlock, planRemoveBlocks, planMoveBlock,
  planUpdatePage, planRemovePage,
} from '../spaces/src/agent.ts'

let checks = 0
let failures = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

/** A document, through the real loader, so ids and defaults are real. */
function load(pages: unknown[], extra: Record<string, unknown> = {}): SpacesDoc {
  const r = parseDoc(JSON.stringify({
    format: FORMAT, version: 1, docId: 'test', title: 'Test', home: (pages[0] as { id: string })?.id,
    theme: { background: '#fff', color: '#1E2A3A', accent: '#F7A600', measure: 720 },
    pages, ...extra,
  }))
  if (!r.ok) throw new Error('fixture did not parse')
  return r.doc
}

const p = (id: string, blocks: unknown[], extra: Record<string, unknown> = {}) =>
  ({ id, title: id, blocks, ...extra })
const b = (id: string, type = 'p', extra: Record<string, unknown> = {}) =>
  ({ id, type, html: `text ${id}`, ...extra })

/** Apply a plan the way main.ts's run() does, so the test exercises the real path. */
function apply<T extends object>(plan: ReturnType<typeof planInsertBlocks> | any): any {
  if (!plan.ok) return plan
  const { apply: fn, ...rest } = plan
  fn()
  return rest
}

console.log('bento/spaces agent surface\n')

// ---- validate() is SILENT on documents that are correct --------------------
// The failure mode that makes a validator worthless is the false positive.
{
  const starter = starterDoc()
  const v = validateDoc(starter as unknown as SpacesDoc)
  ok(v.findings.length === 0,
    `the shipped starter space is clean (${v.findings.length} finding(s): ${v.findings.map((f) => f.code).join(', ')})`)

  // unusual, but perfectly legal documents
  const odd: Array<[string, SpacesDoc]> = [
    ['a page holding only an image', load([p('p1', [b('b1', 'image', { src: 'asset:k', alt: 'a photo', w: 10, h: 10 })])], { assets: { k: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=' } })],
    ['a single empty paragraph', load([p('p1', [{ id: 'b1', type: 'p', html: '' }])])],
    ['a deeply nested toggle', load([p('p1', [
      b('t1', 'toggle', { open: true }), b('t2', 'toggle', { open: true, parent: 't1' }), b('b3', 'p', { parent: 't2' }),
    ])])],
    ['an unknown block type from a newer build', load([p('p1', [b('b1', 'somethingnew')])])],
    ['a page with no children and no links', load([p('p1', [b('b1')]), p('p2', [b('b2')])])],
  ]
  for (const [label, doc] of odd) {
    const r = validateDoc(doc)
    const errs = r.findings.filter((f) => f.severity === 'error')
    ok(errs.length === 0, `${label}: no ERRORS (${errs.map((f) => f.code).join(', ') || 'none'})`)
  }

  // …and a 500-page space is not itself a problem
  const many = load(Array.from({ length: 500 }, (_, i) => p(`p${i}`, [b(`b${i}`)])))
  const big = validateDoc(many)
  ok(big.findings.filter((f) => f.severity === 'error').length === 0,
    'a 500-page space raises no errors')
}

// ---- …and specific on documents that are broken ---------------------------
{
  const broken = load([
    p('p1', [
      { id: 'dup', type: 'p', html: 'see <a href="#p/ghost">a dead link</a>' },
      { id: 'dup', type: 'p', html: 'a duplicate id' },
      { id: 'b3', type: 'wat', html: 'unknown type' },
      { id: 'b4', type: 'image', src: 'https://example.com/x.png' },
      { id: 'b5', type: 'p', html: '<p>block markup inside inline html</p>' },
    ]),
  ], { home: 'nope' })
  const codes = new Set(validateDoc(broken).findings.map((f) => f.code))
  for (const want of ['broken-link', 'unknown-block-type', 'no-such-home', 'block-markup']) {
    ok(codes.has(want), `a broken document reports ${want} (got: ${[...codes].join(', ')})`)
  }
  ok(validateDoc(broken).findings.every((f) => !!f.fix && !!f.message),
    'every finding says what is wrong AND how to fix it')

  // a LEGAL block anchor is not a broken link — the review found this reported
  // as severity ERROR with a fix that would have destroyed a working link
  const anchored = load([p('p1', [{ id: 'b1', type: 'p', html: 'see <a href="#p/p2/b9">that block</a>' }]), p('p2', [b('b9')])])
  ok(!validateDoc(anchored).findings.some((f) => f.code === 'broken-link'),
    'a #p/<page>/<block> anchor is not reported as broken')
}

// ---- every write verb refuses what it cannot honour ------------------------
{
  const doc = load([p('p1', [b('b1'), b('b2')]), p('p2', [b('b3')])])

  const refusals: Array<[string, { ok: boolean }]> = [
    ['insertBlocks into a page that does not exist', planInsertBlocks(doc, 'nope', null, [{ type: 'p' }]) as never],
    ['updateBlock on a block that does not exist', planUpdateBlock(doc, 'nope', { html: 'x' }) as never],
    ['updateBlock deleting `type`', planUpdateBlock(doc, 'b1', { type: undefined, __delete: ['type'] }) as never],
    ['moveBlock to a page that does not exist', planMoveBlock(doc, 'b1', { pageId: 'nope' }) as never],
    ['updatePage making a page its own parent', planUpdatePage(doc, 'p1', { parent: 'p1' }) as never],
    ['removePage that does not exist', planRemovePage(doc, 'nope') as never],
  ]
  for (const [label, plan] of refusals) ok(plan.ok === false, `refuses: ${label}`)

  // a refusal must SAY why — an agent cannot act on a bare null
  const bad = planUpdatePage(doc, 'p1', { parent: 'p1' }) as { ok: false; err?: string; detail?: string }
  ok(bad.ok === false && !!bad.err, 'a refusal carries a machine-readable code')
}

// ---- the verbs cannot produce a document this build could not produce ------
{
  // 1. html goes through the sanitizer on the way IN
  const doc = load([p('p1', [b('b1')])])
  apply(planInsertBlocks(doc, 'p1', null, [{ type: 'p', html: '<img src=x onerror="alert(1)"><p>block</p>hi' }]))
  const added = doc.pages[0].blocks[doc.pages[0].blocks.length - 1]
  ok(!/onerror|<img|<p>/i.test(added.html ?? ''),
    `inserted html is sanitized (${(added.html ?? '').slice(0, 40)})`)

  // 2. ids are unique, and minted rather than taken from the caller
  const doc2 = load([p('p1', [b('b1')])])
  apply(planInsertBlocks(doc2, 'p1', null, [{ id: 'b1', type: 'p', html: 'tries to reuse an id' }]))
  const ids = doc2.pages.flatMap((pg) => pg.blocks.map((x) => x.id))
  ok(new Set(ids).size === ids.length, 'an insert cannot reuse an existing block id')

  // 3. a type change runs the registry's init, so the block is complete
  const doc3 = load([p('p1', [b('b1')])])
  apply(planUpdateBlock(doc3, 'b1', { type: 'todo' }))
  ok(doc3.pages[0].blocks[0].done === false, 'retyping to `todo` initialises `done`')
  apply(planUpdateBlock(doc3, 'b1', { type: 'callout' }))
  ok(typeof doc3.pages[0].blocks[0].tone === 'string', 'retyping to `callout` initialises `tone`')

  // 4. a removed container takes its children with it, or they resurrect
  const doc4 = load([p('p1', [b('t1', 'toggle', { open: true }), b('c1', 'p', { parent: 't1' }), b('after')])])
  apply(planRemoveBlocks(doc4, ['t1']))
  const left = doc4.pages[0].blocks.map((x) => x.id)
  ok(!left.includes('c1'), `removing a container removes its children (left: ${left.join(', ')})`)
  ok(left.includes('after'), '…and nothing else')
}

// ---- walks over author-supplied links must TERMINATE -----------------------
// parseDoc keeps a cycle (it only drops parents naming no page), so this
// arrives from any hand-edited or mailed file — and the sequence is the
// RECOMMENDED one: validate() reports the cycle, an agent re-homes a page to
// fix it, and that call used to hang the tab with every unsaved edit in it.
{
  const cyclic = load([
    p('A', [b('a1')], { parent: 'B' }),
    p('B', [b('b1')], { parent: 'A' }),
    p('C', [b('c1')]),
  ])
  ok(cyclic.pages.find((x) => x.id === 'A')?.parent === 'B', 'a page cycle survives loading (so it must be handled)')

  // IN A CHILD PROCESS, with a hard timeout.
  //
  // Measuring elapsed time AFTER the call cannot report a call that never
  // returns: the first version of this hung the whole rig, so CI would have
  // timed out with nothing to read instead of naming the defect. A non-
  // terminating walk is exactly the failure being guarded, so the guard has to
  // survive it.
  const { execFileSync } = await import('node:child_process')
  const probe = (expr: string, label: string) => {
    const src =
      `import { parseDoc, FORMAT } from '${new URL('../spaces/src/model.ts', import.meta.url).pathname}';` +
      `import * as A from '${new URL('../spaces/src/agent.ts', import.meta.url).pathname}';` +
      `const r = parseDoc(JSON.stringify({format:FORMAT,version:1,docId:'c',title:'c',home:'A',pages:[` +
      `{id:'A',title:'A',parent:'B',blocks:[{id:'a1',type:'p',html:'a'}]},` +
      `{id:'B',title:'B',parent:'A',blocks:[{id:'b1',type:'p',html:'b'}]},` +
      `{id:'C',title:'C',blocks:[{id:'c1',type:'p',html:'c'}]}]}));` +
      `${expr};`
    try {
      execFileSync(process.execPath, ['--input-type=module', '-e', src], { timeout: 8000, stdio: 'pipe' })
      return true
    } catch {
      return false
    }
  }
  ok(probe(`A.planUpdatePage(r.doc, 'C', { parent: 'A' })`, ''), 'updatePage terminates on a page cycle')
  ok(probe(`A.validateDoc(r.doc)`, ''), 'validate terminates on a page cycle')
  ok(probe(`A.outlineDoc(r.doc)`, ''), 'outline terminates on a page cycle')
  ok(probe(`A.statsDoc(r.doc)`, ''), 'stats terminates on a page cycle')
}

// ---- outline() and stats() describe the document they were given -----------
{
  const doc = load([
    p('p1', [b('b1', 'h1'), b('b2'), b('b3')]),
    p('p2', [b('b4')], { parent: 'p1' }),
    p('p3', [b('b5')], { archived: true }),
  ])
  const o = outlineDoc(doc)
  ok(o.pages === 3 && o.blocks === 5, `outline counts the space (${o.pages} pages, ${o.blocks} blocks)`)
  // FLAT and in pre-order, with `depth` and `parent` — the same convention the
  // document itself uses for pages and blocks, so an agent that can read one
  // can read the other. (Nested children would be a second shape to learn.)
  const tree = o.tree as Array<{ id: string; depth: number; parent?: string }>
  ok(tree.length === 3, `outline's tree holds every page (${tree.length})`)
  ok(tree.every((n) => typeof n.depth === 'number'), 'every node carries its depth')
  const child = tree.find((x) => x.id === 'p2')
  ok(child?.depth === 1 && child?.parent === 'p1', 'a child page reports depth 1 and names its parent')
  ok(tree.findIndex((x) => x.id === 'p1') < tree.findIndex((x) => x.id === 'p2'),
    'and a child always follows its parent, so one forward pass rebuilds the tree')

  const s = statsDoc(doc)
  ok(s.pages === 3 && s.blocks === 5, `stats counts pages and blocks (${s.pages}/${s.blocks})`)
  ok(s.archived === 1, 'stats counts archived pages separately')
  ok(s.bytes.document > 0, 'stats reports a document size, so "why is this file large" is answerable')
  ok(typeof s.todos.total === 'number', 'stats reports to-do progress')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
