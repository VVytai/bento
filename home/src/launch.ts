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
// A SINGLE SHARED RUNNER ORIGIN DOES NOT FIX IT (considered, rejected —
// docs/DECISIONS.md 2026-08-02). It stops documents reading home's handles, but
// they would then share an origin with EACH OTHER, and a Bento document
// persists `bento-autosave` (recovery = plaintext doc JSON keyed by docId, plus
// a versions timeline) and `localStorage` `bento-member-<docId>` (the device's
// collab member private key). One runner origin pools all of that — content,
// history and collab keys for every document ever opened through it — into a
// store any one of them can read. That pool does not exist today.
//
// `file_handlers` + `launchQueue` is not the answer either: it delivers a
// double-clicked file to the INSTALLED PWA, i.e. home's own origin. It answers
// "how does the OS reach us", not "where does the document execute" — an
// acquisition route, not isolation. It composes with per-document origins.
//
// RULED: per-document origin (`<hash>-run.bento.page`), derived from the
// document's identity — the same shape tray reached independently. Home may
// acquire a handle any way it can and must hand off to that origin.
//
// `run`, not an app name: this code never parses the format, so the origin
// serves slides, spaces and sheets alike. The precedent is `sync.bento.page` —
// a subdomain marks a trust boundary, not a product.
//
// STILL TO MEASURE, and not measurable from here: whether a handle survives a
// cross-origin postMessage and stays usable (a re-prompt on the receiving
// origin is expected and fine; being unusable would sink this shape).
// Permission-gated APIs report `denied` in an automated browser without ever
// prompting (working/home-design.md §3.2 — that trap cost two wrong conclusions
// already), so it has to be done by hand in a real browser.
//
// Until the runner exists and that is measured, this module REFUSES rather than
// quietly taking the unsafe route. A launcher that silently widened the blast
// radius of every deck you open is worse than one that does not launch yet.

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
