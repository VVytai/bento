#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// ===========================================================================
//  bento-sync ENGINE EQUIVALENCE rig — baseline vs candidate, BYTE for BYTE.
//
//    node scripts/test-sync-equiv.ts            (Node ≥ 23.6 strips types)
//    SEEDS=200 STEPS=60 ACTORS=4 node scripts/test-sync-equiv.ts
//    SEED_ONLY=17 node scripts/test-sync-equiv.ts        (repro one seed)
//    MUTANT=pos-spread node scripts/test-sync-equiv.ts   (see it fail)
//
//  ┌───────────────────────────────────────────────────────────────────────┐
//  │  LOUD WARNING — AS OF THIS COMMIT THIS RIG PASSES TRIVIALLY.          │
//  │                                                                       │
//  │  There is only ONE engine in the tree today, so the "candidate"       │
//  │  import below resolves to the SAME MODULE as the baseline. Node       │
//  │  dedupes it: baseline === candidate, literally the same object. A     │
//  │  green run here currently proves NOTHING about parameterization —     │
//  │  it proves the comparator runs. The rig announces this at startup     │
//  │  (`NO-OP RUN`) and will announce `LIVE RUN` the moment the candidate  │
//  │  import points somewhere else. Do not read a NO-OP green as safety.   │
//  │                                                                       │
//  │  Because a never-failed comparator is worth nothing, the rig ends     │
//  │  with a SELF-TEST: it builds four deliberately perturbed engines      │
//  │  that are still perfectly CONVERGENT (scripts/test-sync.ts passes     │
//  │  every one of them) and asserts that this rig catches all four. That  │
//  │  is the part of a NO-OP run that does carry signal.                   │
//  └───────────────────────────────────────────────────────────────────────┘
//
//  WHY THIS EXISTS. spaces is getting live collaboration by PARAMETERIZING
//  this engine over a document-shape descriptor (slides→elements becomes
//  pages→blocks) rather than forking it. Every bento/slides file in the
//  field already carries persisted SyncStateJSON and already talks to the
//  deployed relay. If parameterization changes ANY byte the engine mints —
//  an op, a frame, a snapshot, a fractional position key, a lamport
//  ordering — those files diverge from each other silently, in the field,
//  with no way to push a fix.
//
//  scripts/test-sync.ts proves CONVERGENCE, which is strictly weaker: an
//  engine that converges beautifully with ITSELF while minting different
//  bytes than the shipped engine sails straight through it. (The four
//  self-test mutants below are exactly that engine.) This rig is the
//  missing property: the candidate must be OBSERVATIONALLY IDENTICAL to
//  what is already on disk.
//
//  WHAT IT COMPARES, per step, for every actor:
//    1. the op batch just emitted — JSON.stringify of the array, so field
//       ORDER inside each op counts (ops are minted as object literals, so
//       their key order is deterministic and observable on the wire);
//    2. SyncStateJSON — JSON.stringify of toJSON(), so key insertion order
//       counts too (this is the blob stamped into doc.collab.sync; a
//       key-order-only difference is reported as such, not hidden);
//    3. the materialized document — JSON.stringify of the live doc.
//  Plus a scripted scenario suite for the paths random runs never reach:
//  adopt(), mergeSnapshot(), fromJSON(), missingFor(), the pre-v2 reject,
//  the 300KB text RGA, and the duplicate-id morph idiom.
//
//  DETERMINISM. One seeded PRNG stream (mulberry32, shared with
//  test-sync.ts via scripts/lib/sync-fixtures.ts) picks the whole schedule.
//  Each step's mutation is generated from its own sub-seed derived from
//  (seed, step), so a difference in how much randomness one side consumes
//  can never cascade. No Date.now, no unseeded Math.random anywhere: a
//  failure is reproducible from SEED_ONLY alone.

import {
  mulberry32,
  stable,
  baseDoc,
  randomMutation,
  type Doc,
} from './lib/sync-fixtures.ts'

import * as BASELINE_MODULE from '../slides/src/sync/crdt.ts'
// ───────────────────────────────────────────────────────────────────────────
// THE ONE LINE. When the parameterized engine lands, repoint THIS import (and
// nothing else in this file) at it — e.g.
//     import * as CANDIDATE_MODULE from '../kernel/src/sync/crdt.ts'
// and the rig turns from a NO-OP into the gate that protects every shipped
// bento/slides file. If the candidate's entry point needs a shape descriptor,
// bind it in `CANDIDATE` below (the Engine adapter is the seam).
import * as CANDIDATE_MODULE from '../slides/src/sync/crdt.ts'
// ───────────────────────────────────────────────────────────────────────────

// ---------------------------------------------------------------------------
// engine seam — the smallest structural surface both engines must present
// ---------------------------------------------------------------------------

type Op = any
type StateJSON = any

interface EngineState {
  actor: string
  lamport: number
  pos: Record<string, { p: string; o: string; r: [number, string] }>
  adopt(doc: Doc): void
  diff(before: Doc, after: Doc, opts?: { text?: boolean }): Op[]
  apply(doc: Doc, ops: Op[]): { changed: boolean; structure: boolean }
  mergeSnapshot(doc: Doc, rdoc: Doc, rstate: StateJSON): { changed: boolean; structure: boolean }
  missingFor(log: Op[], vv: Record<string, number>): Op[]
  toJSON(): StateJSON
  dead(id: string): boolean
  readonly gappedActors: string[]
}

