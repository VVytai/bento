# bento/dash collaboration — design, and what it loses

*Design document, August 2026. Status: **engine and rig implemented**
(`dash/src/sync/crdt.ts`, `scripts/test-dash-sync.ts`); session, transport and
People panel implemented but **not yet mounted by the app** (see "What this
needs from the rest of dash"). Companion to `docs/collab-design.md`, which is
the authoritative spec for the wire protocol, the relay and the key chain —
dash speaks that protocol unchanged. This document covers only what is
different, which is everything below the wire.*

---

## 1. Why slides' engine does not transfer

`slides/src/sync/crdt.ts` is a good CRDT for a deck: a slide has tens of
elements, each element is a small flat object with a globally-ish unique id,
and the whole document fits comfortably in memory twice over. Two of its load-
bearing assumptions are false for a workbook.

**It diffs whole-document snapshots.** Every commit re-serializes the document
and compares it to a shadow copy. `store.ts` already measured what that costs
here — 10 ms per snapshot on a 12.2 MB workbook, most of a frame, paid in the
frame the user starts typing, and 1.19 GB of live strings for a full undo
stack. That is why dash's history is typed inverses rather than snapshots, and
it is why sync cannot be a differ either.

**It keys state per node, and a workbook has a million of them.** Slides
assigns every element a fractional order key and a birth stamp at adopt time.
A 1M-row sheet doing the same would carry ~1M order keys and ~1M stamps — in
memory, and in the FILE, since `collab.sync` is stamped into the saved
document. The entire columnar-plus-dictionary encoding exists to get a cell
down to 4.8 bytes; a sync layer costing 40 bytes a row would undo it.

So dash's engine is built on two rules that slides does not need:

> **Ops are minted from patches, never from a diff.**
> **State is O(edits), never O(rows).** A row nobody has touched costs zero
> bytes. A cell nobody has written costs zero bytes.

The first rule was free, because `store.ts` already predicted it: *"The same
Patch objects are the undo entries, the future CRDT ops and the agent API."*
A `Patch` is a complete, position-independent description of one mutation, and
`setCells` is already keyed by **rid**, not by row position. That is the single
luckiest fact in this design.

---

## 2. Node identity

| node | id | why |
|---|---|---|
| the document | `@doc` | title, meta, theme, measures, names, views |
| a sheet | `s␟<sheetId>` | |
| a column | `c␟<sheetId>␟<colId>` | column ids are **sheet-scoped** (`model.ts` is explicit: two sheets may both call a column `c1`), so a bare id is not identity |
| a row | `r␟<sheetId>␟<rid>` | rids are minted at insert and **never reused** (`rowcol.ts` is emphatic), which is exactly what makes them usable as identity |

`␟` is U+001F. It cannot occur in a sheet or column id: import mints column ids
by slugging headers, and `parseDoc` repairs anything it cannot claim.

This is slides' composite-key lesson applied before it could bite. Slides
shipped v1 keyed by bare element id, discovered that the same id on many slides
is the *core morph idiom*, and had to version the wire format to fix it. dash
composites from commit one.

**A cell is not a node.** A cell is a PROPERTY of its row, keyed by column id:
the register `r␟s1␟7 ⟹ v␟price` is the cell at row 7, column `price`. That
gives per-cell last-writer-wins out of exactly the same (lamport, actor)
register machinery slides uses for `x` and `fill`, with no new algebra and no
per-cell state until somebody writes a cell. Cell *overrides* (the `cells`
overlay) are a second key space on the same node, `o␟price`.

---

## 3. Patches → ops

| store patch | op | granularity |
|---|---|---|
| `setCells` | `cell` (many rids, one column) | **per cell**, LWW by (lamport, actor) |
| `setOverrides` | `ovr` | **per cell**, whole-override-object LWW |
| `insertRows` | `rins` (rids + fractional keys + values) | per row |
| `deleteRows` | `rdel` | per row, tombstone |
| `addColumn` | `ins` (metadata) **+** `cell` (its values) | per column |
| `removeColumn` | `del` | tombstone |
| `reorderColumns` | `ord` per moved column | fractional key |
| `setColumn` | `set` per key | **per property** |
| `setSheetProps` | `set` per key (a `drop` becomes `v` absent) | **per property** |
| `setMeasure` | `set` on `measures.<name>` | **per measure** |
| `setTitle` | `set` on `title` | whole value |
| `applySteps`, `refreshBinding` | — | not expressible; the session ships a state snapshot instead of dropping the edit |

Two details in that table are load-bearing.

`setCells` carries `dictLen`, which truncates a dictionary the edit grew. It is
**stripped** when minting: it is a local undo artefact, and applying it to a
peer would truncate a dictionary of a different length. Values are the wire
format; dictionary indices never travel.

A **column insert carries no values**. Its values follow as an ordinary `cell`
op in the same commit. While a column payload assigned cells, every cell had
two possible owners — the column's payload and the row's — and the rig kept
finding deliveries where two replicas disagreed about a number. One writer per
cell, decided by one register, is worth its cost. That cost is real and stated
in §6.

---

## 4. Row order: a fractional index over rids

Row order is data ("in a spreadsheet, order is data" — `store.ts`), so it needs
a real sequence CRDT, and the cheap ones do not fit. Three designs were tried;
the rig killed two.

1. **`rids` as a whole-value LWW register.** Simple, converges, and silently
   drops one side's rows whenever two people edit structure at once. Rejected:
   this is precisely the class of loss the app exists to refuse.
2. **An RGA whose inserts name an ANCHOR RID**, with deleted anchors resolved
   by walking back to the anchor's own anchor. Position-preserving and cheap —
   and wrong: the walk lands a row ahead of rows that used to sit between the
   anchor and its predecessor, so two replicas that applied the deletes in
   different orders disagreed. Found on seed 16 of a 20-seed run.
3. **A fractional index** (shipped). Every row has an order key; order is
   `sort by (key, rid)`, a pure function of converged state. A neighbour may
   die without moving anything, because the key already sits between the
   survivors — no tombstones, no chains.

The trick that makes it affordable: **most rows never get a key.** A row that
came with the file takes its key from its position in the adopted baseline
sequence (`base`, one run-length list per sheet — 20 bytes for 4200 rows).
Only an INSERTED row stores an explicit key. Cost: O(inserts) + O(sheets).

Minted keys are suffixed with the author's actor id. Two replicas inserting
between the same neighbours compute the same midstring, and with equal keys the
sequence each replica materialises depends on which rows it happened to hold —
it stops being sorted, and every later binary search lands somewhere else (seed
42). The suffix makes every key unique, so the sequence is sorted by
construction everywhere.

---

## 5. Concurrent structural edits

**Two people insert rows at the same place.** Both rows survive, ordered by
(key, rid). Deterministic, and the same on every replica.

**Insert vs delete of the neighbour.** The insert keeps its place; the deleted
row leaves. The fractional key does not care that its neighbour died.

**Delete vs edit of the same row.** Delete wins (standard, predictable, and the
same rule slides ships). The edit's register still advances, so states converge.

**Undo of a row delete** is a fresh insert carrying the row's values, which
resurrects the row by out-stamping its tombstone. Values written by others
during the row's dead window are parked and replay if they out-stamp the
resurrection.

**Two people add columns.** Both survive; order by fractional key.

**Column delete vs edits inside it.** Delete wins. See §6.

**Sheet delete vs anything inside it.** Delete wins, coarsely. See §6.

---

## 6. What loses data

This is the section to read twice. Everything here is a **documented
limitation**, not a bug: each one is deterministic (every replica loses the
same thing) and each one is a deliberate trade against a cost named beside it.

### 6.1 A cell override is a whole-object register

`{note, bg, bold, align, color, why, by}` is ONE register. Two people
annotating the same cell — one sets a note, the other a colour — and one of
the two edits is lost silently. Cell VALUES do not have this problem; only the
override overlay does. Fixable later by making the override per-key like
`measures.<name>`, at the cost of more registers per annotated cell.

### 6.2 Deleting a column loses concurrent edits to it

A column's death is final for its values. Writes to it during the delete's
flight are dropped (their registers still advance, so replicas agree); undoing
the delete restores the values **the undoer had**, and nobody else's.

Re-adding the column is a whole-column assignment, so it also out-stamps every
write older than itself, wherever that write is being held — in the document, in
a parked stash entry, or in an op still waiting on the buried column. All three
readers apply the same rule (`resetColumnValues`, `reconcileParked` and
`replayStashRow`); the last of those did not, and that was the seed-307 bug.

This is the one place dash refuses to be clever, deliberately. Cell values live
in the document, not in the sync layer, so a resurrected column could only come
back full if each replica restored what IT happened to hold — and no two
replicas hold the same thing, so they came back different. Every attempt to
reconcile those private copies grew another ordering rule and another rig
failure. Delete-wins is convergent and explicable; "everyone keeps their own
version" is neither.

### 6.3 Deleting a sheet beats everything inside it

Ops for a dead sheet's rows and columns are book-kept (registers, births and
tombstones advance so the states converge) and otherwise discarded. Undoing a
sheet delete restores the sheet **as the deleter saw it**; concurrent edits
made elsewhere in that window are gone.

