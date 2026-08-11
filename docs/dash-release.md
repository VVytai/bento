# bento/dash — what is left before a first release

Status as of 2026-08-10, branch `worktree-bento-dash` (35 commits ahead of main,
no PR open). This is the working backlog, ordered by what it costs the person
using the file. It is not a wish list: everything here is either something that
loses or misstates data, something that blocks shipping at all, or something a
spreadsheet is simply expected to do.

Each item says what happens **today**, because a backlog whose entries describe
intentions rather than observations rots quietly.

---

## 0 · Blocks shipping at all

These are not features. Until they are done there is no such thing as a dash
release, only a build.

- ~~**dash has no release path.**~~ **Done.** `node scripts/release.mjs --app
  dash` builds, gates and signs; `publish-site.mjs` is app-aware and creates
  the `dash-vX.Y.Z` GitHub release with `Bento_Dash.bento.html` attached and
  notes from `dash/CHANGELOG.md`. It used to read slides' manifest for the
  version, which meant a dash publish looked up slides' tag, found the release
  already there and exited 0 having created nothing. `docs/RELEASING.md` now
  covers all three apps, and `scripts/test-release-channel.mjs` rehearses a
  whole release — signature, hash pin, app id, monotonicity, and every refusal
  — against `kernel/src/update.ts` itself with a throwaway key. CI runs it.
- ~~**The update manifest does not exist.**~~ **Done, at the point of
  release.** The manifest is not a site source: `release.mjs` signs it from the
  shell it just staged, so the pinned sha256 is always the bytes being served.
  A dash release writes `site/releases/dash/manifest.json` and it goes live
  with the publish. Until the first dash release is actually cut, that URL 404s
  — which the launch check treats as "could not check", not as an update.
- ~~**No launch-time update check.**~~ **Done.** `about.ts` exports
  `checkAtLaunch`, called once from `main.ts`. It badges the ⓘ button and the
  version chip (both open About) rather than interrupting, and About says what
  the launch check found. It is gated on `shouldCheckAtLaunch` — a saved
  workbook, the launch check not opted out, and Offline mode off. **A workbook
  nobody has saved never checks**: the shipped shell's `#bento-doc` is empty,
  so the demo at bento.page/dash and every fresh download boot the starter
  through that path, and a fresh document phoning home is the §5 failure the
  dormancy rule exists to prevent.
- ~~**No Offline toggle.**~~ **Done.** Both switches are in About now — "check
  automatically at launch" and "Offline mode". Offline HANGS UP an open relay
  socket rather than only refusing the next connection (`disconnectOnline`);
  turning it back off re-joins if the workbook is shared.
- **`docs/DECISIONS.md` entries are owed** for the decisions taken this week:
  the view vector as the single source for footer/chart/find, the chart pinned
  to its sheet, tabs at the bottom with reorder as a patch, and Find's
  displayed-vs-stored matching rule.

Still true, and worth knowing before cutting `dash-v0.2.0`:

- **No pack channel** (`packs: false` in the registry) — the seven core
  catalogs are compiled in and complete; extra languages would need the
  `save.ts`/`update.ts` pack hooks slides has. Deferring the catalog is fine;
  deferring the channel would not be.
- **The first release cannot exercise the update path.** There is nothing
  published to update FROM. Prove it on the second release, from a copy of the
  first.

## 1 · Loses or misstates data

