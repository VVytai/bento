// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The boot-time recovery offer: the READ half of auto-save.
//
// dash has been writing `putRecovery(store.doc)` on every debounced edit since
// the autosave landed (main.ts) and has never once called `getRecovery`. That
// is the worst shape a backstop can have: snapshots accumulate in IndexedDB,
// the browser reports storage used, and the work is offered back to nobody. A
// crash, a closed tab, an OS update at 3am — the file on disk is stale, the
// recovered document is sitting in the database, and the reader is told
// nothing. Slides shows a Restore/Discard banner; this is dash's.
//
// THREE RULES, each of which is a way this could do harm rather than good:
//
//  1. NEVER OFFER WHAT IS ALREADY IN THE FILE. The snapshot is compared to the
//     loaded document by CONTENT (`contentKey`), not by timestamp: autosave
//     fires 2.5s after the last keystroke and a save usually follows, so the
//     snapshot is almost always present and almost always identical. A banner
//     on every single open is a banner nobody reads, and the one time it means
//     something it will be dismissed by reflex.
//  2. NEVER FOR AN ENCRYPTED WORKBOOK. main.ts refuses to snapshot one
//     (plaintext to disk is what the password exists to prevent), so any row
//     under this docId was written BEFORE the password was set — pre-encryption
//     plaintext, which restoring would put back on screen and, at the next ⌘S,
//     back into the file. `mountRecovery` therefore does not even read the
//     store when a password is held, and `decide` refuses on the same flag so
//     the rule is provable without a browser.
//  3. NEVER INTO A WORKBOOK THIS BUILD REFUSES TO WRITE. A document frozen by
//     an unknown policy or a future format version opens read-only precisely so
//     nothing is lost; restoring over it is a write.
//
// RESTORING IS NOT ⌘Z-ABLE, and that is dash's shape rather than a shortcut:
// `Store.replaceDoc` empties both undo stacks (store.ts) because history here
// is typed inverses, not document snapshots, and an inverse minted against
// another document is meaningless. So the banner holds the pre-restore document
// itself and offers ONE explicit "Undo restore" — which is the guarantee the
// user actually wants, spelled where they can see it, rather than a keystroke
// that would silently do nothing.

import './recovery.css'
import { getRecovery, clearRecovery, type Snapshot } from '../../kernel/src/autosave.ts'
import { isEncryptionActive } from '../../kernel/src/save.ts'
import { planReplace } from './about.ts'
import { parseDoc, type DashDoc } from './model.ts'
import type { Store } from './store.ts'
import { t } from './i18n.ts'

// --- the content key ---------------------------------------------------------

/**
 * Top-level fields that churn WITHOUT anybody editing anything, and so must not
 * make a snapshot look different from the file it came from.
 *
 *  · `modified` — a save stamps it; two identical documents saved a minute
 *    apart differ here and nowhere else.
 *  · `collab` — sync state is stamped into the file on save (PLATFORM §5).
 *    dash mints no credentials yet, but the field is in the model, a
 *    hand-written or imported workbook can arrive carrying one, and adding it
 *    to this list later would not reach snapshots already written.
 *
 * Everything else counts, INCLUDING fields this build does not know. The format
 * is additive forever (PLATFORM §3): an unknown top-level key is somebody's
 * data, written by a newer build or an agent, and a change to it is a change.
 * A whitelist — which is what slides uses — would call that "no edits found".
 */
export const VOLATILE_KEYS = ['modified', 'collab'] as const

/**
 * A stable string for "what this document SAYS", ignoring the volatile fields.
 *
 * Object keys are sorted, which plain `JSON.stringify` does not do. The two
 * documents being compared reach here by different routes — one parsed from the
 * #bento-doc block at boot, one parsed from a snapshot written in an earlier
 * session and then run through `parseDoc` again — and key ORDER is an
 * artefact of how each object was built. Without the sort, a reordering that
 * changes nothing at all shows the user a banner claiming unsaved work, they
 * click Restore, and the app swaps in a document identical to the one already
 * open. Cheap enough to be uninteresting: the sort touches object keys, and a
 * workbook's bulk is arrays of values, which are left in order (order IS the
 * data there — row 3 is row 3).
 */
