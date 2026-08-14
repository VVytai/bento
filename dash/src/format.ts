// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Turning a stored value into the string a reader sees.
//
// THE LINE THIS FILE DRAWS, because PLATFORM §8 does not draw it yet:
//
//   The number FORMAT is DOCUMENT data — the author chose two decimal places
//   and a pound sign, and everyone who opens the file must see the same thing,
//   or two people reading one board disagree about what it says.
//
//   The GROUPING and DECIMAL GLYPHS are VIEWER chrome, the same rule locale
//   already follows everywhere else in Bento. A German reader of a British
//   author's workbook should see 1.234,50 for the value the author formatted
//   as #,##0.00 — same number, same precision, their own separators.
//
// So the format string says WHAT to show and the viewer's locale says HOW to
// punctuate it. Getting this backwards either freezes one reader's separators
// into everyone else's file, or lets the author's chosen precision drift.

import type { Column, ColumnType } from './model.ts'
import { locale } from './i18n.ts'

/**
 * Viewer-scoped, never in the document.
 *
 * PULLED, not pushed. This used to be a module variable somebody had to
 * remember to set, and nobody ever did: it stayed `undefined` for the life of
 * the app, `Intl` fell through to the browser, and choosing French in About
 * gave French chrome above English-punctuated numbers. Pushing it from the
 * language picker would have fixed that one call site and left the next one —
 * `window.bento.i18n.setLocale` reaches the kernel directly and never passes
 * through the app's facade at all. Asking at format time cannot go out of step
 * with the answer.
 *
 * The override survives for tests, which need a locale without a global.
 */
let viewerLocale: string | undefined

export const setViewerLocale = (l: string | undefined): void => { viewerLocale = l }

const forNumbers = (): string | undefined => viewerLocale ?? locale()

/**
 * Read the digit shape out of an Excel-style pattern. We support the part
 * people actually write — a currency prefix, thousands grouping, and a fixed
 * number of decimals — and ignore the rest rather than pretending.
 */
function readPattern(fmt: string | undefined): {
  prefix: string; suffix: string; group: boolean; dp: number | null; pct: boolean
} {
  if (!fmt) return { prefix: '', suffix: '', group: false, dp: null, pct: false }
  const pct = fmt.includes('%')
  const body = fmt.replace('%', '')
  const m = body.match(/[#0][#0,]*(?:\.0+)?/)
  const digits = m?.[0] ?? ''
  const at = m ? body.indexOf(digits) : -1
  const dot = digits.indexOf('.')
  return {
    prefix: at >= 0 ? body.slice(0, at) : '',
    suffix: at >= 0 ? body.slice(at + digits.length) : '',
    group: digits.includes(','),
    // `null` means "decide from the value" (0 for an integer, 2 otherwise) and
    // is right ONLY when the pattern says nothing about digits at all. A
    // pattern with digits and no decimal point says something very definite —
    // NO decimals — and answering `null` there made "#,##0" print 1,234.50 and
    // "0" print 7.60. Formatting a column as a whole number has never worked on
    // either kind of sheet; Excel rounds, and so do we now.
    dp: dot >= 0 ? digits.length - dot - 1 : (digits ? 0 : null),
    pct,
  }
}

/** Format one value for display. Never mutates, never throws. */
export function formatValue(v: unknown, col: Pick<Column, 'type' | 'format'>): string {
  if (v == null || v === '') return ''
  const t: ColumnType = col.type
  if (t === 'bool') return v ? '✓' : ''
  if (t === 'date') return String(v)
  if (t === 'text' || t === 'enum') return String(v)

  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return String(v)

  const p = readPattern(col.format)
  const isPct = p.pct || t === 'percent'
  const shown = isPct ? n * 100 : n
  const dp = p.dp ?? (t === 'money' ? 2 : isPct ? 0 : shown % 1 === 0 ? 0 : 2)

  // Intl does the punctuation, so the VIEWER's separators apply to the
  // AUTHOR's precision — the split this file exists to make.
  const body = new Intl.NumberFormat(forNumbers(), {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
    useGrouping: p.group || (!col.format && (t === 'money' || Math.abs(shown) >= 10_000)),
  }).format(shown)

  return `${p.prefix}${body}${p.suffix}${isPct && !p.suffix ? '%' : ''}`
}

/** Right-align anything that is a quantity; left-align anything that is a word. */
export const alignFor = (t: ColumnType): 'left' | 'right' =>
  t === 'number' || t === 'money' || t === 'percent' ? 'right' : 'left'

export const TYPE_LABEL: Record<ColumnType, string> = {
  text: 'Text', number: 'Number', money: 'Money',
  percent: 'Percent', date: 'Date', bool: 'Yes/No', enum: 'Category',
}
