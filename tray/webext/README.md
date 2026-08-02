# bento/tray — WebExtension

A browser host for Bento documents. Grant your decks folder once; after that a
deck you opened by **double-clicking** saves back to its own file with no
destination prompt.

Status: **scaffold — loadable, not yet driven end to end.** See "What is
unverified" before trusting any of it.

## Why an extension and not a web page

`bento/home` was going to do this as an ordinary page. It cannot, and three
measurements in `docs/DECISIONS.md` (2026-08-02) say why:

- A `FileSystemFileHandle` **cannot be delegated across origins** — `postMessage`
  serialises it and the receiver fires `messageerror`. So the origin that
  acquires a handle is the only origin that can use it, and a launcher can never
  hand one to a document.
- Running every document on one shared origin would pool `bento-autosave`
  (plaintext doc JSON, version history) and `bento-member-<docId>` (collab
  private keys) into a store any document could read.
- A **directory** grant behaves differently, and that is the unlock: it survives
  a reload and covers files inside it that were never picked.

An extension changes the shape completely. The document stays on `file://`,
which the browser treats as a unique origin per file — so per-document isolation
is free, and no deck can read another's storage. The extension holds the folder
grant and does the writing.

## The contract is tray's, unchanged

`kernel/src/save.ts` tests one thing — `typeof window.showSaveFilePicker ===
'function'` — and needs only:

```
showSaveFilePicker({suggestedName}) -> { name, createWritable() }
createWritable() -> { write(Blob|string), close() }
```

Same three methods `tray/ios` implements over a `UIDocument` bridge. **No
web-side changes**, and every deck ever saved works, including files whose
embedded runtime predates this extension.

One wrinkle that does not exist on iOS: on `file://` in Chrome,
`showSaveFilePicker` **already exists**. So here the bridge REPLACES a working
API rather than filling a gap, and it is deliberately conservative — it only
takes over when the suggested name is the file already on screen. "Save a
copy…", templates, read-only exports and invites all mean *a new file somewhere
you choose*, so they fall through to the native picker untouched.

## Shape

| file | world | job |
|---|---|---|
| `src/page-bridge.js` | MAIN | overrides `showSaveFilePicker`; decides in-place vs native |
| `src/relay.js` | ISOLATED | pure relay, no logic — the two worlds cannot reach each other |
| `src/background.js` | service worker | holds the grant; matches the file; writes |
| `src/options.html/js` | extension page | where the folder is granted (needs a gesture) |

Both content-script halves are required: an isolated world can talk to the
extension but not touch page globals; a MAIN world can define
`showSaveFilePicker` but has no extension APIs.

## The matching problem

A page gives us `/Users/…/Decks/Q3.bento.html`. A `FileSystemDirectoryHandle`
knows its own **name** but not its path, and nothing in the API exposes one — so
the two cannot be compared directly.

`findByName` searches the granted tree (depth-limited) and requires **exactly one
match**. Unambiguous in the ordinary case; when it is ambiguous it declines and
the native picker takes over. Declining costs a prompt, guessing costs somebody's
file.

## Trying it

1. `chrome://extensions` → Developer mode → **Load unpacked** → `tray/webext/`
2. Open its **options** and grant the folder your decks live in
3. Double-click a `.bento.html` in that folder, edit something, press ⌘S

Expected: it saves with no dialog. Today, without the extension, that first ⌘S
asks where to put the file.

## What is unverified

Everything below needs the extension actually loaded — none of it is testable
from a page, and permission-gated behaviour reports `denied` under automation
(`working/home-design.md` §3.2, a trap that already produced two wrong
conclusions).

1. **Can an MV3 service worker `createWritable()` on a stored directory handle?**
   If not, the write moves to an offscreen document. Kept as one call in
   `background.js` `write()` so the answer changes that function and nothing
   else.
2. **Do MAIN-world content scripts run before the deck's runtime** on a
   `file://` page at `document_start`? The override must be installed before
   `save.ts` reads `window.showSaveFilePicker`.
3. **Does the user actually have file-URL access?** Chrome requires "Allow
   access to file URLs" to be enabled by hand, per extension. Without it the
   content scripts never run and the deck behaves exactly as it does today.
4. The `suggestedName === current file` heuristic against every real save path —
   ⌘S, autosave write-back, self-update, and each export.

## Not this

**Firefox** implements no File System Access API at all, and its extensions
cannot write arbitrary files either; that needs native messaging with a native
helper. Firefox stays download-a-copy.

**Safari** likewise has no FSA, and a Safari Web Extension ships inside a native
macOS app anyway — so Safari's answer is `tray/macos`, not this.
