# bento/home

A launcher for Bento documents. Set it as your homepage or new-tab page.

It holds no document content. It remembers **handles** to files you have
opened, so a deck you were working on is one click away with write access still
attached, and it is a drop target that is always there.

Design and the measurements behind it: `working/home-design.md`.

## Why it exists

A browser only hands a page a writable file handle through a gesture that
supplies one — a save picker, or a drop. A `.bento.html` double-clicked in
Finder loads as a `file://` page with **no handle and no way to acquire one**,
and with an *opaque* origin, so it has nowhere durable to remember anything
either. Chrome states it plainly: *"'file:' URLs are treated as unique security
origins."* Two decks in the same folder are two different origins.

Home has a stable origin. That is the whole trick: a `FileSystemFileHandle` is
structured-cloneable, so home can keep one in IndexedDB and re-grant write
access next session with a single permission click. Measured in a real browser
on 2026-08-01 (`working/home-design.md` §3.1).

Drop-to-open shipped in slides 1.0.12 and works well, but needs a Bento editor
already open in the window you drop into. A homepage is exactly that.

## Not a document, and not a library

Every other app here compiles to a single HTML file because that file **is** the
document. Home does not: it is a page served from a stable origin, and the
stable origin is the point. It is the first Bento thing that is *worse* saved
locally, which is worth being honest about.

It is also not a library. The documents live wherever you keep them; home only
remembers how to reach them.

## Invariants

1. **Home never holds document content** — handles, names, timestamps only.
2. **Every deck still opens standalone, anywhere, with home absent.**
3. **Home is never required to save.** Double-click and drop keep working.
4. **No document data leaves the machine.** No account, no sync, no server.
5. **Home does not become an editor.**
6. **Home never executes a deck on its own origin.** See below — this one is
   the reason opening is unfinished rather than merely unpolished.

`docs/PLATFORM.md` §1 says no backend is required to open, edit, present or
save. §1 governs the **document's** lifecycle; a launcher is not a document.
Home may be fetched, cached, installed or absent, and no deck's ability to open,
edit, present or save depends on it.

## What works today

- Drop a `.bento.html` anywhere on the page → the handle is captured and
  remembered, with write access requested inside the drop gesture.
- **Open a deck…** → same, through the picker.
- Recents list with live state per entry: writable, needs one click, or
  **moved or deleted** (a remembered file that has gone stays visibly broken
  rather than vanishing, so you are not left wondering).
- Titles read out of each file **without executing it** — pure text parsing of
  the `#bento-doc` block, which the splice contract guarantees is plaintext
  JSON near the top of every Bento file. Password-protected decks are listed
  without a title, deliberately.
- `navigator.storage.persist()`, with the answer shown rather than swallowed:
  eviction destroys the handles, which are the only thing here that cannot be
  reconstructed.

## What is undecided: how a deck is opened

To open a deck **with silent save**, that file's own code has to run somewhere
and the handle has to reach it. Those pull in opposite directions.

A blob URL inherits the creating page's origin, so
`window.open(URL.createObjectURL(file))` would run the deck **on home's
origin**, with full access to home's IndexedDB — a store of writable handles to
every other deck you have opened. A file someone emailed you could then rewrite
all of them. That is a real escalation over double-clicking it, where the file
gets an opaque origin and reaches nothing.

`docs/DECISIONS.md` (2026-07-24) already ruled on this shape for tray: each
document gets its own origin `bento-tray://<sha256 of path>`, *"because a
shared origin would let one document read another's localStorage and
IndexedDB"*. Home must not undo that ruling in a browser.

### Why one shared runner origin is not enough

The tempting fix is a single `run.bento.page` that executes every document.
It solves the wrong half. Documents could no longer read home's handles, but
they would all share an origin **with each other** — and a Bento document
persists real things:

| store | contents |
|---|---|
| `bento-autosave` IndexedDB → `recovery` | **plaintext doc JSON**, keyed by `docId` |
| `bento-autosave` IndexedDB → `versions` | a timeline of the same |
| `localStorage` `bento-member-<docId>` | the device's **collab member private key** |

One runner origin therefore creates a pooled store — which does not exist today
— holding the full content and version history of every document opened through
it, plus the keys that authorise writing to their collaboration rooms. Any
document on that origin can read all of it.

### Ruled: per-document origin, or home does not open documents

`docs/DECISIONS.md` (2026-08-02). Home may **acquire** a handle any way it can,
and must **hand off** to an origin derived from the document's identity:

| mechanism | what it is | role |
|---|---|---|
| picker / drop | shipped, working | acquisition |
| `file_handlers` + `launchQueue` | installed PWA only; the sole route that fixes double-click | acquisition — it delivers to *home's* origin, so it is not isolation |
| **per-document origin** (`<hash>-run.bento.page`) | matches what tray already does | **the isolation** |

Also considered and not adopted: a shared runner with storage neutered (no
autosave, no member keys, `Clear-Site-Data` per load). It removes the pool by
breaking recovery, version history and collab identity, and stays safe only as
long as every future feature remembers not to persist anything. Per-document
origins get the same property structurally.

**Hosting.** `bento.page` is GitHub Pages behind Cloudflare; `sync.bento.page`
is Cloudflare-only. Pages serves one custom domain per repo and no wildcards, so
the runner belongs on Cloudflare beside the relay — with its own deploy cadence,
and the deploy-order care that implies.

**On the name.** `run`, not `slides` or `deck`: the runner never parses the
format, and executes a file that may be slides, spaces or sheets. An app-named
origin would isolate nothing extra and app names should stay free for the apps'
own pages. The precedent is `sync.bento.page` — a subdomain marks a **trust
boundary**, not a product.

### Before building the runner

Neither is testable in an automated browser (see above):

1. Does a `FileSystemFileHandle` survive a cross-origin `postMessage` and stay
   usable? A re-prompt on the receiving origin is expected and fine; being
   unusable would sink this shape entirely.
2. Cloudflare Universal SSL covers one label (`x.bento.page`) but not two
   (`x.run.bento.page`). If that holds, a single hyphenated label —
   `<hash>-run.bento.page` — avoids Advanced Certificate Manager. Worth settling
   first: it is baked into every stored origin.

C is the only mechanism that fixes double-click, and it composes with A or B
rather than replacing them.

**All three are permission-gated, and permission-gated APIs report `denied` in
an automated browser without ever prompting** — that trap already produced two
wrong conclusions during the design (`working/home-design.md` §3.2). They must
be measured by hand, in a real browser.

Until one is chosen and measured, `launch.ts` **refuses** rather than quietly
taking the unsafe route, and says so in the UI. A launcher that silently widened
the blast radius of every deck you open would be worse than one that does not
open them yet.

## Running it

```bash
cd home && npm install && npm run dev
```

`node scripts/test-home.ts` covers the identity parser, including the two cases
that matter: a truncated block (any deck with an image exceeds the head read)
and an encrypted deck (must never surface a title).
