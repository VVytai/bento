#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The shell-size ceiling, enforced.
//
//   node scripts/test-spaces-size.mjs [--update]
//
// WHY THIS EXISTS. docs/DECISIONS.md set a 100KB ceiling for bento/spaces and
// the round finished at 108KB. That is not the failure — features were worth
// their bytes and the ceiling was raised deliberately. The failure is that the
// same entry said "the ceiling is checked per feature from here" and shipped NO
// MECHANISM, so the breach was found by a reviewer reading the number, weeks of
// features later, rather than by the build that caused it.
//
// A budget nobody measures is a wish. This measures it.
//
// It is a CEILING, not a target: a feature that needs bytes takes them and
// raises the number here in the same commit, which is a two-line diff a
// reviewer can see and argue with. What it stops is the drift nobody chose —
// forty commits each costing 300 bytes.
//
// THE NUMBER IS ENVIRONMENT-SENSITIVE, and CI's is the one that counts.
// Most of the shell is a zlib-deflated block, and zlib's output differs
// slightly between node versions: measured on one commit, node 26 locally
// produced 130,095 B where CI's node 24 produced 131,246 B — 1.1 KB apart for
// identical input. So a ceiling set tight against a local build fails in CI for
// reasons that have nothing to do with the change. Leave a few KB of headroom,
// and when the two disagree, believe CI.
//
// Spaces ships in ONE file that people mail to each other, and every byte is
// paid on every open, on every phone, forever. Slides is 560KB because it grew
// for a year without one of these.

import { readFileSync, writeFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const BUDGETS = join(root, 'scripts/size-budgets.json')

const budgets = JSON.parse(readFileSync(BUDGETS, 'utf8'))
const update = process.argv.includes('--update')

let failures = 0
for (const [name, b] of Object.entries(budgets.shells)) {
  const path = join(root, b.path)
  let bytes
  try { bytes = statSync(path).size } catch {
    console.log(`  skip  ${name} — not built (${b.path})`)
    continue
  }
  const pct = ((bytes / b.max) * 100).toFixed(1)
  const head = `${name.padEnd(8)} ${String(bytes).padStart(7)} B  of ${b.max} B  (${pct}%)`

  if (update) {
    b.max = bytes
    console.log(`  set   ${head} → new ceiling`)
    continue
  }
  if (bytes > b.max) {
    failures++
    console.log(`  FAIL  ${head}`)
    console.log(`        over by ${bytes - b.max} B. Either give the bytes back, or raise`)
    console.log(`        "${name}".max in scripts/size-budgets.json IN THIS COMMIT and say`)
    console.log(`        in the message what bought them. Do not raise it silently.`)
  } else {
    console.log(`  ok    ${head}`)
  }
}

if (update) {
  writeFileSync(BUDGETS, `${JSON.stringify(budgets, null, 2)}\n`)
  console.log('\nbudgets rewritten to the current sizes')
  process.exit(0)
}

console.log(failures ? `\n${failures} shell(s) over budget` : '\nall shells within budget')
process.exit(failures ? 1 : 0)