interface Engine {
  label: string
  SyncState: new (actor: string) => EngineState
  fromJSON: (actor: string, j: StateJSON) => EngineState
}

type CrdtModule = typeof BASELINE_MODULE

function engineOf(label: string, M: CrdtModule): Engine {
  return {
    label,
    SyncState: M.SyncState as unknown as new (actor: string) => EngineState,
    fromJSON: (a, j) => M.SyncState.fromJSON(a, j) as unknown as EngineState,
  }
}

const BASELINE = engineOf('baseline', BASELINE_MODULE)
const CANDIDATE = engineOf('candidate', CANDIDATE_MODULE)
const IS_NOOP = (BASELINE_MODULE as unknown) === (CANDIDATE_MODULE as unknown)

// ---------------------------------------------------------------------------
// replicas and worlds (engine-parameterized twins of test-sync.ts's Replica)
// ---------------------------------------------------------------------------

class Replica {
  doc: Doc
  state: EngineState
  shadow: string
  log: Op[] = []
  undoStack: string[] = []
  counter = 0
  actor: string
  constructor(E: Engine, actor: string, doc: Doc = baseDoc()) {
    this.actor = actor
    this.doc = doc
    this.state = new E.SyncState(actor)
    this.state.adopt(this.doc)
    this.shadow = JSON.stringify(this.doc)
  }
  mutate(fn: (doc: Doc) => void): Op[] {
    this.undoStack.push(this.shadow)
    fn(this.doc)
    return this.flush()
  }
  undo(): Op[] {
    const prev = this.undoStack.pop()
    if (!prev) return []
    this.doc = JSON.parse(prev)
    return this.flush()
  }
  flush(): Op[] {
    const ops = this.state.diff(JSON.parse(this.shadow), this.doc, { text: true })
    this.shadow = JSON.stringify(this.doc)
    this.log.push(...ops)
    return ops
  }
  receive(ops: Op[]) {
    this.state.apply(this.doc, ops)
    this.log.push(...ops)
    this.shadow = JSON.stringify(this.doc)
  }
  /** byte-exact: this is what lands in the saved file */
  docBytes(): string {
    return JSON.stringify(this.doc)
  }
  /** byte-exact: this is what lands in doc.collab.sync */
  stateBytes(): string {
    return JSON.stringify(this.state.toJSON())
  }
  /** key-order-independent view, for telling "reordered" from "different" */
  docCanon(): string {
    return stable(this.doc)
  }
  stateCanon(): string {
    // EVERYTHING toJSON() emits, minus what is legitimately volatile — not a
    // hand-picked list of the fields that existed when this was written. The
    // listed version compared six keys, so a SEVENTH added by the very
    // parameterization this rig exists to check would have been invisible to
    // it: the rig would go green on an engine minting a field the baseline
    // never mints. Deleting is the only direction that fails safe.
    const j = this.state.toJSON() as unknown as Record<string, unknown>
    const canon: Record<string, unknown> = { ...j }
    // dead nodes' text is retained deliberately and is not part of the
    // observable state (see crdt.ts's stash/replay); everything else counts.
    canon.txt = Object.fromEntries(
      Object.entries(j.txt as Record<string, unknown>).filter(([id]) => !this.state.dead(id)),
    )
    return stable(canon)
  }
}

const qk = (f: number, t: number) => `${f}>${t}`

class World {
  reps: Replica[]
  queues = new Map<string, Op[][]>()
  constructor(E: Engine, n: number) {
    this.reps = Array.from({ length: n }, (_, i) => new Replica(E, `a${i}`))
    for (let f = 0; f < n; f++) for (let t = 0; t < n; t++) if (f !== t) this.queues.set(qk(f, t), [])
  }
}

/** One scheduled action. Decided ONCE off the master stream, run on BOTH
 *  worlds — so the two engines are never asked different questions. */
type Step =
  | { t: 'mut'; actor: number; undo: boolean; mseed: number }
  | { t: 'deliver'; edge: string }
  | { t: 'idle' }

/** @returns the actor touched and the ops that moved, or null if the world
 *  could not perform the step (queue shape diverged — itself a finding). */
function exec(w: World, st: Step): { actor: number; ops: Op[] } | null {
  if (st.t === 'idle') return { actor: -1, ops: [] }
  if (st.t === 'mut') {
    const r = w.reps[st.actor]
    if (!r) return null
    const ops = st.undo ? r.undo() : r.mutate(randomMutation(r, mulberry32(st.mseed)))
    if (ops.length) {
      for (let t = 0; t < w.reps.length; t++) {
        if (t !== st.actor) w.queues.get(qk(st.actor, t))!.push(ops)
      }
    }
    return { actor: st.actor, ops }
  }
  const q = w.queues.get(st.edge)
  if (!q || !q.length) return null
  const to = parseInt(st.edge.split('>')[1], 10)
  const ops = q.shift()!
  w.reps[to].receive(ops)
  return { actor: to, ops }
}

// ---------------------------------------------------------------------------
// divergence reporting — someone reads this at 1am
// ---------------------------------------------------------------------------

interface Div {
  what: string
  seed: number
  step: number | string
  actor: string
  a: string
  b: string
  note?: string
  repro?: string
}

let firstDiv: Div | null = null
let divCount = 0

/** first differing character, with context on both sides */
function byteDiff(a: string, b: string): string {
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  const lo = Math.max(0, i - 60)
  const cut = (s: string) => JSON.stringify(s.slice(lo, i + 100))
  return [
    `    first difference at byte ${i} (lengths ${a.length} / ${b.length})`,
    `      baseline : …${cut(a)}`,
    `      candidate: …${cut(b)}`,
  ].join('\n')
}

