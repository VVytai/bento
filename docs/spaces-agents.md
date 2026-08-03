# bento/spaces — for AI agents

**Guide version `__APP_VERSION__`** · document format `bento/spaces` (v1).

A space (`*.bento.html`) is a self-contained HTML file holding **a tree of
pages**. The document lives in ONE plaintext block near the top:

```html
<script type="application/bento+json" id="bento-doc">
{ "format": "bento/spaces", ... }
</script>
```

Two ways to work with it:

1. **File harness** — edit the JSON inside `#bento-doc` in place. Escape every
   `<` as `<` so the block can never contain a literal `</script>`. Leave
   the rest of the file alone.
2. **In the browser** — `window.bento` (below). Prefer the patch calls over
   `loadDoc`: rewriting the whole document to append a paragraph clobbers
   concurrent edits and flattens undo to one entry.

```bash
curl -fsSL https://bento.page/releases/spaces/Bento_Spaces.bento.html -o "<Name>.bento.html"
```

The downloaded file's `#bento-doc` block is **empty**. Opened in a browser it
mints a starter space; on disk there is nothing to copy from. Write your
document into the empty block.

---

## The shape

```jsonc
{
  "format": "bento/spaces", "version": 1,
  "docId": "…",                    // minted once, NEVER regenerate it
  "title": "Team handbook",
  "home": "p-intro",               // the page a reader lands on
  "theme": { "background": "#FFFFFF", "color": "#1E2A3A", "accent": "#F7A600",
             "fontFamily": "…", "measure": 720 },
  "pages": [                       // FLAT, in pre-order
    {
      "id": "p-intro", "title": "Introduction", "icon": "👋",
      "parent": "p-parent",        // optional — omit for a root page
      "blocks": [                  // FLAT, in pre-order
        { "id": "b1", "type": "p", "html": "Hello <b>world</b>." }
      ]
    }
  ]
}
```

**Both arrays are flat and in pre-order; nesting is a `parent` field.** A child
always follows its parent, which is what lets one forward pass rebuild the
tree. Do not nest arrays inside arrays.

**Every id is unique across the WHOLE document and is never reused.** Links,
backlinks and (later) collaboration key on them. A duplicate is repaired
deterministically at load and reported — but a repaired id is a *new* id, so
anything pointing at the old one is now pointing at the wrong node. Emit
unique ids the first time.

## Block types

| `type` | fields | renders as |
|---|---|---|
| `p` | `html` | `<p>` |
| `h1` `h2` `h3` | `html` | `<h1>`…`<h3>` |
| `bullet` `number` | `html` | `<li>` inside a `<ul>`/`<ol>` — adjacent siblings group automatically |
| `todo` | `html`, `done` | `<li>` with a checkbox |
| `toggle` | `html`, `open` | a fold; blocks whose `parent` is its id are its body |
| `quote` | `html` | `<blockquote>` |
| `code` | `html` (plain text), `lang` | `<pre><code>` |
| `divider` | — | `<hr>` |
| `image` | `src`, `alt`, `caption`, `width` (10–100 **%**), `w`/`h` (intrinsic px) | `<figure>` |
| `pagelink` | `page` | a card linking to another page |

`type` is a **string**, not a closed set: an unknown type survives a round trip
and renders its `html` as a fallback. Properties are **flat on the block** —
there is no `props` object.

## Rich text

`html` is **inline only**: `b i u s em strong code a span mark sub sup br`.
Block structure is `type`, never markup — a `<p>` or `<div>` inside `html` is
always a mistake and is unwrapped at load.

Links are same-document fragments:

```json
{ "id": "b7", "type": "p", "html": "see <a href=\"#p/p-intro\">the intro</a>" }
```

`href` must match `^(https?:|mailto:|#p/)`. Anything else is stripped.

## What makes a space good rather than merely correct

| When the material is… | Reach for | Why |
|---|---|---|
| more than one topic | **separate pages**, not headings in one long page | the sidebar, ⌘K and backlinks all key on pages |
| a topic that belongs *under* another | `parent` on the page | the tree is the navigation |
| a reference to another page | an inline `#p/` link | it produces a backlink on the target automatically, at no cost |
| a list of sub-pages | one `pagelink` block each | a visible card beats a bare link for a hub page |
| steps someone will tick off | `todo` | state lives in the document, so it survives sharing |
| an aside, or detail most readers skip | `toggle` with its body as `parent` children | folds away, and always PRINTS expanded |
| anything you would print | remember toggles print open and archived pages are excluded | |

**The most-missed feature is backlinks.** They are derived — link to a page and
it lists the linker, with no maintenance. A space where pages only link *down*
the tree wastes the one thing this format does that a folder of files cannot.

## `window.bento`

```js
bento.doc                                  // the live document
bento.pages()                              // [{id, title, parent, archived, blocks}]
bento.getPage(id)                          // one page, with its blocks
bento.search(q)                            // [{pageId, title, blockId}]
bento.newPage(title, parent?)              // → new page id      (one undo step)
bento.insertBlocks(pageId, afterId, [...]) // → new block ids    (one undo step)
bento.loadDoc(json)                        // replace everything (one undo step)
bento.serialize()                          // the whole .bento.html file
bento.undo() / bento.redo()
bento.readonly                             // true = a locked or frozen file; writes no-op
```

`insertBlocks` and `newPage` each commit **one undoable step** and mint their
own ids. Use them in preference to `loadDoc` for anything incremental.

## Gotchas

- Escape `<` as `<` when writing the file block.
- Don't invent property names — unknown keys are preserved but ignored, so a
  typo means your styling silently does nothing.
- `docId` is the document's identity. Never regenerate it when editing.
- A `parent` naming something that does not exist is dropped at load: the page
  becomes a root page, the block re-homes. Not fatal, but not what you meant.
- `readonly: true` and a `policy` this build does not know both open **frozen**
  — the file round-trips byte-exact and edits are refused.
- There is no collaboration yet. Two people editing two copies get two files
  and no merge.
