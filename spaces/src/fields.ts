// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Typed fields: the schema, the defaults, and reading a page's values.
//
// AN ISSUE IS A PAGE. Its fields are `prop` BLOCKS on that page; the schema
// they draw on is `doc.fields`. docs/DECISIONS.md (2026-08-05) carries the
// reasoning; the parts that matter when reading this file:
//
//  · VALUES ARE BLOCKS because everything in spaces that matters iterates
//    `page.blocks` — search, find-and-replace, undo, the block registry, the
//    static preview, markdown export. A page-level key is invisible to all of
//    them and renders as nothing on a build that predates it. And under
//    collaboration each block property is its own last-writer-wins register, so
//    two people setting status and assignee at the same moment both win; one
//    object on the page would have been ONE register and would have lost an
//    edit silently.
//
//  · THE SCHEMA IS NOT A VALUE. Putting the status list on every issue would
//    copy it into every page and let two pages disagree about what "Todo"
//    means. It is document-level, and additive: a build that predates it
//    ignores `doc.fields` and still renders each prop block's `html`.
//
//  · EVERY PROP BLOCK CARRIES A READABLE `html`. That is what makes the format
//    degrade instead of vanish — an older build, a thumbnailer, a grep and a
//    markdown export all see "Status: In progress" without knowing what a field
//    is. Keeping it in step with `value` is this file's job.

import type { SpacesDoc, Page, Block } from './model'

/** What a field holds. Deliberately few: every one costs an editor and a
 *  permanent commitment, and a tracker needs exactly these. */
export type FieldType = 'select' | 'person' | 'number' | 'date' | 'text' | 'labels'

export interface FieldOption {
  id: string
  label: string
  color?: string
  /**
   * Which end of the board this sits at.
   *
   * Linear's insight, and the reason a board is useful rather than pretty: a
   * status is not just a name, it belongs to a PHASE. "Done" and "Cancelled"
   * are both finished; "In review" and "In progress" are both started. Grouping
   * by phase is what lets "show me what is open" mean something without anyone
   * configuring a filter.
   */
  group?: 'unstarted' | 'started' | 'done' | 'cancelled'
}

export interface FieldSpec {
  key: string
  label: string
  vt: FieldType
  options?: FieldOption[]
  /** shown on a new issue when nothing is chosen */
  def?: string
}

/**
 * The fields a fresh tracker starts with.
 *
 * Linear-shaped on purpose: Status, Assignee, Priority, Estimate, Labels,
 * Cycle, Project. Opinionated beats configurable here — a tracker you have to
 * design before you can use it is the thing everybody hates about the
 * alternatives, and every one of these is permanent, so the list is short.
 */
export const DEFAULT_FIELDS: FieldSpec[] = [
  {
    key: 'status', label: 'Status', vt: 'select', def: 'todo',
    options: [
      { id: 'backlog', label: 'Backlog', color: '#8B95A5', group: 'unstarted' },
      { id: 'todo', label: 'Todo', color: '#5B8DEF', group: 'unstarted' },
      { id: 'doing', label: 'In progress', color: '#F7A600', group: 'started' },
      { id: 'review', label: 'In review', color: '#A97BE0', group: 'started' },
      { id: 'done', label: 'Done', color: '#2FA37C', group: 'done' },
      { id: 'cancelled', label: 'Cancelled', color: '#98A2B3', group: 'cancelled' },
    ],
  },
  {
    key: 'priority', label: 'Priority', vt: 'select', def: 'none',
    options: [
      { id: 'urgent', label: 'Urgent', color: '#E5484D' },
      { id: 'high', label: 'High', color: '#F7A600' },
      { id: 'medium', label: 'Medium', color: '#5B8DEF' },
      { id: 'low', label: 'Low', color: '#8B95A5' },
      { id: 'none', label: 'No priority', color: '#C4CBD6' },
    ],
  },
  { key: 'assignee', label: 'Assignee', vt: 'person' },
  { key: 'estimate', label: 'Estimate', vt: 'number' },
  { key: 'labels', label: 'Labels', vt: 'labels' },
  { key: 'due', label: 'Due', vt: 'date' },
  { key: 'project', label: 'Project', vt: 'text' },
]

/**
 * The fields a NEW issue starts with.
 *
 * ONE list, because there are now two ways to make an issue — ⌘⇧I in the
 * editor and `bento.newIssue()` from an agent — and a field seeded by one but
 * not the other is a field a human then cannot set: `prop` is unlisted in the
 * / menu (blocks.ts), so the only way a value gets onto a page is that the page
 * was seeded with it. An agent-made issue missing `assignee` would be an issue
 * nobody can assign without hand-editing the JSON.
 *
 * The rest of the schema (labels, due, project) is set on demand and appears
 * when it is set — absent means unset, which is what the format already says.
 */
export const ISSUE_FIELDS = ['status', 'priority', 'assignee', 'estimate']

/** The schema in force: what the document declares, else the defaults. */
export function fieldsOf(doc: SpacesDoc): FieldSpec[] {
  const declared = (doc as { fields?: unknown }).fields
  return Array.isArray(declared) && declared.length ? (declared as FieldSpec[]) : DEFAULT_FIELDS
}

