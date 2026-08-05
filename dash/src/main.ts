// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Boot sequence for bento/dash.
//
// Order matters: configure the app, then capture the pristine document BEFORE
// any DOM mutation — the captured copy is what gets re-serialized on save.
//
// THE BOOT DISPATCHER IS THE MOST IMPORTANT TWENTY LINES IN THE APP, because
// getting it wrong destroys data rather than merely failing. `parseDoc` returns
// a tagged result and the ONLY state that reaches the starter workbook is an
// absent or empty block. Everything else refuses, says what it found, and
// offers the bytes back untouched — because anything that failed to parse is
// somebody's data, and replacing it with an empty workbook is a loss the first
// ⌘S makes permanent.
//
// And one case the kernel cannot express: `readEmbeddedDoc` returns
// `text || null`, so "no #bento-doc element" and "element present, text node
// empty" arrive identically. Measured, past the parser's limit the block IS
// present with a zero-length text node and no throw — so that must be told
// apart HERE, where the DOM is still visible, or an oversized workbook opens
// as the starter and saves over itself.

import './styles.css'
import { configureApp, appConfig } from '../../kernel/src/app.ts'
import {
  capturePristine, readEmbeddedDoc, serializeFile, serializeAuto, saveFile,
  parseEnvelope, decryptEnvelope, setEncryptionPassword, isEncryptionActive,
  canWriteInPlace, downloadFile, suggestedFileName, openedFileName, registerPreview,
} from '../../kernel/src/save.ts'
import { putRecovery, pruneOld } from '../../kernel/src/autosave.ts'
import { APP_VERSION } from '../../kernel/src/update.ts'
import { mountAbout, rememberVersion } from './about.ts'
import { mountPanels } from './panels.ts'
import { buildSheetPreview } from './preview.ts'
import { installSaveMenu, adoptOpenedDoc } from './saveui.ts'
import { dismissSplash, dismissSplashNow } from './splash.ts'
import { t } from './i18n.ts'
import {
  parseDoc, docBytes, docBudget, rowCount, DOC_BUDGET_FSA, DOC_BUDGET_DOWNLOAD,
  type DashDoc, type ParseResult, type Column, type ColumnType, type TableSheet,
} from './model.ts'
import { Store } from './store.ts'
import { starterDoc } from './starter.ts'
import { Grid } from './grid.ts'
import { importDelimited } from './import.ts'
import { TYPE_LABEL } from './format.ts'
import { defaultBinding, renderChart, type ChartBinding } from './chart.ts'
import { readCell } from './store.ts'
import {
  insertRowsAt, deleteRowsAt, insertColumn, deleteColumn, resizeColumn,
  autoFitWidth, setHidden, freezeAt, readFrozen } from './rowcol.ts'
import { FUNCTIONS } from './formula.ts'
import { buildScene, defaultViz3d, mountViz3d, type Viz3dBinding, type Viz3dKind } from './viz3d.ts'

configureApp({
  appId: 'bento-dash',
  appName: 'bento/dash',
  manifestUrl: 'https://bento.page/releases/dash/manifest.json',
})

capturePristine()

// The file-manager thumbnail. Registered BEFORE any save can happen: a save
// that ran first would write a shell with no preview in it, and the next
// thumbnail request would show the boot splash again.
registerPreview(buildSheetPreview)

// --- boot -------------------------------------------------------------------

const blockEl = document.getElementById('bento-doc')
const embedded = readEmbeddedDoc()
const envelope = embedded ? parseEnvelope(embedded) : null

if (envelope) {
  void passwordGate(embedded!)
} else if (blockEl && embedded === null && (blockEl.textContent ?? '').length > 0) {
  // present, non-empty, and yet unreadable — the case the kernel flattens
  refuse({ ok: false, err: 'unreadable', detail: t('The document block is present but could not be read.') })
} else {
  const res = parseDoc(embedded ?? '')
  if (res.ok) boot(res.doc, res.repairs.length, res.frozen)
  else if (res.err === 'empty') boot(starterDoc(), 0, undefined)
  else refuse(res)
}

