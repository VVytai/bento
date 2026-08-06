#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/dash recovery + drop-open rig — the decisions, not the banner.
//
//   node scripts/test-dash-recovery.ts     (Node ≥ 23.6 strips types natively)
//
// WHAT THIS PROVES. Both features are a single yes/no taken at boot or on a
// gesture, and both of them do damage in the SAME direction when the answer is
// wrong: they put a document on screen that is not the one in the file.
//
//   1. THE CONTENT KEY. It decides whether there is unsaved work at all. Too
//      LOOSE (comparing whole JSON, timestamps included) and a banner claiming
//      lost work appears on every open — which trains the reader to dismiss the
//      one that matters. Too TIGHT (a whitelist of known fields) and an edit to
//      a field this build does not know about reads as "nothing changed", which
//      is a silent loss of somebody else's data in an additive format.
//   2. THE REFUSALS. Three of them are safety, not tidiness: an encrypted
//      workbook is never snapshotted, so any snapshot under its docId is
//      pre-encryption PLAINTEXT; a read-only or frozen workbook must not be
//      written; a snapshot this build cannot parse must not be behind a live
//      Restore button.
//   3. THE ROUTING. A dropped file goes to exactly one of three importers, and
//      anything else is refused BY NAME. The dangerous case is the near miss —
//      `.xls` is not `.xlsx` (OLE, not ZIP), so accepting it fails deep inside
//      the reader instead of in a sentence the reader can act on.
//
// The DOM halves — the banner's buttons, the capture-phase drag handlers, the
// FileSystemHandle adoption — need a real browser and a real drag, and are
// called out as unverified in the report rather than faked here.

import { registerHooks } from 'node:module'

// recovery.ts imports its own stylesheet (and dropopen.ts reaches it through
// recovery.ts). Vite's job; Node refuses the extension outright. Same stub
// test-dash-about.ts uses.
registerHooks({
  load(url, context, next) {
    if (url.endsWith('.css')) return { format: 'module', source: 'export {}', shortCircuit: true }
    return next(url, context)
  },
})

const { contentKey, decide, VOLATILE_KEYS } = await import('../dash/src/recovery.ts')
const { classifyDrop, refusalFor } = await import('../dash/src/dropopen.ts')
const { FORMAT, FORMAT_VERSION, parseDoc } = await import('../dash/src/model.ts')
type DashDoc = import('../dash/src/model.ts').DashDoc
type Snapshot = import('../kernel/src/autosave.ts').Snapshot

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

// A minimal but REAL workbook: parseDoc has to accept it, because `decide`
// parses the snapshot rather than trusting it.
function workbook(extra: Partial<DashDoc> = {}): DashDoc {
  return {
    format: FORMAT,
    version: FORMAT_VERSION,
    docId: 'doc-1',
    title: 'Q3',
    sheets: [{
      id: 'sheet-1',
      kind: 'table',
      name: 'Data',
      columns: [{ id: 'region', name: 'Region', type: 'text' },
        { id: 'value', name: 'Value', type: 'number' }],
      rids: [[1, 2]],
      data: {
        region: { enc: 'raw', v: ['North', 'South'] },
        value: { enc: 'raw', v: [10, 20] },
      },
    }],
    ...extra,
  } as DashDoc
}

const snapOf = (doc: DashDoc, at = 1_700_000_000_000): Snapshot =>
  ({ docId: doc.docId, at, title: doc.title, json: JSON.stringify(doc) })

/**
 * The workbook AS THE APP HOLDS IT.
 *
 * Every live document in dash is `parseDoc` output — the boot dispatcher,
 * About's replace-from-JSON, `window.bento.loadDoc`, and drop-open all go
 * through it — and parseDoc NORMALIZES (it fills a missing `steps: []` on every
 * sheet, among other things). Comparing a hand-built object would therefore be
 * testing a state the app never reaches, and would report a difference that
 * exists only in the rig.
 */
function loaded(extra: Partial<DashDoc> = {}): DashDoc {
  const r = parseDoc(JSON.stringify(workbook(extra)))
  if (!r.ok) throw new Error('the rig fixture is not a valid workbook')
  return r.doc
}

// ------------------------------------------------------------- content key
{
  const a = workbook()
  const b = workbook()
  ok(contentKey(a) === contentKey(b), 'two identical workbooks have the same content key')

  ok(contentKey(workbook({ modified: '2026-01-01T00:00:00Z' })) === contentKey(a),
    '`modified` does not count — a save stamps it and nothing else changed')
  ok(contentKey(workbook({ collab: { room: 'w-abc', sync: { v: 2 } } })) === contentKey(a),
    '`collab` does not count — sync state is stamped into the file on save')
  ok(VOLATILE_KEYS.length === 2,
    'exactly two fields are volatile; adding a third is a decision, not an oversight')

  ok(contentKey(workbook({ title: 'Q4' })) !== contentKey(a), 'a retitle counts')

  const edited = workbook()
  ;(edited.sheets[0] as { data: Record<string, { enc: 'raw'; v: unknown[] }> }).data.value.v[1] = 21
  ok(contentKey(edited) !== contentKey(a), 'a single changed CELL counts — the whole point')

  // additivity: the format keeps fields this build cannot name (PLATFORM §3)
  ok(contentKey(workbook({ somethingNewerBuildsWrite: { n: 1 } } as Partial<DashDoc>)) !== contentKey(a),
    'an UNKNOWN top-level field counts — a whitelist would call somebody else’s data "no change"')

  // key order is an artefact of how each object was built, not content
  const reordered = JSON.parse(JSON.stringify(
    { sheets: a.sheets, title: a.title, docId: a.docId, version: a.version, format: a.format },
  )) as DashDoc
  ok(contentKey(reordered) === contentKey(a),
    'key ORDER does not count — otherwise a reparse shows a banner for nothing')

  const undef = workbook({ theme: undefined })
  ok(contentKey(undef) === contentKey(a),
    'an explicitly-undefined field equals an absent one — a JSON round trip erases it anyway')

  // …but the CONTENTS of an array keep their order: row 3 is row 3
  const swapped = workbook()
  ;(swapped.sheets[0] as { data: Record<string, { enc: 'raw'; v: unknown[] }> }).data.region.v = ['South', 'North']
  ok(contentKey(swapped) !== contentKey(a), 'ROW order counts — arrays are data, not a key set')
}