The alternative is a cascade tombstone per row, which is O(rows) in the op, in
memory and in the file — the exact cost this design exists to avoid.

### 6.4 Undo under collaboration

Two prices, both inherited and both real.

*It can revert a collaborator's edit.* Undo replays the inverse patch built
when you made the change, and that inverse restores the value it displaced —
which may since have been overwritten by someone else. Same compromise slides
documents.

*It no longer shrinks a dictionary back.* `setCells`'s inverse carries
`dictLen`, and `applyPatch` honours it by truncating the column's dictionary to
the length the edit found. That is exact for one writer and unsound for two: a
peer's write interns ITS strings into the same dictionary above that watermark,
so the truncation strands them and every cell pointing at one reads back null —
on the undoing replica alone, with no register moving, which is a divergence
rather than a lost undo. `local()` therefore deletes `dictLen` from the patch
before the store sees it. The cost is the orphaned strings, which store.ts
already calls "semantically right and no longer byte-identical"; a live session
had given up byte-identical dictionaries anyway, since two replicas intern in
the order their ops arrive. This was the seed-124 bug.

*It can be refused outright.* An inverse names rows and columns that may no
longer exist, and `committable()` (crdt.ts) refuses patches that name what is
not there. Without that refusal the local store applies the patch anyway — it
has no idea what a peer deleted — while every peer's engine gates it, so the
edit lands on exactly one replica. A refused inverse costs one undo step; the
alternative costs the numbers.