/** An encrypted workbook: ask, then take the same boot path. */
async function passwordGate(raw: string): Promise<void> {
  dismissSplashNow()
  document.body.innerHTML =
    `<div class="dx-gate"><h1>${t('This file is encrypted.')}</h1>` +
    `<p>${t('Enter the password to open this workbook.')}</p>` +
    `<input type="password" class="dx-title" autocomplete="current-password" style="width:100%">` +
    `<p><button class="dx-btn dx-unlock">${t('Unlock')}</button> <span class="dx-err"></span></p></div>`
  const input = document.querySelector<HTMLInputElement>('input')!
  const err = document.querySelector<HTMLElement>('.dx-err')!
  const tryUnlock = async () => {
    const env = parseEnvelope(raw)
    if (!env || !input.value) return
    const json = await decryptEnvelope(env, input.value)
    if (json === null) { err.textContent = t('Wrong password — try again'); input.select(); return }
    const res = parseDoc(json)
    if (!res.ok) { err.textContent = t('Unlocked, but the workbook inside could not be read.'); return }
    setEncryptionPassword(input.value)
    document.body.innerHTML = '<div id="app"></div>'
    boot(res.doc, res.repairs.length, res.frozen)
  }
  document.querySelector('.dx-unlock')!.addEventListener('click', () => void tryUnlock())
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') void tryUnlock() })
  input.focus()
}

/**
 * The refusal surface. It never opens an editor, so nothing downstream can
 * serialize: `boot()` is where the Store, the save handler and the autosave
 * subscription are constructed, and none of them exist on this path.
 */
function refuse(res: Extract<ParseResult, { ok: false }>): void {
  dismissSplashNow()
  const why = res.err === 'empty' ? '' : 'detail' in res ? res.detail : ''
  const found = 'found' in res && res.found ? ` (${res.found})` : ''
  document.body.innerHTML =
    `<div class="dx-gate">` +
    `<h1>${t('This file could not be opened as a bento/dash workbook.')}</h1>` +
    `<p>${esc(why)}${esc(found)}</p>` +
    `<p>${t('Your data has not been changed, and this build will not write to this file. You can take the contents out below.')}</p>` +
    `<code id="dx-raw"></code>` +
    `<button class="dx-btn" id="dx-copy">${t('Copy document JSON')}</button>` +
    `<button class="dx-btn" id="dx-download">${t('Save an untouched copy')}</button>` +
    `</div>`
  const raw = readEmbeddedDoc() ?? ''
  document.getElementById('dx-raw')!.textContent = raw.slice(0, 4000) || t('(the document block is empty)')
  document.getElementById('dx-copy')!.addEventListener('click', () => {
    void navigator.clipboard?.writeText(raw)
  })
  document.getElementById('dx-download')!.addEventListener('click', () => {
    // the file exactly as it arrived — no parse, no re-serialize
    downloadFile(document.documentElement.outerHTML, openedFileName() ?? 'recovered.bento.html')
  })
}

// --- the app ----------------------------------------------------------------

