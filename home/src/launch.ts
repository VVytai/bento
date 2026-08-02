// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Launching a deck — the one genuinely undecided part of bento/home.
//
// THE PROBLEM. Home holds a writable handle. A `.bento.html` is a complete
// application: the document, the viewer and the editor in one file. To open a
// deck *with silent save*, that file's own code has to run somewhere, and the
// handle has to reach it. Those two requirements pull in opposite directions.
//
// WHY NOT JUST RUN IT HERE. A blob URL inherits the creating page's origin, so
// `window.open(URL.createObjectURL(file))` runs the deck ON HOME'S ORIGIN, with
// full access to home's IndexedDB — which is a store of writable handles to
// every other deck you have opened. A file someone emailed you could then
// rewrite all of them. That is a real escalation over double-clicking it, where
// the file gets an opaque origin and reaches nothing.
//
// This is not a new question here. `docs/DECISIONS.md` (2026-07-24, tray)
// already ruled on the same shape: each document gets its OWN origin
// (`bento-tray://<sha256 of path>`) "because a shared origin would let one
// document read another's localStorage and IndexedDB". Home must not undo that
// ruling in a browser.
//
// THE CANDIDATE MECHANISMS, none of which can be settled from here:
//
//   A. Separate runner origin (e.g. `deck.bento.page`). Home postMessages the
//      handle to a window there. Decks cannot read home's store. UNKNOWN:
//      whether a handle survives a cross-origin postMessage usefully, and
//      whether the receiving origin can `requestPermission` on it (permissions
//      are per-origin, so it likely re-prompts once — acceptable).
//   B. Per-deck origin (`<hash>.deck.bento.page`), matching tray exactly.
//      Strongest isolation; needs wildcard DNS and a certificate.
//   C. `file_handlers` + `launchQueue`, installed-PWA only. The only route that
//      fixes double-click, and a different grant path from the one measured in
//      working/home-design.md §3.1 — so it needs its own test.
//
// ALL THREE ARE PERMISSION-GATED, and permission-gated APIs report `denied` in
// an automated browser without ever prompting (home-design.md §3.2 — that trap
// cost two wrong conclusions already). They must be measured by hand in a real
// browser. `home/probe/` exists for exactly that.
//
// Until one is chosen and measured, this module REFUSES rather than quietly
// taking the unsafe route. A launcher that silently widened the blast radius of
// every deck you open would be worse than one that does not launch yet.

import type { RecentEntry } from './recents.ts'

/**
 * The origin that runs decks. Never home's own.
 *
 * Empty = not yet chosen. Set once mechanism A or B is measured and deployed;
 * `VITE_RUNNER_ORIGIN` lets a dev point at a local one without a code change.
 */
const RUNNER_ORIGIN: string = (import.meta.env?.VITE_RUNNER_ORIGIN as string) ?? ''

export interface LaunchSupport {
  ok: boolean
  why: string
}

/** Whether this build can actually open a deck, and if not, why not. */
export function launchSupport(): LaunchSupport {
  if (!RUNNER_ORIGIN) {
    return {
      ok: false,
      why: 'Opening decks from here is not wired up yet — home can remember them and keep write access, but the runner origin that executes a deck safely has not been chosen. See home/README.md.',
    }
  }
  if (new URL(RUNNER_ORIGIN).origin === location.origin) {
    // Guard, not paperwork: a misconfigured deploy that pointed the runner at
    // home itself would hand every deck the handle store, silently.
    return { ok: false, why: 'Misconfigured: the deck runner must not share an origin with home.' }
  }
  return { ok: true, why: '' }
}

/**
 * Open a deck with its handle attached.
 *
 * `file` is passed in because the caller has already read it — re-reading would
 * be a second permission-sensitive round trip for no reason.
 */
export async function launchDeck(entry: RecentEntry, file: File): Promise<boolean> {
  const support = launchSupport()
  if (!support.ok) {
    // Deliberately not a silent no-op: the user clicked something.
    alert(
      `${entry.title || entry.name} is remembered and still writable — but this build of home cannot open decks yet.\n\n` +
        'Opening a deck means running its code somewhere, and running it on this page would give it access to every file handle home holds. ' +
        'The isolated runner that does it safely is not deployed yet.',
    )
    return false
  }

  // Mechanism A/B: hand the handle to a window on the runner origin. The deck
  // executes there, so it can never read home's store; the handle rides across
  // by structured clone, and the runner re-grants write access with one click.
  const win = window.open(`${RUNNER_ORIGIN}/run/`, '_blank')
  if (!win) {
    alert('Your browser blocked the new window. Allow pop-ups for this page and try again.')
    return false
  }
  await new Promise<void>((resolve) => {
    const onReady = (ev: MessageEvent) => {
      if (ev.origin !== new URL(RUNNER_ORIGIN).origin || ev.data?.type !== 'bento-runner-ready') return
      window.removeEventListener('message', onReady)
      win.postMessage(
        { type: 'bento-open', handle: entry.handle, name: entry.name, bytes: file.size },
        new URL(RUNNER_ORIGIN).origin,
      )
      resolve()
    }
    window.addEventListener('message', onReady)
    // The runner may never answer (blocked, offline, wrong build) — do not
    // leave the listener attached forever waiting for it.
    setTimeout(() => {
      window.removeEventListener('message', onReady)
      resolve()
    }, 8000)
  })
  return true
}