export const fieldByKey = (doc: SpacesDoc, key: string): FieldSpec | undefined =>
  fieldsOf(doc).find((f) => f.key === key)

export const optionOf = (f: FieldSpec | undefined, id: unknown): FieldOption | undefined =>
  f?.options?.find((o) => o.id === String(id))

/**
 * The readable form of a value — what goes in the block's `html`.
 *
 * Not decoration. This is the only thing an older build, a thumbnailer, a grep
 * or a markdown export can see, so it has to say what the field is as well as
 * what it holds.
 */
export function propHtml(f: FieldSpec, value: unknown): string {
  // COERCE, never assume. The schema comes out of a file someone sent you, so
  // `label` can be absent or a number — and this used to throw a TypeError
  // straight out of the public API (setField and newIssue), on exactly the
  // untrusted-file class the rest of the code is hardened against. A malformed
  // schema entry is something validate() reports; it is not something a write
  // verb should crash on. Falling back to the KEY keeps the readable form
  // readable, which is the whole job.
  const esc = (v: unknown) =>
    String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const label = typeof f?.label === 'string' && f.label ? f.label : String(f?.key ?? 'field')
  const shown =
    f.vt === 'select' ? (optionOf(f, value)?.label ?? String(value ?? ''))
      : f.vt === 'labels' ? (Array.isArray(value) ? value.join(', ') : String(value ?? ''))
        : String(value ?? '')
  return `${esc(label)}: ${esc(shown) || '—'}`
}

/** A page's field values, by key. Only `prop` blocks carry them. */
export function valuesOf(page: Page): Map<string, unknown> {
  const out = new Map<string, unknown>()
  for (const b of page.blocks) {
    if (b.type !== 'prop') continue
    const key = (b as { key?: unknown }).key
    if (typeof key === 'string' && key) out.set(key, (b as { value?: unknown }).value)
  }
  return out
}

/**
 * Is this page an ISSUE?
 *
 * It carries a status. Not a flag on the page and not a separate page type:
 * making "issue" a mode would mean a page could be the wrong kind, and would
 * put a second concept in a format whose whole shape is "a page with blocks".
 * A page with a status is an issue; remove the status and it is a document
 * again, with everything else about it intact.
 */
export const isIssue = (page: Page): boolean =>
  page.blocks.some((b) => b.type === 'prop' && (b as { key?: unknown }).key === 'status')

/** Where a page's prop blocks stop and its body begins. */
export function headerLength(page: Page): number {
  let n = 0
  while (n < page.blocks.length && page.blocks[n].type === 'prop') n++
  return n
}

/**
 * What NARROWS a view. Stored on the `view` block, so it is permanent.
 *
 * ABSENT MEANS EVERYTHING, and so does an absent key inside it. That is not a
 * default, it is the compatibility rule: every view block written before
 * filters existed carries no `filter`, and must keep showing every issue
 * forever. The same rule makes the editor DELETE the key rather than store an
 * empty object, so a view someone filtered and then unfiltered is byte-identical
 * to one that was never filtered.
 *
 * Deliberately two keys. A filter language is a thing that grows without limit
 * and can never shrink — every operator here is in files on other people's
 * disks the moment it ships — so this is the smallest pair that answers the two
 * questions a tracker is actually asked: "show me this label" and "show me what
 * is still open".
 */
export interface ViewFilter {
  /**
   * field key → the values that pass. A value THIS BUILD DOES NOT KNOW is
   * compared literally, so a filter written by a newer build still selects the
   * issues it meant instead of matching nothing.
   */
  is?: Record<string, string[]>
  /** only issues whose phase is neither done nor cancelled */
  open?: boolean
}

/** Filter keys this build can evaluate. */
const FILTER_KEYS = new Set(['is', 'open'])

/**
 * Filter keys from a NEWER build.
 *
 * They round-trip untouched, but this build cannot apply them, so the view
 * shows MORE than it should — and a count that is silently too high is exactly
 * the failure the format's additivity rule trades for. The view says so out
 * loud instead.
 */
export const unknownFilterKeys = (f: unknown): string[] =>
  f && typeof f === 'object' ? Object.keys(f).filter((k) => !FILTER_KEYS.has(k)) : []

/**
 * The field whose options declare PHASES — the one "open" is a question about.
 *
 * DERIVED FROM THE SCHEMA, never hardcoded to `status`: a document that
 * declares its own fields names its own phase field, and one that declares none
 * has no notion of open at all, in which case `open` passes everything rather
 * than emptying the board.
 */
export const phaseField = (doc: SpacesDoc): FieldSpec | undefined =>
  fieldsOf(doc).find((f) => f.options?.some((o) => o.group))

/**
 * Is this value a phase that is still going?
 *
 * An UNKNOWN value counts as open. A newer build's status must never be hidden
 * by "open only" — hiding work because this build cannot read its status is a
 * silent loss, and showing one issue too many is not.
 */
export const isOpenPhase = (f: FieldSpec | undefined, value: unknown): boolean => {
  const g = optionOf(f, value)?.group
  return g !== 'done' && g !== 'cancelled'
}