function boot(doc: DashDoc, repaired: number, frozen?: 'policy' | 'version'): void {
  document.title = `${doc.title} — ${appConfig().appName}`
  dismissSplash()

  const store = new Store(doc)
  if (frozen) store.readOnly = true
  // A template mints a fresh docId on open; a read-only copy locks the store
  // (and with it the title field, which reads store.readOnly below).
  adoptOpenedDoc(doc, store)

  const app = document.getElementById('app')!
  app.innerHTML =
    `<header class="dx-bar">` +
    `<span class="dx-mark">bento<span>/</span>dash</span>` +
    `<input class="dx-title" value="">` +
    `<span class="dx-dirty" hidden>•</span>` +
    `<button class="dx-btn" data-act="formula">${t('＋ Formula column')}</button>` +
    `<button class="dx-btn" data-act="chart">${t('＋ Chart')}</button>` +
    `<button class="dx-btn" data-act="viz3d">${t('＋ 3D')}</button>` +
    `<button class="dx-btn" data-act="import">${t('Import CSV…')}</button>` +
    `<button class="dx-btn" data-act="undo">${t('Undo')}</button>` +
    `<button class="dx-btn" data-act="export">${t('Export CSV')}</button>` +
    `<button class="dx-btn" data-act="save">${t('Save')}</button>` +
    `<span class="dx-ver">v${APP_VERSION}</span>` +
    `</header>` +
    `<div class="dx-formula"><span class="dx-ref">A1</span>` +
    `<span class="dx-fx-mark">fx</span>` +
    `<input class="dx-fx-input" spellcheck="false" placeholder="${t('value or = formula')}">` +
    `</div>` +
    `<div class="dx-findings" hidden></div>` +
    `<div class="dx-body"><div class="dx-grid"></div>` +
    `<div class="dx-chart" hidden><div class="dx-chart-head">` +
    `<span class="dx-chart-title"></span>` +
    `<button class="dx-btn dx-chart-kind">${t('Bar')}</button>` +
    `<button class="dx-btn dx-chart-close" title="${t('Hide chart')}">✕</button>` +
    `</div><div class="dx-chart-body"></div></div></div>` +
    `<footer class="dx-status"><span class="dx-status-view"></span>` +
    `<span class="dx-status-sum"></span></footer>`

  const titleEl = app.querySelector<HTMLInputElement>('.dx-title')!
  const dirtyEl = app.querySelector<HTMLElement>('.dx-dirty')!
  const findingsEl = app.querySelector<HTMLElement>('.dx-findings')!
  titleEl.value = doc.title
  titleEl.disabled = store.readOnly

  const refEl = app.querySelector<HTMLElement>('.dx-ref')!
  const fxEl = app.querySelector<HTMLInputElement>('.dx-fx-input')!
  const sumEl = app.querySelector<HTMLElement>('.dx-status-sum')!
  const viewEl = app.querySelector<HTMLElement>('.dx-status-view')!

  const grid = new Grid({ el: app.querySelector<HTMLElement>('.dx-grid')!, store, sheetId: doc.sheets[0].id })

  // --- the formula bar and the status bar, both driven by the selection
  grid.onSelectionChange = (summary, ref, value) => {
    refEl.textContent = ref
    if (document.activeElement !== fxEl) fxEl.value = value
    sumEl.textContent = summary
  }
  fxEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return
    grid.setActiveCell(fxEl.value)
    fxEl.blur()
  })

  // --- the filter and sort menu, hung off each column header's caret
  grid.onFilterMenu = (colId, x, y) => openFilterMenu(store, grid, colId, x, y, viewEl)
  grid.onContextMenu = (row, ci, x, y) => openCellMenu(store, grid, row, ci, x, y)

  // keyboard: the grid owns the key set when nothing else has focus
  document.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement | null
    if (t && (t.tagName === 'INPUT' || t.isContentEditable)) return
    // A bare printable key REPLACES the selected cell — the most-used gesture
    // in a spreadsheet, and the one that makes a grid feel like one. It has to
    // be tried before keyToAction, which returns null for printable keys
    // precisely so that typing can reach here.
    if (!e.metaKey && !e.ctrlKey && !e.altKey && e.key.length === 1) {
      if (grid.typeInto(e.key)) { e.preventDefault(); return }
    }
    if (grid.handleKey(e)) e.preventDefault()
  })
  grid.onRetype = (col, x, y) => retype(store, col, x, y)
  grid.onEditFormula = (col) => editFormula(store, grid, col)

  // --- chart: bound to columns, derived at render, never stored
  const chartEl = app.querySelector<HTMLElement>('.dx-chart')!
  const chartBody = app.querySelector<HTMLElement>('.dx-chart-body')!
  const chartTitle = app.querySelector<HTMLElement>('.dx-chart-title')!
  const kindBtn = app.querySelector<HTMLElement>('.dx-chart-kind')!
  let binding: ChartBinding | null = null
  let teardown: (() => void) | null = null
  const KINDS: Array<ChartBinding['kind']> = ['bar', 'line', 'pie', 'scatter']

  const drawChart = () => {
    if (!binding || chartEl.hidden) return
    teardown?.()
    const sheet = grid.sheet
    chartTitle.textContent = `${sheet.columns.find((c) => c.id === binding!.x)?.name ?? ''} · ` +
      binding.series.map((id) => sheet.columns.find((c) => c.id === id)?.name ?? id).join(', ')
    kindBtn.textContent = binding.kind[0].toUpperCase() + binding.kind.slice(1)
    // hand the grid's freshly computed formula columns in, so the chart shows
    // the numbers on screen rather than the raw columns underneath them
    teardown = renderChart(chartBody, sheet, binding, grid.computed as Map<string, unknown[]>)
  }
  store.on('doc', drawChart)
  kindBtn.addEventListener('click', () => {
    if (viz) {
      viz.kind = KINDS3D[(KINDS3D.indexOf(viz.kind) + 1) % KINDS3D.length]
      draw3d()
      return
    }
    if (!binding) return
    binding.kind = KINDS[(KINDS.indexOf(binding.kind) + 1) % KINDS.length]
    drawChart()
  })
  app.querySelector('.dx-chart-close')!.addEventListener('click', () => {
    chartEl.hidden = true
    teardown?.(); teardown = null
    vizDown?.(); vizDown = null; viz = null
  })
  app.querySelector('[data-act="chart"]')!.addEventListener('click', () => {
    vizDown?.(); vizDown = null; viz = null
    binding = defaultBinding(grid.sheet)
    if (!binding) { showFindings(findingsEl, [{ message: t('This sheet has no numeric column to chart yet.') }]); return }
    chartEl.hidden = false
    drawChart()
  })
  app.querySelector('[data-act="formula"]')!.addEventListener('click', () => addFormula(store, grid))

  // --- 3D: the same panel, a different renderer. Geometry is derived from the
  // columns exactly as the 2D chart's series are, so nothing is stored.
  let viz: Viz3dBinding | null = null
  let vizDown: (() => void) | null = null
  const KINDS3D: Viz3dKind[] = ['scatter', 'surface', 'bars', 'globe']
  const draw3d = () => {
    if (!viz || chartEl.hidden) return
    vizDown?.(); teardown?.(); teardown = null
    const sheet = grid.sheet
    chartTitle.textContent = `3D ${viz.kind} · ` +
      [viz.x, viz.y, viz.z, viz.lat, viz.lon].filter(Boolean)
        .map((id) => sheet.columns.find((c) => c.id === id)?.name ?? id).join(' / ')
    kindBtn.textContent = viz.kind[0].toUpperCase() + viz.kind.slice(1)
    const scene = buildScene(sheet, viz, grid.computed as Map<string, unknown[]>)
    vizDown = mountViz3d(chartBody, scene)
  }
  store.on('doc', () => { if (viz) draw3d() })
  app.querySelector('[data-act="viz3d"]')!.addEventListener('click', () => {
    viz = defaultViz3d(grid.sheet)
    if (!viz) {
      showFindings(findingsEl, [{ message: t('This sheet needs at least three numeric columns, or a latitude and longitude, to plot in 3D.') }])
      return
    }
    binding = null
    chartEl.hidden = false
    draw3d()
  })

  // Sheets on the left, properties on the right — the suite's shared chrome.
  // AFTER grid.onSelectionChange is set: mountPanels CHAINS that callback
  // rather than replacing it, so the formula bar and status bar keep working.
  mountPanels({ store, grid, body: app.querySelector<HTMLElement>('.dx-body')! })

  const notes: Notice[] = []
  if (frozen) {
    notes.push({
      message: frozen === 'version'
        ? t('This workbook was written by a newer version of dash. It is open read-only so nothing is lost.')
        : t('This workbook declares rules this build does not know. It is open read-only so nothing is lost.'),
    })
  }
  if (repaired) {
    notes.push({ message: t('{n} duplicate or missing id(s) were repaired so references resolve.').replace('{n}', String(repaired)) })
  }
  showFindings(findingsEl, notes)

  // --- dirty + autosave
  let dirty = false
  let timer: number | undefined
  const markDirty = () => {
    dirty = true
    dirtyEl.hidden = false
    clearTimeout(timer)
    timer = window.setTimeout(() => {
      // NEVER write an encrypted workbook's plaintext to IndexedDB. The kernel
      // states the rule in its own header and enforces it in neither place, so
      // every app has to remember — and the second one did not.
      if (!isEncryptionActive()) {
        void putRecovery(store.doc)
        // the timeline the About dialog restores from — throttled inside, and
        // it refuses an encrypted workbook for the same reason putRecovery does
        void rememberVersion(store.doc)
      }
    }, 2500)
  }
  store.on('doc', markDirty)

  // The wordmark and the version chip open About. Mounted AFTER markDirty
  // exists — it takes it as the dirty signal for the edits it makes itself.
  mountAbout(app, {
    store,
    showingSheet: () => grid.sheet.id,
    showSheet: (id) => grid.setSheet(id),
    onDirty: markDirty,
  })
  void pruneOld()

  titleEl.addEventListener('input', () => {
    store.commit({ op: 'setTitle', title: titleEl.value })
    document.title = `${titleEl.value} — ${appConfig().appName}`
  })

  // --- actions
  app.querySelector('[data-act="save"]')!.addEventListener('click', () => { void doSave() })
  installSaveMenu({
    button: app.querySelector<HTMLElement>('[data-act="save"]')!,
    store,
    save: doSave,
  })
  app.querySelector('[data-act="undo"]')!.addEventListener('click', () => { store.undo() })
  app.querySelector('[data-act="export"]')!.addEventListener('click', () => exportCsv(store))
  app.querySelector('[data-act="import"]')!.addEventListener('click', () => {
    void pickCsv(store, findingsEl, grid)
  })
  document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey
    if (!mod) return
    const k = e.key.toLowerCase()
    if (k === 's') { e.preventDefault(); void doSave() }
    else if (k === 'z' && !e.shiftKey) { e.preventDefault(); store.undo() }
    else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); store.redo() }
  })
  document.addEventListener('paste', (e) => {
    if ((e.target as HTMLElement)?.isContentEditable) return
    const target = e.target as HTMLElement | null
    if (target && target.tagName === 'INPUT') return
    const text = e.clipboardData?.getData('text/plain')
    if (!text) return
    e.preventDefault()
    // INTO THE CELLS, at the cursor — the gesture every spreadsheet has.
    // This used to route every pasted block into the CSV importer, so ⌘V
    // created a whole new sheet instead of filling the selection, and
    // `grid.pasteTsv` sat there with no callers at all. Importing a file is
    // what the Import button is for; ⌘V is paste.
    grid.pasteTsv(text)
  })

  async function doSave(): Promise<void> {
    if (store.readOnly) return
    // Budget check before every write that grows the document. Not a refusal:
    // the user is told what will actually break, in this browser, and decides.
    const bytes = docBytes(store.doc)
    const budget = docBudget(canWriteInPlace())
    if (bytes > budget) {
      const mb = (bytes / 1024 / 1024).toFixed(1)
      const how = canWriteInPlace()
        ? t('Saving will take a moment.')
        : t('This browser has no in-place save, so every save downloads the whole file.')
      if (!window.confirm(`${t('This workbook is {mb} MB.').replace('{mb}', mb)} ${how} ${t('Save anyway?')}`)) return
    }
    const r = await saveFile(store.doc)
    if (r === 'saved' || r === 'downloaded') { dirty = false; dirtyEl.hidden = true }
  }

  window.addEventListener('beforeunload', (e) => {
    if (dirty && !store.readOnly) { e.preventDefault(); e.returnValue = '' }
  })

  // --- the scripting/agent surface
  ;(window as unknown as Record<string, unknown>).bento = {
    format: doc.format,
    get doc() { return store.doc },
    serialize: () => serializeFile(store.doc),
    serializeAuto: () => serializeAuto(store.doc),
    undo: () => store.undo(),
    redo: () => store.redo(),
    /** patch the workbook — the same objects the store, undo and future ops use */
    commit: (p: unknown) => { store.commit(p as never) },
    importCsv: (text: string, name?: string) => applyImport(store, findingsEl, grid, text, name ?? 'pasted'),
    loadDoc: (json: string): boolean => {
      const r = parseDoc(json)
      if (!r.ok) return false
      store.replaceDoc(r.doc)
      return true
    },
    stats: () => ({ rows: rowCount(store.doc), bytes: docBytes(store.doc), budget: docBudget(canWriteInPlace()) }),
  }
}