export function contentKey(doc: DashDoc): string {
  const skip = new Set<string>(VOLATILE_KEYS)
  const rest: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(doc)) if (!skip.has(k)) rest[k] = v
  return stable(rest)
}

function stable(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null'
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
  const o = v as Record<string, unknown>
  const keys = Object.keys(o).sort()
  // `undefined` is not JSON and JSON.stringify drops such keys from an object;
  // dropping them here too keeps `{a:1}` and `{a:1,b:undefined}` equal, which
  // is what a round trip through the snapshot's JSON makes of them anyway.
  return `{${keys.filter((k) => o[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(',')}}`
}

// --- the decision ------------------------------------------------------------

/** Why an offer was withheld. Named rather than boolean so the rig can tell a
 *  deliberate refusal from a snapshot that merely matched. */
export type NoOfferReason =
  | 'none'        // nothing in the store for this docId
  | 'encrypted'   // rule 2 — the snapshot predates the password, if it exists at all
  | 'read-only'   // rule 3 — this build will not write this workbook
  | 'unreadable'  // the snapshot is not a workbook this build can open
  | 'other-doc'   // defensive: a snapshot filed under another docId
  | 'same'        // rule 1 — the file already has these edits

export type RecoveryDecision =
  | { offer: true; doc: DashDoc; at: number }
  | { offer: false; why: NoOfferReason }

export interface DecideInput {
  snapshot: Snapshot | null
  /** the workbook that actually loaded from the file */
  doc: DashDoc
  /** a password is held this session — `isEncryptionActive()` at the call site */
  encrypted: boolean
  /** the store refuses commits (frozen doc, or a `readonly` copy) */
  readOnly: boolean
}

/**
 * The whole of the offer/no-offer question, with no DOM and no IndexedDB in it,
 * so every branch above is provable in `scripts/test-dash-recovery.ts`.
 *
 * The snapshot is run through `parseDoc` rather than trusted: it is this app's
 * own JSON, but it was written by an EARLIER build, may predate an id repair,
 * and may declare a policy this build refuses. A snapshot that cannot be opened
 * is not offered — the alternative is a Restore button that hands the app a
 * document it will then refuse, which is a dead end wearing a live button.
 */
export function decide(input: DecideInput): RecoveryDecision {
  if (input.encrypted) return { offer: false, why: 'encrypted' }
  if (input.readOnly) return { offer: false, why: 'read-only' }
  if (!input.snapshot) return { offer: false, why: 'none' }
  if (input.snapshot.docId !== input.doc.docId) return { offer: false, why: 'other-doc' }
  const res = parseDoc(input.snapshot.json)
  if (!res.ok) return { offer: false, why: 'unreadable' }
  if (contentKey(res.doc) === contentKey(input.doc)) return { offer: false, why: 'same' }
  return { offer: true, doc: res.doc, at: input.snapshot.at }
}

// --- swapping a whole workbook in -------------------------------------------

/**
 * What a module needs in order to put a different workbook on screen.
 *
 * `showingSheet`/`showSheet` are the grid's, and they are not optional: see
 * `planReplace` (about.ts) — `Grid.sheet` THROWS when the sheet id it holds is
 * missing from the document, and it reads it from a `doc` listener registered
 * before every other one, so an incoming workbook with different sheet ids
 * takes the dirty flag and the chart down with it and leaves the app half
 * swapped.
 */
export interface WorkbookHost {
  store: Store
  showingSheet: () => string
  showSheet: (id: string) => void
  /**
   * The document changed underneath the chrome main.ts owns — the title field
   * is set once at boot and only rewritten by its own `input` handler, so
   * without this it keeps showing the name of the workbook that was replaced.
   */
  afterSwap?: (doc: DashDoc) => void
}

/**
 * Swap `next` in without tripping the grid. False when the incoming workbook
 * has no table sheet to show, or when this build will not write this document.
 *
 * This is `replaceWorkbook` from about.ts, which is private to that module.
 * Deliberately re-stated rather than reached for: about.ts's copy is coupled to
 * `AboutHooks` (it also carries `onDirty`, which is about document PROPERTIES
 * and has nothing to do with a swap). What must not diverge is `planReplace`,
 * and that is imported, not copied.
 */
