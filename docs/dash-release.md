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

- **dash has no release path.** `scripts/release.mjs` has no dash support and
  `docs/RELEASING.md` does not mention it. Nothing signs a dash shell, so
  `update.ts`'s signature check can never pass.
- **The update manifest does not exist.** `main.ts` declares
  `manifestUrl: https://bento.page/releases/dash/manifest.json`; nothing in
  `site-src/` produces it. A shipped file would check a 404 forever.
- **No launch-time update check.** `checkForUpdates` has exactly one call site —
  the About dialog's button. slides checks at launch and badges the topbar. A
  shipped workbook that nobody opens About in never learns an update exists.
- **No Offline toggle.** `about.ts` READS `offlineEnabled()` to print "Offline
  mode is on, so nothing was contacted", but dash ships no UI that can set it —
  `setOffline` is imported nowhere. For an app with live collaboration, the
  privacy switch has to be reachable without editing localStorage.
- **`docs/DECISIONS.md` entries are owed** for the decisions taken this week:
  the view vector as the single source for footer/chart/find, the chart pinned
  to its sheet, tabs at the bottom with reorder as a patch, and Find's
  displayed-vs-stored matching rule.

## 1 · Loses or misstates data

- **No file write-back.** slides silently rewrites the real file every 2.5s once
  it holds a handle. dash writes an IndexedDB snapshot and never touches the
  file, so everything since the last manual ⌘S depends on recovery. *(The
  honesty half is done: `putRecovery`'s false result is now surfaced.)*
- **`Grid.setSheet` clears `filters`/`sorts` but not `store.order[id]`.**
  Returning to a previously filtered sheet paints filtered rows above an empty
  filter menu — the rows are hidden and nothing on screen says why. Now that the
  footer, the chart and Find all read that vector, they will all agree with each
  other and all be wrong together.
- **`dashboard.ts:741` spreads one argument per row.** A 400k-row workbook
  renders, then throws `RangeError: Maximum call stack size exceeded`, and the
  loader paints an opaque error card over a working app. `condfmt.ts:52` already
  documents the hazard and avoids it.

## 2 · Expected of any spreadsheet, and absent

- **The totals row cannot be clicked.** The footer shows SUM/AVG, but the only
  way to set one is the properties panel's `Total` dropdown, one column at a
  time. Every spreadsheet lets you click the total cell and choose. *(Raised by
  the first person to use it, which is the whole argument.)*
- **No print, no PDF.** Zero `@media print` rules. Printing today emits one page
  of app chrome with the table crushed into a column and the right-hand columns
  clipped. Rows are virtualised, so a naive print can only ever emit the ~55
  rows on screen — this needs a real page builder, repeated headers and page
  breaks, as slides has.
- **No cell formatting at all.** No bold, no italic, no per-cell colour in the
  model — `CellOverride` carries value and formula only. ⌘B and ⌘I are unbound
  because there is nothing to bind them to. Conditional formats exist; manual
  ones do not.
- **Stale readouts.** The name box, the formula bar and the status bar go stale
  after a sort, a sheet switch, or "Clear filters and sorts" — `showView()` has
  one caller, inside the filter menu. The cursor is right and the edit lands in
  the right cell; the three labels describing it are not.

## 3 · Correctness debt with a known shape

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