// --- import -----------------------------------------------------------------

async function pickCsv(store: Store, host: HTMLElement, grid: Grid): Promise<void> {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.csv,.tsv,.txt,text/csv,text/plain'
  input.addEventListener('change', () => {
    const f = input.files?.[0]
    if (!f) return
    void f.text().then((text) => applyImport(store, host, grid, text, f.name))
  })
  input.click()
}

function applyImport(store: Store, host: HTMLElement, grid: Grid, text: string, source: string): void {
  const sheetId = `sheet-${Math.floor(Date.now() % 1e8).toString(36)}`
  const r = importDelimited(text, {
    name: source.replace(/\.[a-z]+$/i, '') || 'Imported',
    sheetId,
    source,
    at: new Date().toISOString(),
  })
  store.commit({ op: 'setTitle', title: store.doc.title })  // one checkpoint boundary
  store.doc.sheets.push(r.sheet)
  store.replaceDoc(store.doc)
  grid.setSheet(sheetId)
  showFindings(host, r.findings)
}

/**
 * One line in the banner. Import findings and boot notices share a surface
 * because they answer the same question — "what did opening this file decide
 * on my behalf?" — so they get one type rather than one borrowed from import.
 */
interface Notice { message: string }

function showFindings(host: HTMLElement, findings: Notice[]): void {
  if (!findings.length) { host.hidden = true; host.innerHTML = ''; return }
  host.hidden = false
  host.innerHTML = findings.map((f) =>
    `<div class="dx-f"><span class="dx-dot">●</span><span>${esc(f.message)}</span></div>`).join('')
}