// ---------------------------------------------------------------- decide
{
  const doc = loaded()
  const edited = loaded({ title: 'Q3 (revised)' })
  const base = { doc, encrypted: false, readOnly: false }

  const yes = decide({ ...base, snapshot: snapOf(edited) })
  ok(yes.offer && yes.doc.title === 'Q3 (revised)' && yes.at === 1_700_000_000_000,
    'a snapshot that differs is offered, with its timestamp and its document')

  const same = decide({ ...base, snapshot: snapOf(doc) })
  ok(!same.offer && same.why === 'same',
    'a snapshot matching the file is NOT offered — the file already has these edits')

  const none = decide({ ...base, snapshot: null })
  ok(!none.offer && none.why === 'none', 'no snapshot, no banner')

  const enc = decide({ ...base, snapshot: snapOf(edited), encrypted: true })
  ok(!enc.offer && enc.why === 'encrypted',
    'an ENCRYPTED workbook is never offered a snapshot — it would be pre-encryption plaintext')

  const ro = decide({ ...base, snapshot: snapOf(edited), readOnly: true })
  ok(!ro.offer && ro.why === 'read-only',
    'a read-only or frozen workbook is not offered a restore it cannot perform')

  const junk = decide({ ...base, snapshot: { ...snapOf(edited), json: '{not json' } })
  ok(!junk.offer && junk.why === 'unreadable', 'an unparseable snapshot is not put behind a live button')

  const foreign = decide({ ...base, snapshot: { ...snapOf(edited), json: JSON.stringify({ format: 'bento/slides', slides: [] }) } })
  ok(!foreign.offer && foreign.why === 'unreadable', 'a snapshot that is not a bento/dash workbook is refused')

  const other = decide({ ...base, snapshot: { ...snapOf(edited), docId: 'doc-2' } })
  ok(!other.offer && other.why === 'other-doc',
    'a snapshot filed under another docId is refused even though the store keys by docId')

  // ORDER OF THE GUARDS: encryption is checked before anything is even looked
  // at, so a corrupt snapshot cannot change the answer for a locked workbook.
  const encFirst = decide({ ...base, snapshot: { ...snapOf(edited), json: '{' }, encrypted: true })
  ok(!encFirst.offer && encFirst.why === 'encrypted', 'the encryption refusal comes first')

  // The ordinary case, and the one the user meets on every single open: the
  // file was saved (so it carries `modified`) a moment after the snapshot was
  // written (which did not). Nothing was lost; say nothing.
  const stamped = loaded({ modified: '2026-08-06T09:00:00Z' })
  const quiet = decide({ doc: stamped, encrypted: false, readOnly: false, snapshot: snapOf(loaded()) })
  ok(!quiet.offer && quiet.why === 'same',
    'a saved file and its pre-save snapshot are the same workbook, not unsaved work')

  // A snapshot written by an OLDER build, before some field became part of what
  // parse fills in (`steps: []` is one such field today). Both sides are parsed
  // before they are compared, which is what makes this quiet; comparing the
  // snapshot's raw JSON to the parsed document would show a banner on every
  // open after any such change to parseDoc.
  const older = decide({ ...base, snapshot: snapOf(workbook()) })
  ok(!older.offer && older.why === 'same',
    'a snapshot predating a parse-time normalization is still recognised as the same workbook')
}

// ------------------------------------------------------------- drop routing
{
  ok(classifyDrop('Q3-board.bento.html') === 'workbook', 'a .bento.html is a workbook')
  ok(classifyDrop('export.html') === 'workbook', 'a plain .html is tried as a workbook')
  ok(classifyDrop('SALES.CSV') === 'delimited', 'case does not matter')
  ok(classifyDrop('sales.tsv') === 'delimited', 'a .tsv is delimited')
  ok(classifyDrop('book.xlsx') === 'xlsx', 'an .xlsx is Excel')
  ok(classifyDrop('macro.xlsm') === 'xlsx', 'an .xlsm is the same ZIP container')

  ok(classifyDrop('legacy.xls') === null,
    'a .xls is REFUSED — it is an OLE compound file and the reader takes a ZIP')
  ok(classifyDrop('photo.png') === null, 'an image is refused')
  ok(classifyDrop('notes.txt') === null,
    'a .txt is refused — its delimiter is a guess, and guessing is what import.ts exists not to do')
  ok(classifyDrop('') === null, 'a nameless drop is refused rather than routed')
  ok(classifyDrop('data.csv.bak') === null, 'the LAST extension decides')

  ok(refusalFor('photo.png').includes('photo.png'),
    'the refusal names the file that was dropped — "unsupported" alone is unactionable')
  ok(/\.bento\.html/.test(refusalFor('photo.png')) && /csv/i.test(refusalFor('photo.png')),
    'and it names what WOULD work')
  ok(/xlsx/i.test(refusalFor('legacy.xls')) && refusalFor('legacy.xls') !== refusalFor('photo.png'),
    'a .xls gets its own line: the fix is one Save As, not "this is not supported"')
  ok(refusalFor('sheet.numbers') !== refusalFor('photo.png'), 'so does a Numbers file')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