/** Does one issue pass a view's filter? */
export function passesFilter(doc: SpacesDoc, values: Map<string, unknown>, filter: unknown): boolean {
  if (!filter || typeof filter !== 'object') return true
  const f = filter as ViewFilter
  if (f.open) {
    const pf = phaseField(doc)
    if (!isOpenPhase(pf, values.get(pf?.key ?? ''))) return false
  }
  const is = f.is
  if (is && typeof is === 'object') {
    for (const key of Object.keys(is)) {
      const want = is[key]
      // an empty list is NO CONSTRAINT, not "nothing passes" — a stored empty
      // would empty the board for a reason nobody could see
      if (!Array.isArray(want) || !want.length) continue
      const v = values.get(key)
      const mine = Array.isArray(v) ? v.map(String) : [String(v ?? '')]
      if (!want.some((w) => mine.includes(String(w)))) return false
    }
  }
  return true
}

/** How many things a filter narrows by — what the Filter button counts. */
export const filterCount = (filter: unknown): number => {
  const f = (filter ?? {}) as ViewFilter
  const is = f.is && typeof f.is === 'object' ? f.is : {}
  return (f.open ? 1 : 0) + Object.keys(is).filter((k) => (is[k] ?? []).length).length
}

export interface IssueRow {
  page: Page
  values: Map<string, unknown>
}

/** Every issue in the space, in page order, archived pages excluded. */
export function issuesOf(doc: SpacesDoc): IssueRow[] {
  const out: IssueRow[] = []
  for (const page of doc.pages) {
    if (page.archived || !isIssue(page)) continue
    out.push({ page, values: valuesOf(page) })
  }
  return out
}

/** Where a dropped card lands: before a card, or after the last one. */
export interface DropAim { before?: string; after?: string }

/**
 * The page order after a card is dropped — or NULL when the drop changes
 * nothing.
 *
 * THE BOARD'S ORDER IS `doc.pages`. There is no per-view order field, and there
 * must not be one invented by a drag handler: a stored order is permanent, it
 * has to answer what happens to an issue no view has ever seen, and it can
 * disagree with the pages themselves. Reordering the pages cannot.
 *
 * Pure, and separate from the editor, because this is the arithmetic that is
 * easy to get wrong: the anchor is a page ID rather than an index precisely
 * because the index moves under the splice that removes the dragged page. The
 * null return is what keeps a drag that went nowhere out of the undo stack.
 */
export function reorderPages(pages: Page[], pageId: string, aim: DropAim): Page[] | null {
  const from = pages.findIndex((p) => p.id === pageId)
  const anchor = aim.before ?? aim.after
  if (from < 0 || !anchor) return null
  // already exactly there
  if (aim.before ? pages[from + 1]?.id === aim.before : pages[from - 1]?.id === aim.after) return null
  const next = pages.slice()
  const [moved] = next.splice(from, 1)
  // The anchor is looked up AFTER the removal, so the index is the one the
  // insert needs. It also covers dropping a card on itself: the anchor is the
  // page just removed, so it is not found and nothing moves.
  const at = next.findIndex((p) => p.id === anchor)
  if (at < 0) return null
  next.splice(aim.before ? at : at + 1, 0, moved)
  return next
}

/** One page's value block for a field, if it has one. */
export const propBlockOf = (page: Page, key: string): Block | undefined =>
  page.blocks.find((b) => b.type === 'prop' && (b as { key?: unknown }).key === key)

/** Build a prop block, with its readable form already in step. */
export function propBlock(f: FieldSpec, value: unknown, id: string): Block {
  return { id, type: 'prop', key: f.key, value, html: propHtml(f, value) } as Block
}

/**
 * Would this drop change the order the user can actually SEE?
 *
 * `reorderPages` compares adjacency in `doc.pages`, and page order is not
 * column order: a board with two columns interleaves them, so a card dropped
 * back into its own slot is NOT adjacent to itself in the page array. Measured:
 * pages [board,i1,i2,i3,i4,i5] with i1,i3,i5 in one column — dropping i1 where
 * it already sat returned a reordered array, so a gesture that visibly did
 * nothing wrote to the document, took an undo entry, set the dirty flag, and
 * visibly reshuffled the SIDEBAR, because board order is sidebar order.
 *
 * The rig missed it because its fixture had one column, which is the only
 * shape where the two orders coincide.
 *
 * `cards` is the column's card ids in the order they are drawn, INCLUDING the
 * dragged one. The answer is about the column, because the column is the only
 * order the gesture was about.
 */
export function columnMoves(cards: string[], moved: string, aim: DropAim): boolean {
  const at = cards.indexOf(moved)
  if (at < 0) return true                       // it is arriving from elsewhere
  const rest = cards.filter((id) => id !== moved)
  const target = aim.before
    ? rest.indexOf(aim.before)
    : aim.after ? rest.indexOf(aim.after) + 1 : rest.length
  if (target < 0) return true
  const next = [...rest.slice(0, target), moved, ...rest.slice(target)]
  return next.join('\u001f') !== cards.join('\u001f')
}