/** The correctable half of the type row: import guesses, you settle it. */
/**
 * Pick a column's type.
 *
 * A POPOVER, not `window.prompt`. Import refuses to guess a type it cannot
 * decide and says so, and that refusal is only honest if fixing it is one
 * click — which it was not when the click opened a native dialog asking the
 * reader to type the NUMBER of the type they wanted from a list.
 */
function retype(store: Store, col: Column, x: number, y: number): void {
  const types: ColumnType[] = ['text', 'number', 'money', 'percent', 'date', 'bool']
  const el = popover(x, y, types.map((tp) =>
    `<button data-t="${tp}"${tp === col.type ? ' class="dx-pop-on"' : ''}>` +
    `${esc(TYPE_LABEL[tp])}${tp === col.type ? ' ✓' : ''}</button>`).join(''))
  const sheet = store.doc.sheets.find((s) =>
    s.kind === 'table' && s.columns.some((c) => c.id === col.id)) as TableSheet | undefined
  el.querySelectorAll<HTMLElement>('button').forEach((b) => {
    b.onclick = () => {
      const next = b.dataset.t as ColumnType
      el.remove()
      if (!sheet || next === col.type) return
      store.commit({ op: 'setColumn', sheet: sheet.id, col: col.id, patch: { type: next } })
    }
  })
}