### 6.5 Row ORDER after an offline fork merge

Two copies edited offline and merged by snapshot exchange (rather than by op
log) reconcile their row order by a symmetric interleave — an element only one
side has goes first, and a genuine conflict breaks on (birth stamp, rid). Both
sides land on the same order; it is not necessarily the order either side
intended. Op-based sessions are unaffected: they order by key.

Two copies adopted at *different points* in a file's history disagree about
which rows were baseline. Their baselines are merged (symmetrically) so both
derive the same keys, but a third replica that never merged may order those
rows differently until it exchanges a snapshot too.

### 6.6 Bulk column adds cost one register per cell

Because a column insert carries no values (§3), adding a fully-populated column
mints one cell register per value — a 100k-row column costs ~100k register
entries in the sync state, and in `collab.sync` if the file is saved during the
session. Bulk data arrives through IMPORT in practice, and import creates a
whole SHEET, whose insert carries its rows wholesale for one op.

The session refuses to stamp a sync state larger than `SYNC_STAMP_BUDGET`
(2 MB) into the file. Such a copy rejoins as a fresh adopt: it loses two-way
fork merge and loses nothing else.

### 6.7 Ops too large for the relay

A sheet insert carries the whole sheet. Past the relay's frame ceiling it is
refused, the session drops those exact ops from the resend log (or they loop
forever), and the user is told. The local document keeps the change; peers
never see it. Sharing a workbook whose import exceeds the frame budget means
sending the file, not the ops.

### 6.8 Packed columns do not participate

`enc:'pack'` is an author-chosen archive encoding that `store.ts` refuses to
write into. Row inserts and deletes do not maintain it, so a sheet holding a
packed column should not be edited structurally under collab. Pre-existing in
the store; named here because collab makes it easier to hit.

### 6.9 Canvas sheets sync only wholesale

`CanvasSheet.cells` has no patch op in `store.ts`, so nothing can express a
canvas edit as an op. Canvas sheets travel in sheet inserts and snapshots only.
The register scheme is reserved (`cell.<A1>` keys on the sheet node) so this is
additive when the patches exist.

### 6.10 `steps` is a whole-array register

`setSheetProps` refuses `steps` (it is structural), so the transform chain
travels only in sheet payloads and snapshots. Two people appending different
steps concurrently is not expressible today.

---

## 7. Convergence rig

`node scripts/test-dash-sync.ts`, modelled on `scripts/test-sync.ts`.
`SEEDS` / `STEPS` / `ACTORS` / `SEED_ONLY` / `DBG_NODE` / `DIFF_WIDTH`.

