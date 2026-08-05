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
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const shown =
    f.vt === 'select' ? (optionOf(f, value)?.label ?? String(value ?? ''))
      : f.vt === 'labels' ? (Array.isArray(value) ? value.join(', ') : String(value ?? ''))
        : String(value ?? '')
  return `${esc(f.label)}: ${esc(shown) || '—'}`
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

/** Build a prop block, with its readable form already in step. */
export function propBlock(f: FieldSpec, value: unknown, id: string): Block {
  return { id, type: 'prop', key: f.key, value, html: propHtml(f, value) } as Block
}
