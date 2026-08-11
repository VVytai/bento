# Two kinds of sheet: spreadsheets and datasets

Proposal, 2026-08-11. Not built. Settles the tension found when someone asked
why the footer's `SUM` was not a formula in D9: dash ships the *table* model
while painting the *canvas* model, with nothing saying which you are in.

## The decision

A workbook holds two kinds of sheet, and the difference is **where the type
lives**.

| | **Spreadsheet** | **Dataset** |
|---|---|---|
| Typed by | the **cell** | the **column** |
| Extent | unbounded — rows and columns past the data | exactly the rows there are |
| `=SUM(...)` | in any cell, including below the data | per-cell, plus one expression down a whole column |
| Storage | sparse: only cells someone touched | columnar, dictionary-encoded, typed arrays |
| Good at | modelling, one-off arithmetic, a shape nobody planned | volume, joins, group-bys, refusing to guess |
| Bad at | 100k rows | being a scratchpad |

Neither is a lesser version of the other. A spreadsheet is a *canvas that
happens to hold numbers*; a dataset is *a table that knows what it is*.

## Why not just one

Making the dataset unbounded would mean a type per cell, which loses the column
type — and the column type is what earns the column formula, the refusal to
guess on import, the conditional formats, the chart binding, and a kernel that
group-bys 10M rows in 11.5 ms from `file://`.

Making everything a spreadsheet loses all of that and gives back Excel, which
is not worth building again.

So: both, named, with an honest conversion between them.

## What already exists

More than expected. This is not a from-scratch feature.

- **`cellformula.ts` is the spreadsheet engine, already written**: `cellKey(row,
  col)`, `bindRefs`, `cellDeps`, `evalCell`, and `recalcCells` with dependency
  ordering. It exists because "a spreadsheet that cannot put a number in one
  cell is not a spreadsheet" — its own words.
- **`CellOverride` already carries per-cell value and formula**, plus `xlsxF`,
  the formula an imported .xlsx held verbatim even when dash cannot evaluate it.
- **The format already tolerates a new kind.** `parseDoc` preserves an
  unrecognised `kind` VERBATIM rather than coercing it to a table — the
  additivity invariant (PLATFORM §3), already fixed and commented. Old builds
  round-trip a spreadsheet sheet without damaging it.
- **`a1.ts` already lexes `Sheet1!A1` and `Table1[Col]`** as qualified names.
- The tab strip already renders non-table kinds with a chip and a tooltip.

## Model shape

`kind: 'table'` stays the wire word for a dataset — renaming it would break
every file that exists, and the UI label is a display concern (the same rule
`select()` follows: values stay model words). The new kind is `kind: 'grid'`.

```ts
export interface GridSheet {
  id: string
  name: string
  kind: 'grid'
  /** sparse — only cells somebody touched. `cellKey(row, col)` → value/formula */
  cells: Record<string, GridCell>
  /** how far the user has scrolled the frontier out, so an empty sheet is small */
  extent?: { rows: number; cols: number }
  /** per-cell display format, and column widths — NOT types */
  widths?: Record<number, number>
  comments?: Comment[]
}
```

A cell's type is a property of its **value** (number, text, date, bool),
resolved at read time, plus an optional per-cell format string. There is no
column type, because on this kind of sheet there is no column.

## The bridge, which is the actual product

Two sheet kinds is a feature. The **conversion between them** is the thing
neither Excel nor a BI tool does well:

- **Promote a range to a dataset.** Select A1:F400 on a spreadsheet → "Make this
  a dataset". dash infers a type per column and *refuses where it cannot decide*,
  which is the behaviour import already has. The result is a dataset sheet, so
  it gets column formulas, conditional formats, charts, pivots and — when it
  lands — SQL.
- **Open a dataset as a spreadsheet.** A flat, cell-typed copy for the one
  awkward calculation the pipeline cannot express. It is a copy, and it says so;
  the live thing is the dataset.

That round trip is the answer to "I have a table but I need one weird number in
the corner", which is why people abandon BI tools for Excel in the first place.

## Consequences worth stating before building

- **Storage.** A spreadsheet with A1 and Z10000 filled must not allocate 10,000
  rows. Sparse map, and `extent` bounds the rendered frontier.
- **Collaboration.** The CRDT keys dataset rows by `rid` (`r␟<sheet>␟<rid>`).
  A spreadsheet has no rids: its cells are keyed by position, so a node is
  `g␟<sheet>␟<col>,<row>` and inserting a row *moves* cells rather than
  renumbering identities. That is a real difference and needs its own
  convergence rig, not a reused one.
- **Cross-sheet references.** `a1.ts` lexes `Sheet1!A1` but nothing resolves it.
  A spreadsheet without cross-sheet refs is half a spreadsheet, so this is in
  scope for the kind, not a later nicety.
- **SQL / database mode** (`docs/dash-sql.md`) operates on **datasets**. That is
  now a clean statement rather than a limitation: a query needs typed columns,
  and this is the kind that has them.
- **Charts and pivots** bind to datasets. From a spreadsheet you promote a range
  first — one extra step, and it is the step that makes the chart trustworthy.
- **The starter workbook** should open with one of each, because the difference
  is the thing to teach in the first ten seconds.
- **`.xlsx` import** currently lands as a dataset and guesses types. It should
  land as a **spreadsheet** — that is what an xlsx *is* — and offer promotion.
  This probably improves fidelity: `xlsxF` exists precisely because import meets
  formulas it cannot place in a column model.

## Not in scope for the first cut

Merged cells, per-cell borders and fills (dash has no manual cell formatting at
all yet — its own backlog item), array formulas, and iterative/circular
calculation.

## Sequencing

The honest order, given `docs/dash-release.md` §0 is now clear:

1. **Ship a release first.** It is a day of changelog and a version bump, and it
   makes the second release able to prove the update path, which nothing else
   can.
2. **Spreadsheet kind**, because it fixes something people hit in the first
   minute and most of the engine is written.
3. **Step engine**, owed regardless — `applySteps` currently throws.
4. **SQL surface** on top of it, which is small once 3 exists.

Doing 4 before 2 would ship a query language for an app whose grid still cannot
take `=SUM(` below a column.