N simulated replicas mutate through the SAME patches the editor commits, ops
travel over per-(from,to) FIFO queues in random interleavings, and at
quiescence every replica's materialized workbook AND sync state must be
identical. Plus targeted cases: per-cell LWW, dictionary interning, the row
index (concurrent inserts at one place, insert beside a row someone deleted),
delete-wins, undo resurrection with a dead-window edit, column add/remove/
reorder, rid-aligned column data, sheet delete, gap buffering, log catch-up,
and two-way snapshot merge of offline forks.

It also asserts, after every single apply on every replica, that **every column
array is exactly as long as the sheet has rows** — columnar storage addresses
cells by position, so a column one entry short returns the next row's number
for every row below the gap, silently. That check found a real store bug (§8).

Status:

| configuration | result |
|---|---|
| `SEEDS=60 STEPS=120 ACTORS=3` | ALL PASS (23,071 checks) |
| `SEEDS=200 STEPS=200 ACTORS=3` | ALL PASS (23,631 checks) |
| `SEEDS=200 STEPS=200 ACTORS=4` | ALL PASS (24,031 checks) |
| `SEEDS=300 STEPS=250 ACTORS=4` | ALL PASS (24,631 checks) |
| `SEEDS=400 STEPS=300 ACTORS=5` | ALL PASS (26,031 checks) |
| `SEEDS=500 STEPS=200 ACTORS=4` | **1 failure of 25,075 checks** (seed 374) |
| `SEEDS=300 STEPS=250 ACTORS=5` | **3 failures of 24,303 checks** (seed 184) |
| `SEEDS=600 STEPS=400 ACTORS=6` | **4 failures of 23,982 checks** (seed 116) |

**Seeds 124 and 307 are closed.** They looked like one failure class and were
two, both invisible in the sync state (registers, births, tombs, positions and
version vectors all agreed on both sides; only the workbook differed by a cell).

* **124 was not a dead-window bug at all** — the column in question was never
  deleted. It was `dictLen`: an undo truncating a dictionary a collaborator had
  grown, blanking cells the undoer never touched. See §6.4.
* **307 was** the column dead window, in `replayStashRow`: a parked value was
  weighed only against the ROW's rebirth, never against the COLUMN's, so the
  replica whose row came back AFTER the column's undo restored a number that
  every replica reaching the same rebirth through `resetColumnValues` had
  correctly blanked. See §6.2.