export function swapWorkbook(host: WorkbookHost, next: DashDoc): boolean {
  // `replaceDoc` does NOT check `store.readOnly` — it is the load path, not an
  // edit path — so a frozen workbook has to be defended by every caller.
  if (host.store.readOnly) return false
  const plan = planReplace(next, host.showingSheet())
  if (!plan) return false
  if (plan.carry) {
    const carried = host.store.doc.sheets.find((s) => s.id === host.showingSheet())
    host.store.replaceDoc(carried ? { ...next, sheets: [...next.sheets, carried] } : next)
    host.showSheet(plan.show)
  }
  host.store.replaceDoc(next)
  host.afterSwap?.(next)
  return true
}

// --- the banner --------------------------------------------------------------

/**
 * Check for unsaved work and, if there is any, offer it back. Call once, after
 * the Store exists and the grid is mounted.
 *
 * Resolves to what was decided, so a caller (and the rig's DOM half, if one is
 * ever written) can assert on it. Never throws: a failure here must not be able
 * to take down a boot that has otherwise succeeded.
 */
export async function mountRecovery(host: WorkbookHost): Promise<NoOfferReason | 'offered'> {
  const doc = host.store.doc
  // Rule 2, enforced before the read as well as inside `decide`: an encrypted
  // session has no business touching this store at all.
  if (isEncryptionActive()) return 'encrypted'
  let snapshot: Snapshot | null = null
  try { snapshot = await getRecovery(doc.docId) } catch { return 'none' }
  const d = decide({ snapshot, doc, encrypted: false, readOnly: host.store.readOnly })
  if (!d.offer) return d.why
  showBanner(host, d.doc, d.at)
  return 'offered'
}

function showBanner(host: WorkbookHost, recovered: DashDoc, at: number): void {
  document.querySelector('.dxr-bar')?.remove()
  const bar = document.createElement('div')
  bar.className = 'dxr-bar'
  bar.setAttribute('role', 'status')

  const when = new Date(at).toLocaleString([], {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
  const msg = document.createElement('span')
  msg.className = 'dxr-msg'
  msg.textContent = t('Unsaved changes from {when} were found in this browser.', { when })

  const restore = btn(t('Restore'), 'dxr-primary')
  const discard = btn(t('Discard'))
  // ONE dismiss button for the banner's whole life. Appending a fresh one after
  // a restore left two ✕ side by side — measured in the browser, and exactly
  // the kind of thing that only shows up after the second state is reached.
  const x = closeBtn(bar)

  restore.addEventListener('click', () => {
    // Held BEFORE the swap: `replaceDoc` empties the undo stacks, so this
    // object is the only route back to what is on screen right now.
    const before = host.store.doc
    if (!swapWorkbook(host, recovered)) {
      msg.textContent = t('Those changes could not be restored into this workbook.')
      restore.remove()
      return
    }
    // The snapshot stays in IndexedDB deliberately. If the restore turns out to
    // be wrong and the window is closed without saving, the next open must
    // still find it — clearing here would burn the only copy at the exact
    // moment the user is least sure.
    msg.textContent = t('Restored the unsaved changes from {when}.', { when })
    restore.remove()
    discard.remove()
    const undo = btn(t('Undo restore'))
    undo.addEventListener('click', () => {
      swapWorkbook(host, before)
      bar.remove()
    })
    bar.insertBefore(undo, x)
  })

  discard.addEventListener('click', () => {
    void clearRecovery(host.store.doc.docId)
    bar.remove()
  })

  bar.append(msg, restore, discard, x)
  document.body.append(bar)
}

/**
 * Dismiss WITHOUT discarding — the third answer, and the only honest one for
 * "not now". Discard deletes the snapshot; ✕ leaves it where it is, so the
 * offer comes back on the next open. A banner whose only exit is destructive
 * gets clicked by people who meant "go away".
 */
function closeBtn(bar: HTMLElement): HTMLElement {
  const b = btn('✕', 'dxr-x')
  b.title = t('Dismiss — the changes stay in this browser')
  b.setAttribute('aria-label', b.title)
  b.addEventListener('click', () => bar.remove())
  return b
}

function btn(label: string, cls = ''): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = `dx-btn dxr-btn${cls ? ` ${cls}` : ''}`
  b.textContent = label
  return b
}