- **No file write-back.** slides silently rewrites the real file every 2.5s once
  it holds a handle. dash writes an IndexedDB snapshot and never touches the
  file, so everything since the last manual ⌘S depends on recovery. *(The
  honesty half is done: `putRecovery`'s false result is now surfaced.)*
- ~~**`Grid.setSheet` clears `filters`/`sorts` but not `store.order[id]`.**~~
  **Done**, as a side effect of the status line — a truthful description of the
  view made the phantom view impossible to leave in.
- **`dashboard.ts:741` spreads one argument per row.** A 400k-row workbook
  renders, then throws `RangeError: Maximum call stack size exceeded`, and the
  loader paints an opaque error card over a working app. `condfmt.ts:52` already
  documents the hazard and avoids it.

## 2 · Expected of any spreadsheet, and absent

- **THE GRID ENDS AT THE DATA, and pretends otherwise.** An 8-row sheet has no
  row 9: ArrowDown from the last row does nothing, and pressing `=` there opens
  the editor on the LAST DATA CELL — so the universal gesture, "click below the
  numbers and type `=SUM(`", silently targets a cell holding real data instead.
  The ruled lines under the total look exactly like empty rows and are
  `.dg-table` background paint; clicking them selects nothing (measured).
  Consequences: the footer total is not a formula and cannot be one (it is
  `sheet.totals`, a column property), and reaching the 91 functions requires
  either the `fx` column button or typing `=` into a row that already exists —
  so writing `=SUM(Value)` in a cell means inserting a row first, which nobody
  will discover.

  This is the model tension, not a bug to patch: dash says *a sheet is a typed
  table*, Excel says *a sheet is an infinite canvas where data sits top-left*.
  The typed model earns the column formulas, the type refusals and the columnar
  speed. But the current state is the worst of both — it LOOKS like the canvas
  model and behaves like the table model, with no signal about which. The fix
  is real empty rows past the data that append on first type (Sheets' answer),
  which is what the background is already impersonating.
  *(Found by the first person to look at the totals row and ask why it was not
  a formula.)*


- ~~**The totals row cannot be clicked.**~~ **Done.** The footer cell IS the
  control: click it for sum/avg/count/min/max/No total, written through the
  existing `totalsPatch` so there is still one path to `sheet.totals`. An empty
  cell under a numeric column shows a dim invite rather than sitting dead, and
  the menu flips above the cell because the footer is sticky at the window's
  bottom edge. Two display bugs surfaced by making it reachable: `count` was
  borrowing the column's money format (`count £8.00`), and a custom-formula
  total rendered as `[object Object]`.
- **No print, no PDF.** Zero `@media print` rules. Printing today emits one page
  of app chrome with the table crushed into a column and the right-hand columns
  clipped. Rows are virtualised, so a naive print can only ever emit the ~55
  rows on screen — this needs a real page builder, repeated headers and page
  breaks, as slides has.
- **No cell formatting at all.** No bold, no italic, no per-cell colour in the
  model — `CellOverride` carries value and formula only. ⌘B and ⌘I are unbound
  because there is nothing to bind them to. Conditional formats exist; manual
  ones do not.
- ~~**Stale readouts.**~~ **Done.** `applyView()` — which every sort, filter,
  clear, sheet switch and structural edit funnels through — now announces, and
  the status text lives in `grid.ts` (`viewStatusText`) because the grid owns
  the view. The filter menu delegates to it instead of keeping a second copy
  that knew nothing about sorts. Says rows only when some are hidden, since
  "8 of 8 rows" was noise.

## 3 · Correctness debt with a known shape

- **`exportCsv` exports the wrong sheet.** It takes
  `sheets.find(kind === 'table')` — the FIRST table sheet in the workbook,
  regardless of which one is on screen. Correct-looking when a workbook had one
  sheet; plainly wrong now there are tabs.

- **Pivot and canvas sheets cannot be renamed.** `applySheetProps` narrows
  through `table(doc, id)` and throws otherwise, so the tab strip ships a
  deliberately disabled menu item.
- **A sheet reorder's undo entry stringifies the whole sheet** for byte
  accounting. Correct, but O(sheet) for an O(1) operation; a dedicated
  `reorderSheets` op fixes it.
- **About's version restore is not undoable** while the recovery banner's is —
  `recovery.ts` holds the pre-restore document and offers "Undo restore", and
  About should use the same pattern rather than a `confirm()`.
- **The grid is invisible to assistive technology.** No `role="grid"`, no
  `gridcell`, no `aria-*`; after clicking a cell `document.activeElement` is
  `BODY`. Keyboard navigation itself is complete and good, which makes this
  more fixable than it sounds.

## 4 · Tidying

- `panels.css` carries ~90 dead rules (`.dp-left`, `.dp-sheet*`, `.dp-add`, the
  phone-drawer rules) left by the sheet list moving to the tab strip.
- No i18n language **packs** — the seven catalogs are bundled core only. slides
  has the pack mechanism (`docs/i18n-packs.md`); dash would need the `save.ts` /
  `update.ts` hooks.
- The starter workbook is still a sales pipeline with eight rows. It should show
  what dash does that a spreadsheet does not.

---

## Done this week, for the record

Footer totals now follow the filter · chart agrees with the table and is pinned
to its own sheet · Find (the grid is virtualised, so the browser's own find
reports absent values as missing) · sheet tabs along the bottom, reorder as an
undoable patch · `window.prompt` gone from all four call sites · every ⌘S
outcome reported, including the download-instead-of-save case · Redo button ·
eight UI languages with numbers that follow the reader's locale · boot 952ms →
93ms with a no-JS backstop for a truncated download · read-only workbooks that
actually refuse writes · validator, comment threads, crash recovery, drag-and-
drop open · 29 rigs in CI, up from 2 a fortnight ago.
