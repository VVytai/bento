// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The block-type registry: ONE declaration per type.
//
// Adding a block type used to mean editing four files in five places — the
// renderer's tag map and list map, the / menu, the markdown-autoformat table,
// and the markdown exporter — with nothing connecting them. A type added to
// four of the five looked finished and silently exported as a bare paragraph.
//
// Now each type is one entry here and every consumer derives from it. That is
// worth stating as a rule rather than a convenience: several people (and
// several agents) add block types in parallel, and a registry turns four
// simultaneous edits to the same hot files into four independent entries.
//
// PURE DATA — no DOM, no imports from render.ts or editor.ts. That keeps the
// dependency arrow one-way (consumers import the registry, never the reverse)
// and lets a node test read it directly.
//
// Types with genuinely custom layout (image, todo, toggle, pagelink, code,
// divider) still have their rendering in render.ts and say so with
// `custom: true`; everything the registry can express lives here.

import type { Block } from './model'
import type { IconName } from './icons'

export interface BlockSpec {
  type: string
  /**
   * Menu label and hint, in ENGLISH.
   *
   * Not translated here: t() at module scope freezes the string at import,
   * before the reader's locale is known (CLAUDE.md). English IS the key, so
   * consumers call t(spec.label) at render time.
   */
  label: string
  hint: string
  icon: IconName
  /**
   * Markdown prefixes that turn the block being typed into this type.
   *
   * A LIST, because the real ones have aliases: `- ` and `* ` both start a
   * bullet, `[] ` and `[ ] ` both start a to-do. Collapsing those to one
   * pattern each would quietly drop half the triggers people already use.
   */
  md?: RegExp[]
  /** Fields a fresh block of this type needs beyond id/type. */
  init?: (b: Block) => void
  /** Semantic element, when the default renderer (tag + inline text) applies. */
  tag?: string
  /** Adjacent siblings of the same kind share one list element. */
  list?: 'ul' | 'ol'
  /** Rendered by a dedicated case in render.ts, not by tag + inline host. */
  custom?: boolean
  /** Carries editable inline html. False for divider, image, pagelink. */
  text?: boolean
  /** Hidden from the / menu (a type reachable only another way). */
  unlisted?: boolean
  /**
   * Markdown export. `text` is the block's inline html already converted to
   * inline markdown; `indent` is set for a nested block. Absent = the text
   * alone, which is also what an UNKNOWN type gets.
   */
  toMd?: (b: Block, text: string, indent: string, titleOf: (id: string) => string | undefined) => string[]
}

export const SPECS: BlockSpec[] = [
  {
    type: 'p', label: 'Text', hint: 'Plain paragraph', icon: 'text',
    tag: 'p', text: true,
  },
  {
    type: 'h1', label: 'Heading 1', hint: '#', icon: 'h1',
    tag: 'h1', text: true, md: [/^# $/],
    toMd: (_b, text) => [`# ${text}`],
  },
  {
    type: 'h2', label: 'Heading 2', hint: '##', icon: 'h2',
    tag: 'h2', text: true, md: [/^## $/],
    toMd: (_b, text) => [`## ${text}`],
  },
  {
    type: 'h3', label: 'Heading 3', hint: '###', icon: 'h3',
    tag: 'h3', text: true, md: [/^### $/],
    toMd: (_b, text) => [`### ${text}`],
  },
  {
    type: 'bullet', label: 'Bulleted list', hint: '-', icon: 'bullet',
    tag: 'li', list: 'ul', text: true, md: [/^- $/, /^\* $/],
    toMd: (_b, text, indent) => [`${indent}- ${text}`],
  },
  {
    type: 'number', label: 'Numbered list', hint: '1.', icon: 'number',
    tag: 'li', list: 'ol', text: true, md: [/^1\. $/],
    toMd: (_b, text, indent) => [`${indent}1. ${text}`],
  },
  {
    type: 'todo', label: 'To-do', hint: '[]', icon: 'todo',
    tag: 'li', list: 'ul', text: true, custom: true,
    md: [/^\[\] $/, /^\[ \] $/], init: (b) => { b.done = false },
    toMd: (b, text, indent) => [`${indent}- [${b.done ? 'x' : ' '}] ${text}`],
  },
  {
    type: 'toggle', label: 'Toggle', hint: 'Collapsible section', icon: 'toggle',
    tag: 'div', text: true, custom: true,
    toMd: (_b, text, indent) => [`${indent}- ${text}`],
  },
  {
    type: 'quote', label: 'Quote', hint: '>', icon: 'quote',
    tag: 'blockquote', text: true, md: [/^> $/],
    toMd: (_b, text) => [`> ${text}`],
  },
  {
    type: 'code', label: 'Code', hint: '```', icon: 'code',
    tag: 'div', text: true, custom: true, md: [/^```$/],
    toMd: (b, text) => ['```' + String(b.lang ?? ''), text, '```'],
  },
  {
    type: 'divider', label: 'Divider', hint: '---', icon: 'divider',
    tag: 'div', custom: true, md: [/^--- $/],
    toMd: () => ['---'],
  },
  {
    type: 'pagelink', label: 'Link to page', hint: 'A card that opens a page', icon: 'link',
    tag: 'div', custom: true,
    toMd: (b, _text, _indent, titleOf) => [`→ [[${titleOf(String(b.page)) ?? '?'}]]`],
  },
  {
    type: 'image', label: 'Image', hint: 'Embedded in the file', icon: 'image',
    tag: 'div', custom: true,
    toMd: (b) => [`![${String(b.alt ?? '')}](${String(b.src ?? '')})`],
  },
]

/** Lookup by type. An UNKNOWN type returns undefined and must still render — a
 *  file written by a newer build opens here, and it opens as text. */
export const SPEC: ReadonlyMap<string, BlockSpec> = new Map(SPECS.map((s) => [s.type, s]))

/** The / menu and the Insert dropdown, in declaration order. */
export const MENU_SPECS = SPECS.filter((s) => !s.unlisted)

/** Markdown autoformat rules, derived so a type cannot have a menu entry and
 *  no trigger by accident — or a trigger nobody can find in a menu. */
export const MD_SPECS: Array<[RegExp, string, (b: Block) => void]> =
  SPECS.flatMap((s) => (s.md ?? []).map((re) => [re, s.type, s.init ?? (() => {})] as [RegExp, string, (b: Block) => void]))

/**
 * `type -> semantic element`, for EVERY type.
 *
 * `custom` says the renderer fills the element itself; it does not change what
 * the element IS. `todo` is both custom and an `li` — filtering custom types
 * out of this map would silently move to-do items out of their list.
 */
export const TAG_OF: Record<string, string> =
  Object.fromEntries(SPECS.filter((s) => s.tag).map((s) => [s.type, s.tag!]))

/** Types whose adjacent siblings share one <ul>/<ol>. */
export const LIST_OF: Record<string, 'ul' | 'ol'> =
  Object.fromEntries(SPECS.filter((s) => s.list).map((s) => [s.type, s.list!]))