// --- export -----------------------------------------------------------------

function exportCsv(store: Store): void {
  const sheet = store.doc.sheets.find((s) => s.kind === 'table') as TableSheet | undefined
  if (!sheet) return
  const q = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)
  const n = sheet.rids.reduce((a, [, c]) => a + c, 0)
  const lines = [sheet.columns.map((c) => q(c.name)).join(',')]
  for (let i = 0; i < n; i++) {
    lines.push(sheet.columns.map((c) => {
      const d = sheet.data[c.id]
      const v = d?.enc === 'raw' ? d.v[i] : d?.enc === 'dict' ? (d.idx[i] == null ? null : d.dict[d.idx[i]!]) : null
      return q(v == null ? '' : String(v))
    }).join(','))
  }
  const blob = new Blob([lines.join('\r\n')], { type: 'text/csv' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `${suggestedFileName(store.doc).replace(/\.bento\.html$/, '')}.csv`
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// referenced so the budget constants are not tree-shaken out of the bundle,
// and so a reader of this file sees both halves of the rule in one place
void DOC_BUDGET_FSA
void DOC_BUDGET_DOWNLOAD

// --- formulas ---------------------------------------------------------------

/**
 * Add a computed column. One expression for the whole column, so inserting a
 * row changes nothing and there is no range to fall out of date.
 */
function addFormula(store: Store, grid: Grid): void {
  const sheet = grid.sheet
  const names = sheet.columns.map((c) => (/\s/.test(c.name) ? `[${c.name}]` : c.name)).join(', ')
  const expr = window.prompt(
    `${t('Formula for a new column.')}\n\n${t('Columns')}: ${names}\n${t('Functions')}: ${FUNCTIONS.slice(0, 24).join(' ')}…\n\n` +
    `${t('Example')}: Value * Probability`,
    'Value * Probability',
  )
  if (!expr) return
  const name = window.prompt(t('Column name'), t('Computed')) || t('Computed')
  const id = `f-${Math.floor(Date.now() % 1e8).toString(36)}`
  store.commit({
    op: 'addColumn', sheet: sheet.id,
    column: { id, name, type: 'number', formula: expr },
  })
}

/** Double-clicking a computed cell edits the expression that produced it. */
function editFormula(store: Store, grid: Grid, col: Column): void {
  const expr = window.prompt(`${t('Formula for')} "${col.name}"`, col.formula ?? '')
  if (expr === null) return
  store.commit({
    op: 'setColumn', sheet: grid.sheet.id, col: col.id,
    patch: expr.trim() ? { formula: expr } : { formula: undefined },
  })
}


// --- menus -------------------------------------------------------------------

/** A small popover, dismissed by the next click anywhere. */
function popover(x: number, y: number, html: string): HTMLElement {
  document.querySelector('.dx-pop')?.remove()
  const el = document.createElement('div')
  el.className = 'dx-pop'
  el.style.left = `${Math.min(x, innerWidth - 260)}px`
  el.style.top = `${Math.min(y, innerHeight - 40)}px`
  el.innerHTML = html
  document.body.appendChild(el)
  setTimeout(() => {
    const off = (e: MouseEvent) => {
      if (!el.contains(e.target as Node)) { el.remove(); document.removeEventListener('mousedown', off) }
    }
    document.addEventListener('mousedown', off)
  }, 0)
  return el
}

/** Sort and filter for one column — the caret in its header. */
function openFilterMenu(
  store: Store, grid: Grid, colId: string, x: number, y: number, viewEl: HTMLElement,
): void {
  const col = grid.sheet.columns.find((c) => c.id === colId)
  if (!col) return
  const numeric = col.type === 'number' || col.type === 'money' || col.type === 'percent'
  const el = popover(x, y,
    `<button data-a="asc">${t('Sort A → Z')}</button>` +
    `<button data-a="desc">${t('Sort Z → A')}</button>` +
    `<div class="dx-pop-sep"></div>` +
    `<label class="dx-pop-row"><span>${numeric ? t('Greater than') : t('Contains')}</span>` +
    `<input class="dx-pop-in" spellcheck="false"></label>` +
    `<button data-a="apply">${t('Apply filter')}</button>` +
    `<button data-a="clear">${t('Clear filters and sorts')}</button>` +
    `<div class="dx-pop-sep"></div>` +
    `<button data-a="hide">${t('Hide this column')}</button>` +
    `<button data-a="fit">${t('Fit width to content')}</button>` +
    `<div class="dx-pop-sep"></div>` +
    `<button data-a="freeze">${frozenTo(grid, colId) ? t('Unfreeze columns') : t('Freeze up to this column')}</button>`)
  const input = el.querySelector<HTMLInputElement>('.dx-pop-in')!
  const showView = () => {
    const n = store.order[grid.sheet.id]?.length
    viewEl.textContent = n === undefined ? ''
      : t('{n} of {all} rows').replace('{n}', String(n))
          .replace('{all}', String(grid.sheet.rids.reduce((a, [, c]) => a + c, 0)))
  }
  el.querySelectorAll<HTMLElement>('button').forEach((b) => {
    b.onclick = () => {
      const a = b.dataset.a
      if (a === 'asc' || a === 'desc') grid.addSort(colId, a)
      else if (a === 'apply') {
        const v = input.value.trim()
        // `v`, not `value` — and NO `as never`. The cast is what let this
        // compile: filter.ts spells the payload `v`, so `{op:'greater',
        // value:…}` reached the predicate with an undefined bound. Measured
        // before the fix: "greater than 10000" left 0 of 8 rows, and `contains`
        // matched everything, so the feature looked inert rather than wrong.
        grid.setFilter(colId, v === '' ? null : {
          col: colId,
          pred: numeric
            ? { op: 'greater', v: Number(v.replace(/[,\s£$€¥%]/g, '')) }
            : { op: 'contains', v },
        })
      } else if (a === 'clear') grid.clearView()
      else if (a === 'hide') store.commit(setHidden(grid.sheet, colId, true))
      else if (a === 'freeze') {
        // "up to this column" counts VISIBLE position, which is what the reader
        // pointed at; a hidden column between them would otherwise freeze one
        // more column than the menu item named.
        const at = grid.sheet.columns.filter((c) => !c.hidden).findIndex((c) => c.id === colId)
        store.commit(freezeAt(grid.sheet, 0, frozenTo(grid, colId) ? 0 : at + 1))
      }
      else if (a === 'fit') {
        const sh = grid.sheet
        const comp = grid.computed.get(colId)
        store.commit(resizeColumn(sh, colId,
          autoFitWidth((row) => comp ? comp[row] : readCellOf(sh, colId, row), col,
            sh.rids.reduce((n, [, c]) => n + c, 0))))
      }
      showView()
      el.remove()
    }
  })
  input.focus()
}

/** Is the freeze already exactly at this column? Then the item offers to undo it. */
const frozenTo = (grid: Grid, colId: string): boolean => {
  const at = grid.sheet.columns.filter((c) => !c.hidden).findIndex((c) => c.id === colId)
  return readFrozen(grid.sheet).cols === at + 1
}

const readCellOf = (sheet: TableSheet, colId: string, row: number): unknown =>
  readCell(sheet.data[colId], row)

/** Right-click on the grid: the structural operations. */
function openCellMenu(store: Store, grid: Grid, row: number, ci: number, x: number, y: number): void {
  const sheet = grid.sheet
  const col = sheet.columns[ci]
  const el = popover(x, y,
    `<button data-a="irow-above">${t('Insert row above')}</button>` +
    `<button data-a="irow-below">${t('Insert row below')}</button>` +
    `<button data-a="drow">${t('Delete row')}</button>` +
    `<div class="dx-pop-sep"></div>` +
    `<button data-a="icol">${t('Insert column')}</button>` +
    `<button data-a="dcol">${t('Delete column')}</button>` +
    `<div class="dx-pop-sep"></div>` +
    `<button data-a="fill">${t('Fill down')}</button>` +
    `<button data-a="clear">${t('Clear contents')}</button>` +
    `<div class="dx-pop-sep"></div>` +
    `<button data-a="cf-scale">${t('Colour scale')}</button>` +
    `<button data-a="cf-bar">${t('Data bars')}</button>` +
    `<button data-a="cf-off">${t('Remove formatting')}</button>`)
  el.querySelectorAll<HTMLElement>('button').forEach((b) => {
    b.onclick = () => {
      const a = b.dataset.a
      // `row` is a VISIBLE index and every structural op takes a canonical
      // one. They differ the moment somebody sorts, and passing the wrong one
      // deletes the wrong row — silently, because the view re-sorts over the
      // evidence. Each edit also carries the reference shift for the cell
      // formulas, in the SAME commit: a document where the rows have moved and
      // the formulas have not is a workbook of plausible wrong numbers.
      const at = grid.canonicalRow(row)
      if (a === 'irow-above') {
        store.commit([...insertRowsAt(sheet, at, 1), ...grid.shiftFormulas('row', at, 1)])
      } else if (a === 'irow-below') {
        store.commit([...insertRowsAt(sheet, at + 1, 1), ...grid.shiftFormulas('row', at + 1, 1)])
      } else if (a === 'drow') {
        store.commit([...deleteRowsAt(sheet, at, 1), ...grid.shiftFormulas('row', at, -1)])
      } else if (a === 'icol') {
        const name = window.prompt(t('Column name'), t('New column')) || t('New column')
        const id = `c-${Math.floor(Date.now() % 1e8).toString(36)}`
        const cAt = sheet.columns.findIndex((c) => c.id === col?.id) + 1
        store.commit([...insertColumn(sheet, cAt, { id, name, type: 'text' }),
          ...grid.shiftFormulas('col', cAt, 1)])
      } else if (a === 'dcol' && col) {
        const cAt = sheet.columns.findIndex((c) => c.id === col.id)
        store.commit([...deleteColumn(sheet, col.id), ...grid.shiftFormulas('col', cAt, -1)])
      }
      else if (a === 'fill') grid.fillDownSelection()
      else if (a === 'clear') grid.clearSelection()
      else if (col && (a === 'cf-scale' || a === 'cf-bar' || a === 'cf-off')) {
        // Conditional formats are DOCUMENT data — they travel with the file —
        // and live in an additive field, so an older build keeps them.
        const cf = { ...((sheet as unknown as { condfmt?: Record<string, unknown> }).condfmt ?? {}) }
        if (a === 'cf-off') delete cf[col.id]
        else if (a === 'cf-scale') cf[col.id] = [{ kind: 'colorScale', colors: ['#fee2e2', '#fef9c3', '#dcfce7'] }]
        else cf[col.id] = [{ kind: 'dataBar', color: '#F7A600', negativeColor: '#E1616C' }]
        store.commit({ op: 'setSheetProps', sheet: sheet.id, props: { condfmt: cf } } as never)
      }
      el.remove()
    }
  })
}
