// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The page-world half of the bridge. Runs in the DOCUMENT's world (MAIN), at
// document_start, so it is in place before the deck's own runtime boots.
//
// WHAT IT OVERRIDES AND WHY. `kernel/src/save.ts` tests exactly one thing —
// `typeof window.showSaveFilePicker === 'function'` — and needs only:
//
//     showSaveFilePicker({suggestedName}) -> { name, createWritable() }
//     createWritable() -> { write(Blob|string), close() }
//
// That is tray's contract (tray/README.md), and it is why no web-side change is
// needed: every in-place path (⌘S, autosave write-back, self-update) already
// routes through that function, including in decks whose embedded runtime
// predates this extension.
//
// The wrinkle unique to a browser host: on `file://` in Chrome that function
// ALREADY EXISTS. So unlike tray on iOS, where the polyfill fills a gap, here it
// REPLACES a working API that prompts for a destination. The override therefore
// has to be conservative — see `wantsOpenFile` below. Anything it does not
// recognise falls through to the native picker, which still works exactly as it
// did.

;(() => {
  const native = window.showSaveFilePicker?.bind(window)
  const CH = '__bento_tray__'
  let seq = 0
  const pending = new Map()

  /** One round trip to the isolated world, which relays to the extension. */
  const ask = (op, payload) =>
    new Promise((resolve) => {
      const id = `${Date.now()}-${seq++}`
      pending.set(id, resolve)
      window.postMessage({ [CH]: true, dir: 'req', id, op, payload }, '*')
      // A host that never answers must not hang a save forever — the caller
      // falls back to the native picker instead.
      setTimeout(() => {
        if (pending.delete(id)) resolve({ ok: false, reason: 'timeout' })
      }, 5000)
    })

  window.addEventListener('message', (ev) => {
    const d = ev.data
    if (ev.source !== window || !d || d[CH] !== true || d.dir !== 'res') return
    const resolve = pending.get(d.id)
    if (resolve) { pending.delete(d.id); resolve(d.result) }
  })

  /**
   * Is this save aimed at the file we are already looking at?
   *
   * The deck asks to save under a suggested name. When that name is the file on
   * screen, the author means "save my work" and the host can write in place.
   * When it differs — "Save a copy…", a template, a read-only export, an invite
   * — they mean a NEW file somewhere they choose, and taking that over silently
   * would write to a place nobody asked for. Those go to the native picker.
   */
  const wantsOpenFile = (suggestedName) => {
    // DISABLED — this cannot be decided from here, and getting it wrong
    // destroys a file. MEASURED 2026-08-02: "Save a copy…" overwrote the open
    // deck, because `saveFile(doc, forcePicker)` reaches the SAME call for both
    // intents:
    //
    //     plain ⌘S       → this.save(false) → saveFile(doc, false) → pickHandle(doc)
    //     Save a copy…   → this.save(true)  → saveFile(doc, true)  → pickHandle(doc)
    //
    // Same suggestedName, same id, same options. The arguments carry no signal,
    // so no heuristic here can tell "save my work" from "save me a second
    // copy" — and the failure is silent and unrecoverable: no dialog, no
    // warning, the original gone.
    //
    // Re-enable only once save.ts makes the intent explicit (a distinct picker
    // `id`, or an equivalent hint). Until then every save falls through to the
    // native picker, which is exactly what happens with the extension
    // uninstalled — no worse, and nothing lost.
    void suggestedName
    return false
  }

  window.showSaveFilePicker = async (opts = {}) => {
    const suggestedName = opts.suggestedName
    if (!wantsOpenFile(suggestedName)) {
      if (native) return native(opts)
      throw new DOMException('No file picker available', 'AbortError')
    }
    const claim = await ask('claim', { path: decodeURIComponent(location.pathname) })
    if (!claim?.ok) {
      // The extension cannot reach this file — no folder granted, or the deck
      // lives outside it. The native picker is not a worse outcome, it is
      // exactly what happens without the extension installed.
      if (native) return native(opts)
      throw new DOMException('No writable location', 'AbortError')
    }
    return {
      name: claim.name,
      kind: 'file',
      createWritable: async () => {
        const chunks = []
        return {
          async write(data) { chunks.push(data) },
          async close() {
            const blob = chunks.length === 1 && chunks[0] instanceof Blob
              ? chunks[0]
              : new Blob(chunks)
            const text = await blob.text()
            const res = await ask('write', { token: claim.token, text })
            if (!res?.ok) throw new DOMException(res?.reason || 'write failed', 'NotAllowedError')
          },
        }
      },
      // save.ts re-queries permission on a retained handle; a host-backed handle
      // is granted for as long as the folder grant stands.
      queryPermission: async () => 'granted',
      requestPermission: async () => 'granted',
      isSameEntry: async () => false,
    }
  }
})()