Both now have hand-built deterministic cases in the rig rather than a seed
number ("a column re-added by undo out-stamps a value parked in its dead
window", "undo does not truncate a dictionary a collaborator grew"), each
verified to fail when its own fix is reverted.

**Two open failure classes remain, both pre-existing and both reproducible.**
Neither was introduced by the above; both fail identically on the engine as it
stood before.

1. **Row ORDER diverges at six actors** (seed 116). Values follow their rows
   correctly, structure and sync state agree, but three replicas materialise
   three different row sequences — a baseline row and an inserted row swap.
   This is the fractional-key path, not the value path.
   `SEED_ONLY=116 STEPS=250 ACTORS=6 node scripts/test-dash-sync.ts`
   (clean at ACTORS=4 and ACTORS=5 for the same seed and step count.)
2. **A row resurrected twice, by two different actors, keeps a value only on
   the second resurrector** (seeds 374, 184). The first insert's payload names
   a column, the second's does not; `rnamed` is overwritten by the newer
   insert, so on the receivers `cellAuth(..., fromRow:false)` finds no register
   and the parked value is dropped — while the AUTHOR of the second
   resurrection keeps it. Same neighbourhood as 307, a different asymmetry.
   `SEED_ONLY=374 STEPS=200 ACTORS=4 node scripts/test-dash-sync.ts`
   `SEED_ONLY=184 STEPS=250 ACTORS=5 node scripts/test-dash-sync.ts`

**Both should be closed before collaboration is enabled by default.**

---

## 8. What this needs from the rest of dash

None of these are in this task's ownership. Each is small, and each closes a
real hole rather than a stylistic one.

### store.ts

1. **A patch hook.** `beforePatch(fn: (patches: Patch[]) => void)`, called from
   `commit`, `runEdit` **and `invert`**, with the patches about to be applied.
   The session already looks for it and uses it when present. Without it the
   session wraps `commit`/`runEdit` on the instance — which works, and cannot
   see undo/redo, because those apply inverses through a private method. Today
   undo/redo therefore fall back to broadcasting a whole state snapshot:
   correct, and much heavier than the two ops it replaces.
2. **`insertRows` must clamp the write, not just the splice.** `applyPatch`
   splices `rids` and the column arrays at `at` (which `Array.splice` clamps)
   and then writes the value at the RAW index, so an `at` past the end leaves a
   hole and a column one entry longer than the sheet has rows. Reachable
   exactly under collab: undo of a row delete carries the positions the rows
   had, and a collaborator may have removed rows since. `writeCell(d,
   Math.min(at, len), v)` fixes it; `committable()` refuses such patches
   meanwhile.
3. **`deleteRows` should take the row's overrides with it**, as
   `rowcol.deleteRowsAt` does. The inverse of `insertRows` is a bare
   `deleteRows`, so undoing an insert orphans any override added to the row in
   the meantime — on the undoing replica only, since the engine strips them
   everywhere else.
4. **`setOverrides`' inverse should carry `dropEmpty`.** Undoing the removal of
   the last override leaves `cells: {}` behind on the undoing replica while
   every peer receives it through a path that drops the container. Twelve bytes
   in the file, and a diverged document. The engine normalises it; the store
   should not create it.
5. **A public "changed underneath you" event.** Remote ops are applied
   surgically and must not enter undo history, so the session cannot use
   `commit`; it currently calls the private `emit`.

### model.ts

6. **A durable rid watermark.** `rowcol.ts` already flags this: `nextRidFloor`
   derives the next rid from the current maximum, so two replicas inserting
   concurrently mint the SAME rid for DIFFERENT rows — and rid is now identity.
   Either stamp `sheet.nextRid` on every insert (the field is read already), or
   partition the space by actor. **This must land before collab is enabled**;
   it is the one item on this list that is a correctness precondition rather
   than an improvement. The rig sidesteps it by giving each replica its own rid
   range.

### main.ts

7. Construct the session, mount the panel, connect on eligibility, and stamp
   the state on save — about six lines:
   `const sync = new SyncSession(store)`, `mountPeople(el, sync, store)`,
   `if (sync.shareEligible()) joinFromDoc(sync, store)`,
   `sync.stampInto(store.doc)` before serializing, and `sync.setSheet(id)` when
   the visible sheet changes.

---

## 9. What is reused, and what is a port

`docs/collab-design.md` is the spec for all of it; dash speaks the same wire
format, so ONE relay serves both apps.

**Reused unchanged (protocol and semantics):** the room-id commitment to the
owner pubkey (`w` + b64url(SHA-256(pub))), the owner→invite→member signature
chain, per-socket verification, owner-signed revocation, the AES-GCM frame
envelope, `?tok` possession proof, the 25-second keepalive ping and its
fast-reconnect, refusal handling, the memory-only replay bookmark, the
BroadcastChannel same-machine transport, the hello/need/ops/p/bye/snap frames,
and dormant-until-shared eligibility.

**Ported, not imported:** `online.ts`. Slides' module reaches into slides'
store, model and update modules, so importing it would pull the whole slides
app into dash's bundle. PLATFORM §9 already names this: the collab engine and
relay are "shared but NOT yet in kernel/", and genericizing them is its own
project. When that project happens, these two files are the callers to
reconcile.

**Written for dash:** the engine (`crdt.ts`), the patch tap and snapshot policy
(`session.ts`), and the People panel (`people.ts`).

---

## 10. Public surface

```ts
// dash/src/sync/crdt.ts
class DashSync {
  constructor(actor: string)
  adopt(doc: DashDoc): void                      // a document that has never synced
  local(doc: DashDoc, patches: Patch[]): Op[]    // BEFORE the store applies them
  settle(doc: DashDoc): ApplyResult              // AFTER the store applies them
  apply(doc: DashDoc, ops: Op[]): ApplyResult    // remote ops, applied surgically
  mergeSnapshot(doc, rdoc, rstate): ApplyResult  // offline fork / late joiner
  missingFor(log: Op[], vv): Op[]                // peer catch-up
  toJSON(): SyncStateJSON
  static fromJSON(actor, j): DashSync
  get gappedActors(): string[]
  dead(node: string): boolean
  unsynced: boolean                              // a patch it could not express
}
function committable(doc: DashDoc, p: Patch): boolean  // refuse before minting
```

The ordering contract is the only sharp edge: `local()` runs **before** the
store applies the patches (it has to read what a delete displaces, and its
`prev`/anchor bookkeeping only makes sense against the pre-state), and
`settle()` runs **after** (parked remote ops may have been waiting for exactly
what the user just did). `apply()` handles both halves itself.