/** structural paths where two parsed JSON values differ (capped) */
function pathDiff(a: string, b: string, limit = 12): string {
  let av: unknown, bv: unknown
  try {
    av = JSON.parse(a)
    bv = JSON.parse(b)
  } catch {
    return ''
  }
  const out: string[] = []
  const shorten = (v: unknown) => {
    const s = JSON.stringify(v)
    return s === undefined ? 'undefined' : s.length > 90 ? s.slice(0, 90) + '…' : s
  }
  const walk = (x: any, y: any, path: string) => {
    if (out.length >= limit) return
    if (x === y) return
    const xo = x && typeof x === 'object'
    const yo = y && typeof y === 'object'
    if (!xo || !yo || Array.isArray(x) !== Array.isArray(y)) {
      if (JSON.stringify(x) !== JSON.stringify(y)) out.push(`      ${path || '<root>'}: ${shorten(x)}  ≠  ${shorten(y)}`)
      return
    }
    const keys = [...new Set([...Object.keys(x), ...Object.keys(y)])]
    for (const k of keys) {
      // element node keys are composite (slideId U+001F elementId) — an
      // invisible separator in a debug path is a trap, so show it escaped
      const kk = k.replace(/[\u0000-\u001f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
      const p = Array.isArray(x) ? `${path}[${kk}]` : path ? `${path}.${kk}` : kk
      if (!(k in x)) { out.push(`      ${p}: <absent>  ≠  ${shorten(y[k])}`); continue }
      if (!(k in y)) { out.push(`      ${p}: ${shorten(x[k])}  ≠  <absent>`); continue }
      walk(x[k], y[k], p)
      if (out.length >= limit) return
    }
    // same values, different key order → the bytes differ, the meaning doesn't
    if (!out.length && Object.keys(x).join(',') !== Object.keys(y).join(',')) {
      out.push(`      ${path || '<root>'}: same entries, DIFFERENT KEY ORDER`)
    }
  }
  walk(av, bv, '')
  return out.length ? '    diverging paths:\n' + out.join('\n') : ''
}

function reportDiv(d: Div) {
  console.error('')
  console.error('  ╭─ DIVERGENCE ──────────────────────────────────────────────')
  console.error(`  │ what      : ${d.what}`)
  if (d.seed) console.error(`  │ seed      : ${d.seed}`)
  console.error(`  │ step      : ${d.step}`)
  if (d.actor !== '-') console.error(`  │ actor     : ${d.actor}`)
  if (d.note) console.error(`  │ note      : ${d.note}`)
  console.error(
    `  │ reproduce : ${d.repro ?? `SEED_ONLY=${d.seed} STEPS=${STEPS} ACTORS=${ACTORS} node scripts/test-sync-equiv.ts`}`,
  )
  console.error('  ╰───────────────────────────────────────────────────────────')
  console.error(byteDiff(d.a, d.b))
  const p = pathDiff(d.a, d.b)
  if (p) console.error(p)
}

/** @returns true when it diverged */
function cmp(what: string, seed: number, step: number | string, actor: string, a: string, b: string, canon?: [string, string], repro?: string): boolean {
  if (a === b) return false
  divCount++
  const note = canon && canon[0] === canon[1] ? 'KEY ORDER ONLY — same values, different serialized order' : undefined
  const d: Div = { what, seed, step, actor, a, b, note, repro }
  if (!firstDiv) {
    firstDiv = d
    reportDiv(d)
  }
  return true
}

// ---------------------------------------------------------------------------
// the random equivalence run
// ---------------------------------------------------------------------------

const SEEDS = parseInt(process.env.SEEDS ?? '60', 10)
const SEED_ONLY = process.env.SEED_ONLY ? parseInt(process.env.SEED_ONLY, 10) : 0
const STEPS = parseInt(process.env.STEPS ?? '80', 10)
const ACTORS = parseInt(process.env.ACTORS ?? '3', 10)

/**
 * Run one seed against both engines in lockstep.
 * @returns true when the two engines stayed byte-identical.
 */
function equivSeed(A: Engine, B: Engine, seed: number, steps: number, actors: number): boolean {
  const rnd = mulberry32(seed * 7919)
  const wa = new World(A, actors)
  const wb = new World(B, actors)

  // the file as adopted, before anything happens: this is where a changed
  // spreadKey / adoption order shows up first
  for (let i = 0; i < actors; i++) {
    if (checkActor(seed, 'adopt', wa, wb, i)) return false
  }

  for (let s = 0; s < steps; s++) {
    // ---- decide the step off the master stream (baseline world's shape) ----
    let st: Step
    const dice = rnd()
    if (dice < 0.45) {
      const actor = Math.floor(rnd() * actors)
      const undo = rnd() < 0.06
      st = { t: 'mut', actor, undo, mseed: (seed * 1_000_003 + s * 7919 + 17) >>> 0 }
    } else {
      const edges = [...wa.queues.entries()].filter(([, q]) => q.length)
      st = edges.length ? { t: 'deliver', edge: edges[Math.floor(rnd() * edges.length)][0] } : { t: 'idle' }
    }

    // ---- run it on both ----------------------------------------------------
    const ra = exec(wa, st)
    const rb = exec(wb, st)
    if (!ra || !rb) {
      cmp('step could not be replayed (queue shape diverged)', seed, s, st.t === 'mut' ? `a${st.actor}` : st.t,
        JSON.stringify({ ran: !!ra, step: st, queues: [...wa.queues].map(([k, q]) => [k, q.length]) }),
        JSON.stringify({ ran: !!rb, step: st, queues: [...wb.queues].map(([k, q]) => [k, q.length]) }))
      return false
    }

    // 1. the ops this step moved, field order included
    const label = st.t === 'mut' ? (st.undo ? 'undo' : 'mutate') : 'deliver'
    if (cmp(`ops emitted (${label})`, seed, s, `a${ra.actor}`, JSON.stringify(ra.ops), JSON.stringify(rb.ops))) {
      return false
    }
    // 2 + 3. every actor's state and doc
    for (let i = 0; i < actors; i++) if (checkActor(seed, s, wa, wb, i)) return false
  }

  // ---- drain to quiescence, comparing all the way -------------------------
  let moved = true
  let d = 0
  while (moved) {
    moved = false
    for (const [key, q] of wa.queues) {
      if (!q.length) continue
      moved = true
      const st: Step = { t: 'deliver', edge: key }
      const ra = exec(wa, st)
      const rb = exec(wb, st)
      if (!ra || !rb) {
        cmp('drain could not be replayed (queue shape diverged)', seed, `drain:${d}`, key, String(!!ra), String(!!rb))
        return false
      }
      if (cmp('ops emitted (drain)', seed, `drain:${d}`, `a${ra.actor}`, JSON.stringify(ra.ops), JSON.stringify(rb.ops))) return false
      for (let i = 0; i < actors; i++) if (checkActor(seed, `drain:${d}`, wa, wb, i)) return false
      d++
    }
  }
  return true
}

function checkActor(seed: number, step: number | string, wa: World, wb: World, i: number): boolean {
  const a = wa.reps[i]
  const b = wb.reps[i]
  const sa = a.stateBytes()
  const sb = b.stateBytes()
  if (sa !== sb) {
    cmp('SyncStateJSON', seed, step, a.actor, sa, sb, [a.stateCanon(), b.stateCanon()])
    return true
  }
  const da = a.docBytes()
  const db = b.docBytes()
  if (da !== db) {
    cmp('materialized document', seed, step, a.actor, da, db, [a.docCanon(), b.docCanon()])
    return true
  }
  return false
}

// ---------------------------------------------------------------------------
// scripted scenarios — the code paths a random walk never reaches
// ---------------------------------------------------------------------------

type Transcript = Array<[string, string]>
interface Scenario {
  name: string
  run: (E: Engine) => Transcript
}

const J = (v: unknown) => JSON.stringify(v)
const snap = (t: Transcript, label: string, r: Replica) => {
  t.push([`${label}/state`, r.stateBytes()])
  t.push([`${label}/doc`, r.docBytes()])
}

const SCENARIOS: Scenario[] = [
  {
    // The single highest-risk parameterization site: adopt() derives every
    // fractional position key for a file that has never synced. Change it and
    // two copies of one shipped file stop agreeing about order.
    name: 'adopt: fresh file → deterministic pos keys',
    run: (E) => {
      const t: Transcript = []
      const r = new Replica(E, 'A')
      snap(t, 'adopt', r)
      const big: Doc = baseDoc()
      for (let i = 0; i < 25; i++) {
        big.slides.push({ id: `x${i}`, background: '#000', transition: 'none', notes: '', elements: Array.from({ length: 1 + (i % 7) }, (_, j) => ({ id: `x${i}-${j}`, type: 'shape', shape: 'rect', x: j, y: i, w: 10, h: 10, rotation: 0, opacity: 1, fill: '#111', stroke: 'none', strokeWidth: 0, radius: 0 })) })
      }
      const r2 = new Replica(E, 'A', big)
      snap(t, 'adopt-wide', r2)
      return t
    },
  },
  {
    name: 'scripted edits: one replica, every op kind',
    run: (E) => {
      const t: Transcript = []
      const r = new Replica(E, 'A')
      const steps: Array<[string, (d: Doc) => void]> = [
        ['doc-prop', (d) => { d.title = 'Scripted' }],
        ['nested-doc-prop', (d) => { d.theme = { ...d.theme, accent: '#123456' } }],
        ['asset', (d) => { d.assets = { ...d.assets, mark: '<svg id="m"/>' } }],
        ['slide-prop', (d) => { d.slides[0].background = '#abcdef' }],
        ['el-prop', (d) => { d.slides[0].elements[1].x = 640 }],
        ['el-insert', (d) => d.slides[0].elements.push({ id: 'new-1', type: 'shape', shape: 'rect', x: 1, y: 2, w: 30, h: 40, rotation: 0, opacity: 1, fill: '#0f0', stroke: 'none', strokeWidth: 0, radius: 2 })],
        ['el-reorder', (d) => { const [e] = d.slides[0].elements.splice(0, 1); d.slides[0].elements.push(e) }],
        ['el-move-slide', (d) => { const [e] = d.slides[0].elements.splice(0, 1); d.slides[2].elements.push(e) }],
        ['el-delete', (d) => { d.slides[0].elements.splice(0, 1) }],
        ['slide-insert', (d) => d.slides.splice(1, 0, { id: 'ins-1', background: '#222', transition: 'none', notes: 'n', elements: [{ id: 'ins-1-t', type: 'text', x: 0, y: 0, w: 100, h: 20, rotation: 0, opacity: 1, html: 'hi', fontSize: 12, fontFamily: 'x', fontWeight: 400, color: '#fff', align: 'left', valign: 'top', lineHeight: 1.2 }] })],
        ['slide-reorder', (d) => { const [s] = d.slides.splice(0, 1); d.slides.push(s) }],
        ['slide-delete', (d) => { d.slides.splice(0, 1) }],
        ['text-edit', (d) => { const e = d.slides.flatMap((s: any) => s.elements).find((x: any) => typeof x.html === 'string'); if (e) e.html = 'pre ' + e.html + ' post' }],
        ['undo-ish', (d) => { d.title = 'Scripted' }],
      ]
      for (const [label, fn] of steps) {
        const ops = r.mutate(fn)
        t.push([`${label}/ops`, J(ops)])
        snap(t, label, r)
      }
      t.push(['undo/ops', J(r.undo())])
      snap(t, 'undo', r)
      return t
    },
  },
  {
    name: 'gap buffering + catch-up',
    run: (E) => {
      const t: Transcript = []
      const A = new Replica(E, 'A')
      const B = new Replica(E, 'B')
      const b1 = A.mutate((d) => { d.title = 'one' })
      const b2 = A.mutate((d) => { d.title = 'two' })
      const b3 = A.mutate((d) => { d.title = 'three' })
      t.push(['batches', J([b1, b2, b3])])
      B.receive(b3)
      t.push(['gapped', J(B.state.gappedActors)])
      snap(t, 'held', B)
      B.receive(b1)
      snap(t, 'first', B)
      B.receive(b2)
      snap(t, 'drained', B)
      t.push(['gapped-after', J(B.state.gappedActors)])
      return t
    },
  },
  {
    name: 'undo resurrects a deleted slide',
    run: (E) => {
      const t: Transcript = []
      const A = new Replica(E, 'A')
      const B = new Replica(E, 'B')
      const del = A.mutate((d) => d.slides.splice(1, 1))
      t.push(['del/ops', J(del)])
      B.receive(del)
      snap(t, 'B-deleted', B)
      const res = A.undo()
      t.push(['undo/ops', J(res)])
      B.receive(res)
      snap(t, 'B-resurrected', B)
      snap(t, 'A-resurrected', A)
      return t
    },
  },
  {
    name: 'move-out vs slide-delete cascade',
    run: (E) => {
      const t: Transcript = []
      const A = new Replica(E, 'A')
      const B = new Replica(E, 'B')
      const mv = A.mutate((d) => {
        const s1 = d.slides.find((s: any) => s.id === 's1')
        const s3 = d.slides.find((s: any) => s.id === 's3')
        const i = s1.elements.findIndex((e: any) => e.id === 's1-r1')
        const [el] = s1.elements.splice(i, 1)
        s3.elements.push(el)
      })
      const del = B.mutate((d) => d.slides.splice(0, 1))
      t.push(['mv/ops', J(mv)])
      t.push(['del/ops', J(del)])
      A.receive(del)
      B.receive(mv)
      snap(t, 'A', A)
      snap(t, 'B', B)
      return t
    },
  },
  {
    name: 'RGA: concurrent text edits merge',
    run: (E) => {
      const t: Transcript = []
      const A = new Replica(E, 'A')
      const B = new Replica(E, 'B')
      const ea = A.mutate((d) => { const el = d.slides[0].elements[0]; el.html = 'START ' + el.html })
      const eb = B.mutate((d) => { const el = d.slides[0].elements[0]; el.html = el.html + ' END' })
      t.push(['ea', J(ea)])
      t.push(['eb', J(eb)])
      A.receive(eb)
      B.receive(ea)
      snap(t, 'A', A)
      snap(t, 'B', B)
      // same-position runs
      const C = new Replica(E, 'C')
      const D = new Replica(E, 'D')
      const ec = C.mutate((d) => (d.slides[0].elements[0].html = 'Hello ABC <b>world</b>'))
      const ed = D.mutate((d) => (d.slides[0].elements[0].html = 'Hello XYZ <b>world</b>'))
      C.receive(ed)
      D.receive(ec)
      snap(t, 'C', C)
      snap(t, 'D', D)
      return t
    },
  },
  {
    name: 'snapshot merge (offline fork, late joiner)',
    run: (E) => {
      const t: Transcript = []
      const A = new Replica(E, 'A')
      const B = new Replica(E, 'B')
      A.mutate((d) => (d.title = 'A says'))
      A.mutate((d) => d.slides[0].elements.push({ id: 'A-x', type: 'shape', shape: 'rect', x: 5, y: 5, w: 10, h: 10, rotation: 0, opacity: 1, fill: '#333', stroke: 'none', strokeWidth: 0, radius: 0 }))
      B.mutate((d) => (d.slides[2].background = '#654321'))
      B.mutate((d) => d.slides.splice(1, 1))
      const aDoc = JSON.parse(JSON.stringify(A.doc))
      const aState = JSON.parse(JSON.stringify(A.state.toJSON()))
      const bDoc = JSON.parse(JSON.stringify(B.doc))
      const bState = JSON.parse(JSON.stringify(B.state.toJSON()))
      t.push(['A-merge', J(A.state.mergeSnapshot(A.doc, bDoc, bState))])
      A.shadow = JSON.stringify(A.doc)
      t.push(['B-merge', J(B.state.mergeSnapshot(B.doc, aDoc, aState))])
      B.shadow = JSON.stringify(B.doc)
      snap(t, 'A', A)
      snap(t, 'B', B)
      const C = new Replica(E, 'C')
      t.push(['C-join', J(C.state.mergeSnapshot(C.doc, JSON.parse(JSON.stringify(A.doc)), A.state.toJSON()))])
      snap(t, 'C', C)
      return t
    },
  },
  {
    name: 'op-log catch-up (missingFor)',
    run: (E) => {
      const t: Transcript = []
      const A = new Replica(E, 'A')
      const B = new Replica(E, 'B')
      const batches = [
        A.mutate((d) => (d.title = 'x1')),
        A.mutate((d) => (d.slides[0].background = '#222222')),
        A.mutate((d) => d.slides[0].elements.push({ id: 'A-q', type: 'shape', shape: 'rect', x: 9, y: 9, w: 10, h: 10, rotation: 0, opacity: 1, fill: '#444', stroke: 'none', strokeWidth: 0, radius: 0 })),
      ]
      B.receive(batches[0])
      const missing = B.state.missingFor(A.log, B.state.toJSON().vv)
      t.push(['missing', J(missing)])
      B.receive(missing)
      snap(t, 'B', B)
      return t
    },
  },
  {
    name: 'state serialization round-trip + pre-v2 reject',
    run: (E) => {
      const t: Transcript = []
      const A = new Replica(E, 'A')
      A.mutate((d) => (d.title = 'persisted'))
      A.mutate((d) => d.slides[0].elements.push({ id: 'p-1', type: 'shape', shape: 'rect', x: 4, y: 4, w: 10, h: 10, rotation: 0, opacity: 1, fill: '#555', stroke: 'none', strokeWidth: 0, radius: 0 }))
      const saved = A.stateBytes()
      t.push(['saved', saved])
      const restored = E.fromJSON('A', JSON.parse(saved))
      t.push(['restored', JSON.stringify(restored.toJSON())])
      // an offline fork rejoining: restored state must defend its edits
      const forked = new Replica(E, 'F')
      forked.doc = JSON.parse(JSON.stringify(A.doc))
      forked.state = E.fromJSON('F', JSON.parse(saved))
      forked.shadow = JSON.stringify(forked.doc)
      t.push(['fork/ops', J(forked.mutate((d) => (d.title = 'forked offline')))])
      snap(t, 'fork', forked)
      // pre-v2 blobs are discarded on sight
      const legacy = { lamport: 9, vv: { Z: 4 }, regs: { 'cast x': [9, 'Z'] }, pos: {}, births: {}, tombs: {}, txt: {}, stash: {}, limbo: {} }
      t.push(['legacy-fromJSON', JSON.stringify(E.fromJSON('A', legacy as StateJSON).toJSON())])
      const L = new Replica(E, 'L')
      t.push(['legacy-merge', J(L.state.mergeSnapshot(L.doc, baseDoc(), legacy as StateJSON))])
      snap(t, 'legacy', L)
      return t
    },
  },
  {
    name: 'duplicate element id across slides (morph idiom)',
    run: (E) => {
      const t: Transcript = []
      const A = new Replica(E, 'A')
      const B = new Replica(E, 'B')
      const castOn = (d: Doc, sid: string) =>
        d.slides.find((s: any) => s.id === sid).elements.find((e: any) => e.id === 'cast')
      const ea = A.mutate((d) => (castOn(d, 's1').html = 'ONE ' + castOn(d, 's1').html))
      const eb = B.mutate((d) => (castOn(d, 's2').html = castOn(d, 's2').html + ' TWO'))
      t.push(['ea', J(ea)])
      t.push(['eb', J(eb)])
      A.receive(eb)
      B.receive(ea)
      snap(t, 'A', A)
      snap(t, 'B', B)
      // colliding moves onto one slide
      const C = new Replica(E, 'C')
      const D = new Replica(E, 'D')
      const mv = (d: Doc, from: string) => {
        const f = d.slides.find((s: any) => s.id === from)
        const s3 = d.slides.find((s: any) => s.id === 's3')
        const i = f.elements.findIndex((e: any) => e.id === 'cast')
        const [el] = f.elements.splice(i, 1)
        s3.elements.push(el)
      }
      const mc = C.mutate((d) => mv(d, 's1'))
      const md = D.mutate((d) => mv(d, 's2'))
      C.receive(md)
      D.receive(mc)
      snap(t, 'C', C)
      snap(t, 'D', D)
      return t
    },
  },
  {
    name: 'large text (300KB) tokenizes and merges',
    run: (E) => {
      const t: Transcript = []
      const A = new Replica(E, 'A')
      const B = new Replica(E, 'B')
      const big = 'word '.repeat(60_000)
      const ea = A.mutate((d) => { d.slides[0].elements[0].html = big + ' AAA' })
      const eb = B.mutate((d) => { d.slides[0].elements[0].html = d.slides[0].elements[0].html + ' BBB' })
      A.receive(eb)
      B.receive(ea)
      // full bytes would be ~10MB of transcript; the merged text and the RGA
      // token stream are captured by hash + shape, which is still byte-exact
      // detection (any change to either changes the hash)
      t.push(['ea-shape', J(ea.map((o: any) => [o.op, o.l, o.s, (o.ins ?? []).length, (o.del ?? []).length, o.base?.length ?? 0]))])
      t.push(['eb-shape', J(eb.map((o: any) => [o.op, o.l, o.s, (o.ins ?? []).length, (o.del ?? []).length, o.base?.length ?? 0]))])
      t.push(['A-doc-hash', hash(A.docBytes())])
      t.push(['A-state-hash', hash(A.stateBytes())])
      t.push(['B-doc-hash', hash(B.docBytes())])
      t.push(['B-state-hash', hash(B.stateBytes())])
      t.push(['merged-html', A.doc.slides[0].elements[0].html.slice(-40) + '|' + A.doc.slides[0].elements[0].html.length])
      return t
    },
  },
]

/** FNV-1a — only for the one scenario whose byte transcript is megabytes */
function hash(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0') + ':' + s.length
}

function runScenarios(A: Engine, B: Engine): boolean {
  let allOk = true
  const repro = 'RANDOM=0 node scripts/test-sync-equiv.ts   (scenarios are fixed scripts — no seed involved)'
  for (const sc of SCENARIOS) {
    const ta = sc.run(A)
    const tb = sc.run(B)
    if (ta.length !== tb.length) {
      cmp(`scenario "${sc.name}" transcript length`, 0, sc.name, '-', J(ta.map((x) => x[0])), J(tb.map((x) => x[0])), undefined, repro)
      allOk = false
      continue
    }
    for (let i = 0; i < ta.length; i++) {
      if (ta[i][0] !== tb[i][0] || ta[i][1] !== tb[i][1]) {
        cmp(`scenario "${sc.name}" → ${ta[i][0]}`, 0, sc.name, '-', ta[i][1], tb[i][1], undefined, repro)
        allOk = false
        break
      }
    }
    if (!allOk) break
  }
  return allOk
}

// ---------------------------------------------------------------------------
// SELF-TEST: engines that CONVERGE but do not MATCH
//
// Each mutant is a legal, self-consistent, fully convergent CRDT — every one
// of them passes scripts/test-sync.ts — that mints different bytes than the
// shipped engine. They are the exact failure mode parameterization risks, and
// they are the only evidence a NO-OP run can offer that this rig works.
// ---------------------------------------------------------------------------

type MutantName = 'pos-spread' | 'lamport-skew' | 'op-field-order' | 'state-key-order'

const MUTANT_WHY: Record<MutantName, string> = {
  'pos-spread': 'adopt() derives different (but still order-preserving) fractional keys',
  'lamport-skew': 'one extra lamport tick per diff — same order, different stamps',
  'op-field-order': 'ops carry identical fields in a different serialization order',
  'state-key-order': 'SyncStateJSON.regs serialized in a different key order',
}

function mutantEngine(M: CrdtModule, name: MutantName): Engine {
  const Base = M.SyncState as any
  let Cls: any
  switch (name) {
    case 'pos-spread':
      Cls = class extends Base {
        adopt(doc: Doc) {
          super.adopt(doc)
          for (const k of Object.keys(this.pos)) {
            const p = this.pos[k]
            // only the null-register keys adoption itself minted; 'M' prefix
            // is order-preserving, so materialized order is unchanged
            if (p.r[0] === 0 && p.r[1] === '' && !p.o.startsWith('M')) p.o = 'M' + p.o
          }
        }
      }
      break
    case 'lamport-skew':
      Cls = class extends Base {
        diff(before: Doc, after: Doc, opts: { text?: boolean } = {}) {
          this.lamport++
          return super.diff(before, after, opts)
        }
      }
      break
    case 'op-field-order':
      Cls = class extends Base {
        diff(before: Doc, after: Doc, opts: { text?: boolean } = {}) {
          return super.diff(before, after, opts).map((op: Op) => {
            const out: any = {}
            for (const k of Object.keys(op).reverse()) out[k] = op[k]
            return out
          })
        }
      }
      break
    case 'state-key-order':
      Cls = class extends Base {
        toJSON() {
          const j = super.toJSON()
          return { ...j, regs: Object.fromEntries(Object.entries(j.regs).reverse()) }
        }
      }
      break
  }
  return {
    label: `mutant:${name}`,
    SyncState: Cls,
    // crdt.ts's `static fromJSON` constructs `new SyncState(actor)` literally —
    // not `new this(actor)` — so a subclass cannot be produced through it, and
    // this returned an UNMUTATED engine. Every scenario that round-trips state
    // therefore tested the baseline against itself while reporting mutant
    // coverage, which is the one lie a self-test must not tell.
    //
    // Re-pointing the prototype is a test-harness liberty, taken here rather
    // than changing one word in the shipped engine: this step's whole
    // acceptance criterion is that `git diff slides/ kernel/ server/` is empty.
    fromJSON: (a, j) => {
      const base = M.SyncState.fromJSON(a, j)
      Object.setPrototypeOf(base, Cls.prototype)
      return base as unknown as EngineState
    },
  }
}

/** does this engine converge with ITSELF? (what test-sync.ts asks) */
function convergesWithItself(E: Engine, seeds: number, steps: number, actors: number): boolean {
  for (let seed = 1; seed <= seeds; seed++) {
    const rnd = mulberry32(seed * 7919)
    const w = new World(E, actors)
    for (let s = 0; s < steps; s++) {
      const dice = rnd()
      if (dice < 0.45) {
        const actor = Math.floor(rnd() * actors)
        exec(w, { t: 'mut', actor, undo: rnd() < 0.06, mseed: (seed * 1_000_003 + s * 7919 + 17) >>> 0 })
      } else {
        const edges = [...w.queues.entries()].filter(([, q]) => q.length)
        if (edges.length) exec(w, { t: 'deliver', edge: edges[Math.floor(rnd() * edges.length)][0] })
      }
    }
    let moved = true
    while (moved) {
      moved = false
      for (const [key, q] of w.queues) {
        if (!q.length) continue
        moved = true
        exec(w, { t: 'deliver', edge: key })
      }
    }
    const doc0 = w.reps[0].docCanon()
    const st0 = w.reps[0].stateCanon()
    for (let i = 1; i < actors; i++) {
      if (w.reps[i].docCanon() !== doc0 || w.reps[i].stateCanon() !== st0) return false
    }
  }
  return true
}

/**
 * Which comparator fires first on this mutant? The caller stubs console.error
 * (a mutant's diffs are expected noise), and the global divergence bookkeeping
 * is saved and restored so a self-test never colours the real verdict.
 */
function whatCatches(A: Engine, B: Engine, seeds: number, steps: number, actors: number): string[] {
  const caught = new Set<string>()
  const saveFirst = firstDiv
  const saveCount = divCount
  for (let seed = 1; seed <= seeds; seed++) {
    firstDiv = null
    if (!equivSeed(A, B, seed, steps, actors)) {
      if (firstDiv) caught.add((firstDiv as Div).what.replace(/ \(.*\)$/, ''))
    }
  }
  if (!runScenarios(A, B)) caught.add('scenario')
  firstDiv = saveFirst
  divCount = saveCount
  return [...caught]
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const t0 = process.hrtime.bigint()
const ms = (from: bigint) => Number(process.hrtime.bigint() - from) / 1e6

console.log('bento-sync equivalence rig — baseline vs candidate, byte for byte')
if (IS_NOOP) {
  console.log('')
  console.log('  ############################################################')
  console.log('  #  NO-OP RUN. The candidate import resolves to the SAME    #')
  console.log('  #  module as the baseline (they are === at runtime), so    #')
  console.log('  #  the comparison below is vacuous BY CONSTRUCTION. Green  #')
  console.log('  #  here says nothing about any parameterized engine — it   #')
  console.log('  #  only says the comparator runs. The SELF-TEST at the end #')
  console.log('  #  is the part with signal. Repoint the CANDIDATE_MODULE   #')
  console.log('  #  import (one line, marked in the header) to go LIVE.     #')
  console.log('  ############################################################')
  console.log('')
} else {
  console.log('')
  console.log(`  LIVE RUN — candidate is a distinct module (${CANDIDATE.label}).`)
  console.log('')
}

const MUTANT = process.env.MUTANT as MutantName | undefined
const candidate = MUTANT ? mutantEngine(CANDIDATE_MODULE, MUTANT) : CANDIDATE
if (MUTANT) console.log(`  MUTANT=${MUTANT} — candidate deliberately perturbed: ${MUTANT_WHY[MUTANT]}\n`)

let failed = false

// --- scenarios -------------------------------------------------------------
if (process.env.SCENARIOS !== '0') {
  const t = process.hrtime.bigint()
  const okScen = runScenarios(BASELINE, candidate)
  console.log(`scripted scenarios: ${SCENARIOS.length} scripts, ${okScen ? 'identical' : 'DIVERGED'} (${ms(t).toFixed(0)}ms)`)
  if (!okScen) failed = true
}

// --- random runs -----------------------------------------------------------
if (process.env.RANDOM !== '0') {
  const t = process.hrtime.bigint()
  const from = SEED_ONLY || 1
  const to = SEED_ONLY || SEEDS
  let run = 0
  let bad = false
  for (let seed = from; seed <= to; seed++) {
    run++
    if (!equivSeed(BASELINE, candidate, seed, STEPS, ACTORS)) {
      bad = true
      failed = true
      break
    }
  }
  console.log(
    `random runs: ${run} of ${to - from + 1} seed(s) × ${STEPS} steps × ${ACTORS} actors — ` +
      `${bad ? 'DIVERGED' : 'identical'} (${ms(t).toFixed(0)}ms)`,
  )
}

// --- self-test -------------------------------------------------------------
if (process.env.SELFTEST !== '0' && !MUTANT) {
  console.log('')
  console.log('self-test — engines that CONVERGE but do not MATCH:')
  const suppress = console.error
  const names: MutantName[] = ['pos-spread', 'lamport-skew', 'op-field-order', 'state-key-order']
  for (const name of names) {
    const mut = mutantEngine(BASELINE_MODULE, name)
    const converges = convergesWithItself(mut, 4, 60, 3)
    console.error = () => {} // the mutants' diffs are expected noise
    const caught = whatCatches(BASELINE, mut, 4, 60, 3)
    console.error = suppress
    const good = converges && caught.length > 0
    if (!good) failed = true
    console.log(
      `  ${good ? '✓' : '✗'} ${name.padEnd(16)} converges: ${converges ? 'yes' : 'NO'}  ` +
        `→ test-sync.ts would ${converges ? 'PASS' : 'fail'} it; ` +
        `this rig catches it via [${caught.join(', ') || 'NOTHING — RIG IS BLIND'}]`,
    )
    console.log(`      (${MUTANT_WHY[name]})`)
  }
}

console.log('')
if (failed) {
  console.log(`FAILED — ${divCount} divergence(s); the first is printed above.`)
} else if (IS_NOOP) {
  console.log(`PASS (trivially — candidate === baseline). total ${ms(t0).toFixed(0)}ms`)
} else {
  console.log(`PASS — candidate is byte-identical to baseline. total ${ms(t0).toFixed(0)}ms`)
}
process.exit(failed ? 1 : 0)
