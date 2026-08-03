// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The bento/spaces editor.
//
// The keyboard IS the interface here, so the keymap is specified rather than
// discovered, and every block is its own contentEditable host — never one big
// editable container. That is what keeps Selection block-scoped, so splitting
// and merging blocks can never re-mint an id, and ids are what links,
// backlinks and (later) collaboration key on.

import { type Block, newBlock, newPage } from './model'
import { Store } from './store'
import { renderPage } from './render'
import { canonicalize, sanitizeInline, textOf } from './sanitize'
import { t } from './i18n'
import { openAbout } from './about'
import { ICONS, type IconName } from './icons'

const CTRL = navigator.platform.toLowerCase().includes('mac') ? 'metaKey' : 'ctrlKey'

/** Markdown prefixes that convert a block as you type them. */
const AUTOFORMAT: Array<[RegExp, string, (b: Block) => void]> = [
  [/^# $/, 'h1', () => {}],
  [/^## $/, 'h2', () => {}],
  [/^### $/, 'h3', () => {}],
  [/^- $/, 'bullet', () => {}],
  [/^\* $/, 'bullet', () => {}],
  [/^1\. $/, 'number', () => {}],
  [/^> $/, 'quote', () => {}],
  [/^\[\] $/, 'todo', (b) => { b.done = false }],
  [/^\[ \] $/, 'todo', (b) => { b.done = false }],
  [/^```$/, 'code', () => {}],
  [/^--- $/, 'divider', () => {}],
]

const SLASH_ITEMS: Array<{ type: string; label: string; hint: string; icon: IconName }> = [
  { type: 'p', label: 'Text', hint: 'Plain paragraph', icon: 'text' },
  { type: 'h1', label: 'Heading 1', hint: '#', icon: 'h1' },
  { type: 'h2', label: 'Heading 2', hint: '##', icon: 'h2' },
  { type: 'h3', label: 'Heading 3', hint: '###', icon: 'h3' },
  { type: 'bullet', label: 'Bulleted list', hint: '-', icon: 'bullet' },
  { type: 'number', label: 'Numbered list', hint: '1.', icon: 'number' },
  { type: 'todo', label: 'To-do', hint: '[]', icon: 'todo' },
  { type: 'toggle', label: 'Toggle', hint: 'Collapsible section', icon: 'toggle' },
  { type: 'quote', label: 'Quote', hint: '>', icon: 'quote' },
  { type: 'code', label: 'Code', hint: '```', icon: 'code' },
  { type: 'divider', label: 'Divider', hint: '---', icon: 'divider' },
  { type: 'pagelink', label: 'Link to page', hint: 'A card that opens a page', icon: 'link' },
]

export class Editor {
  readonly store: Store
  private root: HTMLElement
  private main!: HTMLElement
  private sidebar!: HTMLElement
  private statusEl!: HTMLElement
  private overlay: HTMLElement | null = null
  /** set while the editor is writing the DOM, so input handlers stand down */
  private painting = false
  onSave: (() => void) | null = null

  constructor(root: HTMLElement, store: Store) {
    this.root = root
    this.store = store
    this.build()
    this.store.on('tree', () => this.paintTree())
    this.store.on('page', () => { this.paintPage(); this.paintTree() })
    this.store.on('doc', () => this.status(t('Edited')))
    window.addEventListener('popstate', () => this.fromHash())
    this.fromHash()
  }

  // ---- chrome -------------------------------------------------------------
  private build(): void {
    this.root.innerHTML = ''
    this.root.className = 'sp-app'

    const bar = el('header', 'sp-bar')
    const mark = el('span', 'sp-mark')
    mark.innerHTML = 'bento<span>/</span>spaces'
    const title = document.createElement('input')
    title.className = 'sp-doctitle'
    title.value = this.store.doc.title
    title.setAttribute('aria-label', t('Space name'))
    title.addEventListener('input', () => {
      this.store.runEdit('__title', () => { this.store.doc.title = title.value })
      document.title = `${title.value} — bento/spaces`
    })

    // On a phone the sidebar is off-canvas, so it needs a way in. Without
    // this the page tree — the whole point of a space holding many pages — is
    // simply unreachable below 720px.
    const menu = iconBtn('menu', t('Pages'), () => this.toggleSidebar())
    menu.classList.add('sp-menu')
    const search = iconBtn('search', t('Search all pages (⌘K)'), () => this.openSearch())
    const about = iconBtn('info', t('About this space'), () =>
      openAbout({ store: this.store, onRepaint: () => this.build() }))
    const save = iconBtn('save', t('Save (⌘S)'), () => this.onSave?.())
    save.classList.add('sp-primary')
    save.append(document.createTextNode(t('Save')))
    this.statusEl = el('span', 'sp-status')

    bar.append(menu, mark, title, this.statusEl, search, about, save)

    this.sidebar = el('nav', 'sp-side')
    this.sidebar.setAttribute('aria-label', t('Pages'))
    this.main = el('main', 'sp-main')

    const body = el('div', 'sp-body')
    body.append(this.sidebar, this.main)
    this.root.append(bar, body)

    this.paintTree()
    this.paintPage()
    document.addEventListener('keydown', (e) => this.onKey(e), true)
  }

  /** Open/close the page drawer on narrow screens, with a scrim to tap away. */
  private toggleSidebar(force?: boolean): void {
    const open = force ?? !this.sidebar.classList.contains('sp-open')
    this.sidebar.classList.toggle('sp-open', open)
    document.querySelector('.sp-scrim')?.remove()
    if (open) {
      const scrim = el('div', 'sp-scrim')
      scrim.addEventListener('click', () => this.toggleSidebar(false))
      document.body.append(scrim)
    }
  }

  status(msg: string): void {
    this.statusEl.textContent = msg
    this.statusEl.classList.add('sp-on')
    clearTimeout((this.statusEl as any)._t)
    ;(this.statusEl as any)._t = setTimeout(() => this.statusEl.classList.remove('sp-on'), 1800)
  }

  // ---- the page tree ------------------------------------------------------
  private paintTree(): void {
    const s = this.store
    this.sidebar.innerHTML = ''
    const head = el('div', 'sp-side-head')
    head.append(el('span', 'sp-side-title', t('Pages')))
    head.append(iconBtn('plus', t('New page (⌘⌥N)'), () => this.newPage()))
    this.sidebar.append(head)

    const list = el('ul', 'sp-tree')
    for (const { page, depth } of s.tree()) {
      if (page.archived) continue
      const li = document.createElement('li')
      li.style.paddingInlineStart = `${depth * 14}px`
      const a = document.createElement('a')
      a.href = `#p/${page.id}`
      a.className = 'sp-treelink' + (page.id === s.pageId ? ' sp-here' : '')
      const ico = el('span', 'sp-tree-ico')
      if (page.icon) ico.textContent = page.icon
      else ico.innerHTML = ICONS.page
      const label = document.createElement('span')
      label.textContent = page.title || t('Untitled')
      a.append(ico, label)
      a.draggable = true
      a.addEventListener('click', (e) => { e.preventDefault(); s.goToPage(page.id); this.toggleSidebar(false) })
      a.addEventListener('dragstart', (e) => e.dataTransfer?.setData('text/bento-page', page.id))
      a.addEventListener('dragover', (e) => { e.preventDefault(); a.classList.add('sp-drop') })
      a.addEventListener('dragleave', () => a.classList.remove('sp-drop'))
      a.addEventListener('drop', (e) => {
        e.preventDefault(); a.classList.remove('sp-drop')
        const moved = e.dataTransfer?.getData('text/bento-page')
        if (moved && moved !== page.id) this.reparentPage(moved, page.id)
      })
      li.append(a)
      list.append(li)
    }
    if (!list.childElementCount) list.append(el('li', 'sp-side-empty', t('No pages yet')))
    this.sidebar.append(list)

    // dropping on the empty area below the tree makes a page top-level again
    list.addEventListener('dragover', (e) => e.preventDefault())
    this.sidebar.addEventListener('drop', (e) => {
      if ((e.target as HTMLElement).closest('.sp-treelink')) return
      e.preventDefault()
      const moved = e.dataTransfer?.getData('text/bento-page')
      if (moved) this.reparentPage(moved, '')
    })
  }

  /** Re-parent a page, refusing a move that would make it its own ancestor. */
  private reparentPage(id: string, parent: string): void {
    if (id === parent) return
    for (let p: string | undefined = parent; p; p = this.store.index.page.get(p)?.parent) {
      if (p === id) { this.status(t('A page cannot contain itself')); return }
    }
    this.store.commit(() => {
      const page = this.store.index.page.get(id)
      if (!page) return
      if (parent) page.parent = parent
      else delete page.parent
    })
  }

  newPage(parent?: string): void {
    const page = newPage(t('Untitled'))
    if (parent) page.parent = parent
    this.store.commit(() => { this.store.doc.pages.push(page) })
    this.store.goToPage(page.id)
    requestAnimationFrame(() => {
      const h = this.main.querySelector<HTMLElement>('[data-page-title]')
      h?.focus()
      if (h) selectAll(h)
    })
  }

  // ---- the page -----------------------------------------------------------
  private paintPage(): void {
    const s = this.store
    const page = s.page
    this.main.innerHTML = ''
    if (!page) { this.main.append(el('p', 'sp-empty', t('This space has no pages.'))); return }

    this.painting = true
    const trail: string[] = []
    for (let p = page.parent; p; p = s.index.page.get(p)?.parent) {
      const owner = s.index.page.get(p)
      if (!owner) break
      trail.unshift(owner.id)
      if (trail.length > 4) break
    }
    const view = renderPage(page, s.doc, {
      editable: !s.readOnly,
      titleOf: (id) => s.index.page.get(id)?.title,
    })
    if (trail.length) {
      const crumb = el('nav', 'sp-crumb')
      crumb.setAttribute('aria-label', t('Breadcrumb'))
      trail.forEach((id, i) => {
        if (i) crumb.append(Object.assign(document.createElement('span'), { textContent: '›' }))
        const a = document.createElement('a')
        a.href = `#p/${id}`
        a.textContent = s.index.page.get(id)?.title || t('Untitled')
        a.addEventListener('click', (e) => { e.preventDefault(); s.goToPage(id) })
        crumb.append(a)
      })
      view.querySelector('.sp-page-inner')?.prepend(crumb)
    }
    this.main.append(view)
    this.wire(view)
    view.querySelector('.sp-page-inner')?.append(this.backlinks(page.id))
    this.painting = false
  }

  /**
   * The hover gutter.
   *
   * A block editor with no visible affordances is a guessing game: nothing on
   * screen says a block can be moved or that a new one can go here. These sit
   * OUTSIDE the text column so they never reflow the prose, and only appear on
   * hover so a page at rest is just the writing.
   */
  private addGutter(node: HTMLElement, blockId: string): void {
    const g = el('div', 'sp-gutter')
    const add = document.createElement('button')
    add.className = 'sp-ghost'
    add.type = 'button'
    add.innerHTML = ICONS.plus
    add.title = t('Add a block below')
    add.setAttribute('aria-label', t('Add a block below'))
    add.addEventListener('click', () => this.insertAfter(blockId))

    const grip = document.createElement('button')
    grip.className = 'sp-ghost'
    grip.type = 'button'
    grip.draggable = true
    grip.innerHTML = ICONS.grip
    grip.title = t('Drag to move, click for block options')
    grip.setAttribute('aria-label', t('Block options'))
    grip.addEventListener('click', () => this.openSlash(blockId, grip))
    grip.addEventListener('dragstart', (e) => {
      e.dataTransfer?.setData('text/bento-block', blockId)
      node.classList.add('sp-dragging')
    })
    grip.addEventListener('dragend', () => node.classList.remove('sp-dragging'))

    node.addEventListener('dragover', (e) => { e.preventDefault(); node.classList.add('sp-dropline') })
    node.addEventListener('dragleave', () => node.classList.remove('sp-dropline'))
    node.addEventListener('drop', (e) => {
      e.preventDefault()
      node.classList.remove('sp-dropline')
      const moved = e.dataTransfer?.getData('text/bento-block')
      if (moved && moved !== blockId) this.moveBlock(moved, blockId)
    })

    g.append(add, grip)
    node.prepend(g)
  }

  private insertAfter(blockId: string): void {
    const s = this.store
    const page = s.page
    if (!page) return
    const fresh = newBlock('p')
    const owner = s.block(blockId)
    if (owner?.parent) fresh.parent = owner.parent
    s.commit(() => {
      page.blocks.splice(page.blocks.findIndex((b) => b.id === blockId) + 1, 0, fresh)
    })
    this.paintPage()
    this.focusBlock(fresh.id)
  }

  /** Move a block (and anything nested under it) to sit after another. */
  private moveBlock(moved: string, after: string): void {
    const s = this.store
    const page = s.page
    if (!page) return
    const from = page.blocks.findIndex((b) => b.id === moved)
    if (from < 0) return
    // a subtree travels with its owner, or its children would be orphaned
    const kids: string[] = []
    const collect = (id: string) => {
      for (const b of page.blocks) if (b.parent === id) { kids.push(b.id); collect(b.id) }
    }
    collect(moved)
    if (kids.includes(after)) return // never drop a block inside its own subtree
    s.commit(() => {
      const group = [moved, ...kids].map((id) => page.blocks.find((b) => b.id === id)!).filter(Boolean)
      for (const b of group) page.blocks.splice(page.blocks.indexOf(b), 1)
      const at = page.blocks.findIndex((b) => b.id === after) + 1
      page.blocks.splice(at, 0, ...group)
    })
    this.paintPage()
  }

  /** Attach behaviour to a freshly painted page. */
  private wire(view: HTMLElement): void {
    const s = this.store

    const title = view.querySelector<HTMLElement>('[data-page-title]')
    if (title) {
      title.dataset.ph = t('Untitled')
      if (!title.textContent?.trim()) title.dataset.empty = '1'
      title.addEventListener('input', () => { if (title.textContent?.trim()) delete title.dataset.empty; else title.dataset.empty = '1' })
    }
    title?.addEventListener('input', () => {
      if (this.painting) return
      const id = title.dataset.pageTitle!
      s.runEdit(`title:${id}`, () => {
        const p = s.index.page.get(id)
        if (p) p.title = title.textContent ?? ''
      })
      this.paintTreeSoon()
    })

    for (const node of view.querySelectorAll<HTMLElement>('[data-block-id]')) {
      if (!s.readOnly) this.addGutter(node, node.dataset.blockId!)
    }

    for (const host of view.querySelectorAll<HTMLElement>('[data-edit]')) {
      const id = host.dataset.edit!
      host.dataset.ph = t('Type / for blocks, [[ to link a page')
      host.addEventListener('input', () => {
        if (this.painting) return
        delete host.dataset.empty
        s.runEdit(id, () => {
          const b = s.block(id)
          if (b) b.html = host.innerHTML
        })
        this.autoformat(id, host)
      })
      host.addEventListener('blur', () => {
        if (this.painting) return
        s.endRun()
        const b = s.block(id)
        if (b && b.html !== undefined) {
          const clean = canonicalize(b.html)
          if (clean !== b.html) { b.html = clean; host.innerHTML = clean }
        }
      })
    }

    for (const box of view.querySelectorAll<HTMLInputElement>('.sp-check')) {
      box.addEventListener('change', () => {
        const id = (box.closest('[data-block-id]') as HTMLElement).dataset.blockId!
        s.commit(() => { const b = s.block(id); if (b) b.done = box.checked }, { structure: false })
        box.closest('[data-block-id]')!.classList.toggle('sp-done', box.checked)
      })
    }

    for (const tw of view.querySelectorAll<HTMLElement>('.sp-twist')) {
      tw.addEventListener('click', () => {
        const id = (tw.closest('[data-block-id]') as HTMLElement).dataset.blockId!
        s.commit(() => { const b = s.block(id); if (b) b.open = !b.open })
        this.paintPage()
      })
    }

    // intra-space links navigate without leaving the document
    view.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement).closest('a')
      if (!a) return
      const href = a.getAttribute('href') ?? ''
      if (href.startsWith('#p/')) { e.preventDefault(); s.goToPage(href.slice(3)) }
    })
  }

  private treeTimer: ReturnType<typeof setTimeout> | undefined
  private paintTreeSoon(): void {
    clearTimeout(this.treeTimer)
    this.treeTimer = setTimeout(() => this.paintTree(), 250)
  }

  /** What links here — derived, never stored. */
  private backlinks(pageId: string): HTMLElement {
    const s = this.store
    const refs = s.index.backlinks.get(pageId) ?? []
    const box = el('section', 'sp-backlinks')
    if (!refs.length) return box
    box.append(el('h2', 'sp-backlinks-h', t('Linked from')))
    const seen = new Set<string>()
    const ul = el('ul', 'sp-backlink-list')
    for (const r of refs) {
      if (seen.has(r.pageId)) continue
      seen.add(r.pageId)
      const from = s.index.page.get(r.pageId)
      if (!from) continue
      const li = document.createElement('li')
      const a = document.createElement('a')
      a.href = `#p/${from.id}`
      a.textContent = from.title || t('Untitled')
      a.addEventListener('click', (e) => { e.preventDefault(); s.goToPage(from.id) })
      const snippet = textOf(s.index.block.get(r.blockId)?.block.html).slice(0, 120)
      li.append(a)
      if (snippet) li.append(el('span', 'sp-snippet', snippet))
      ul.append(li)
    }
    box.append(ul)
    return box
  }

  // ---- editing ------------------------------------------------------------
  private blockAt(node: Node | null): { id: string; host: HTMLElement } | null {
    const host = (node instanceof HTMLElement ? node : node?.parentElement)?.closest<HTMLElement>('[data-edit]')
    return host ? { id: host.dataset.edit!, host } : null
  }

  private focused(): { id: string; host: HTMLElement } | null {
    return this.blockAt(document.activeElement)
  }

  /** Markdown prefixes convert the block as they are typed. */
  private autoformat(id: string, host: HTMLElement): void {
    const text = host.textContent ?? ''
    for (const [re, type, extra] of AUTOFORMAT) {
      if (!re.test(text)) continue
      const s = this.store
      const b = s.block(id)
      if (!b || b.type === type) return
      s.commit(() => { b.type = type; b.html = ''; extra(b) })
      this.paintPage()
      this.focusBlock(id)
      return
    }
  }

  private focusBlock(id: string, atEnd = true): void {
    requestAnimationFrame(() => {
      const host = this.main.querySelector<HTMLElement>(`[data-edit="${CSS.escape(id)}"]`)
      if (!host) return
      host.focus()
      if (atEnd) caretToEnd(host)
    })
  }

  private onKey(e: KeyboardEvent): void {
    const s = this.store
    const mod = (e as any)[CTRL] as boolean

    if (mod && e.key.toLowerCase() === 'k' && !e.shiftKey) { e.preventDefault(); this.openSearch(); return }
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); this.onSave?.(); return }
    if (mod && e.altKey && e.key.toLowerCase() === 'n') { e.preventDefault(); this.newPage(); return }
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault()
      if (e.shiftKey) s.redo(); else s.undo()
      this.paintPage(); this.paintTree()
      return
    }
    if (this.overlay) return // the overlay owns the keyboard while it is open

    const cur = this.focused()
    if (!cur) return
    const b = s.block(cur.id)
    if (!b) return

    // native undo must never diverge from the store's history
    if (mod && (e.key.toLowerCase() === 'y')) { e.preventDefault(); s.redo(); this.paintPage(); return }

    if (e.key === 'Enter' && !e.shiftKey && b.type !== 'code') {
      e.preventDefault()
      this.splitBlock(cur.id, cur.host)
      return
    }
    if (e.key === 'Backspace' && atStart(cur.host)) {
      const empty = !(cur.host.textContent ?? '').trim()
      if (b.type !== 'p' && empty) { e.preventDefault(); this.setType(cur.id, 'p'); return }
      e.preventDefault()
      this.mergeBack(cur.id)
      return
    }
    if (e.key === 'Tab') {
      e.preventDefault()
      this.indent(cur.id, !e.shiftKey)
      return
    }
    if (e.key === '/' && !(cur.host.textContent ?? '').trim()) {
      // a slash on an empty block opens the block menu
      setTimeout(() => this.openSlash(cur.id), 0)
      return
    }
    if (e.key === '[' && cur.host.textContent?.endsWith('[')) {
      setTimeout(() => this.openPagePicker(cur.id, cur.host), 0)
      return
    }
    if (mod && ['b', 'i', 'u'].includes(e.key.toLowerCase())) {
      e.preventDefault()
      document.execCommand(({ b: 'bold', i: 'italic', u: 'underline' } as any)[e.key.toLowerCase()])
      s.runEdit(cur.id, () => { const bb = s.block(cur.id); if (bb) bb.html = cur.host.innerHTML })
      return
    }
  }

  private splitBlock(id: string, host: HTMLElement): void {
    const s = this.store
    const b = s.block(id)
    if (!b) return
    const [before, after] = splitAtCaret(host)
    const fresh = newBlock(b.type === 'h1' || b.type === 'h2' || b.type === 'h3' ? 'p' : b.type, { html: after })
    if (b.type === 'todo') fresh.done = false
    if (b.parent) fresh.parent = b.parent
    s.commit(() => {
      b.html = before
      const page = s.page!
      page.blocks.splice(page.blocks.indexOf(b) + 1, 0, fresh)
    })
    this.paintPage()
    this.focusBlock(fresh.id, false)
  }

  private mergeBack(id: string): void {
    const s = this.store
    const page = s.page
    if (!page) return
    const i = page.blocks.findIndex((x) => x.id === id)
    if (i <= 0) return
    const prev = page.blocks[i - 1]
    const b = page.blocks[i]
    if (prev.type === 'divider') { s.commit(() => { page.blocks.splice(i - 1, 1) }); this.paintPage(); this.focusBlock(id); return }
    const at = (prev.html ?? '').length
    s.commit(() => {
      prev.html = (prev.html ?? '') + (b.html ?? '')
      // a merged-away parent would orphan its children — re-home them
      for (const child of page.blocks) if (child.parent === b.id) child.parent = prev.id
      page.blocks.splice(i, 1)
    })
    this.paintPage()
    requestAnimationFrame(() => {
      const host = this.main.querySelector<HTMLElement>(`[data-edit="${CSS.escape(prev.id)}"]`)
      if (host) { host.focus(); caretToOffset(host, at) }
    })
  }

  /** Tab sets `parent` to the previous sibling — one field write. */
  private indent(id: string, deeper: boolean): void {
    const s = this.store
    const page = s.page
    if (!page) return
    const i = page.blocks.findIndex((x) => x.id === id)
    const b = page.blocks[i]
    if (!b) return
    s.commit(() => {
      if (!deeper) {
        if (!b.parent) return
        const owner = page.blocks.find((x) => x.id === b.parent)
        if (owner?.parent) b.parent = owner.parent
        else delete b.parent
        return
      }
      // the nearest preceding block at the same level becomes the owner
      for (let j = i - 1; j >= 0; j--) {
        if (page.blocks[j].parent === b.parent) { b.parent = page.blocks[j].id; return }
      }
    })
    this.paintPage()
    this.focusBlock(id)
  }

  setType(id: string, type: string): void {
    this.store.commit(() => {
      const b = this.store.block(id)
      if (!b) return
      b.type = type
      if (type === 'todo' && b.done === undefined) b.done = false
      if (type === 'toggle' && b.open === undefined) b.open = true
    })
    this.paintPage()
    this.focusBlock(id)
  }

  // ---- overlays -----------------------------------------------------------
  private openOverlay(title: string, build: (body: HTMLElement, close: () => void) => void): void {
    this.closeOverlay()
    const back = el('div', 'sp-overlay')
    const card = el('div', 'sp-card')
    card.setAttribute('role', 'dialog')
    card.setAttribute('aria-label', title)
    const close = () => this.closeOverlay()
    build(card, close)
    back.append(card)
    back.addEventListener('mousedown', (e) => { if (e.target === back) close() })
    document.body.append(back)
    this.overlay = back
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); close() } }
    back.addEventListener('keydown', onEsc)
    card.querySelector<HTMLElement>('input,button,[tabindex]')?.focus()
  }

  private closeOverlay(): void {
    this.overlay?.remove()
    this.overlay = null
  }

  /** Anchor a popover to a rect, kept inside the viewport. */

  /** ⌘K — search every page, including collapsed toggles and archived pages. */
  openSearch(): void {
    const s = this.store
    this.openOverlay(t('Search'), (card, close) => {
      const input = document.createElement('input')
      input.className = 'sp-find'
      input.placeholder = t('Search all pages…')
      const results = el('ul', 'sp-results')
      const run = () => {
        const q = input.value.trim().toLowerCase()
        results.innerHTML = ''
        if (!q) return
        let n = 0
        for (const p of s.doc.pages) {
          const hits: string[] = []
          if (p.title.toLowerCase().includes(q)) hits.push(p.title)
          for (const b of p.blocks) {
            const text = textOf(b.html)
            if (text.toLowerCase().includes(q)) hits.push(text)
            if (hits.length > 2) break
          }
          if (!hits.length) continue
          if (++n > 30) break
          const li = document.createElement('li')
          const a = document.createElement('button')
          a.className = 'sp-result'
          a.innerHTML =
            `<span class="sp-result-ico">${ICONS.page}</span>` +
            `<span class="sp-result-txt"><strong>${escapeHtml(p.title || t('Untitled'))}` +
            (p.archived ? ` <em class="sp-arch">${t('archived')}</em>` : '') + `</strong>` +
            `<span>${escapeHtml(hits.slice(0, 2).join(' · ').slice(0, 140))}</span></span>`
          a.addEventListener('click', () => { close(); s.goToPage(p.id) })
          li.append(a)
          results.append(li)
        }
        if (!results.childElementCount) results.append(el('li', 'sp-noresult', t('Nothing found')))
      }
      input.addEventListener('input', run)
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') results.querySelector<HTMLElement>('.sp-result')?.click()
      })
      card.append(el('h2', 'sp-card-h', t('Search this space')), input, results)
    })
  }

  /**
   * The block menu, anchored where you are.
   *
   * A centred modal for "turn this line into a heading" loses the thing you
   * were pointing at. This opens beside the caret (or the gutter button that
   * summoned it), is driven entirely by the keyboard, and filters as you type
   * so `/h2` reaches a heading without the hand leaving the keys.
   */
  private openSlash(blockId: string, anchor?: HTMLElement): void {
    this.closeOverlay()
    const pop = el('div', 'sp-pop')
    pop.setAttribute('role', 'listbox')
    const find = document.createElement('input')
    find.className = 'sp-find'
    find.placeholder = t('Filter blocks…')
    const list = el('ul', 'sp-results')
    pop.append(find, list)

    let items = SLASH_ITEMS
    let sel = 0
    const commit = (item: typeof SLASH_ITEMS[number]) => {
      this.closeOverlay()
      const blk = this.store.block(blockId)
      // the "/" that opened the menu is a command, not content
      if (blk && (blk.html ?? '').trim() === '/') blk.html = ''
      if (item.type === 'pagelink') this.insertPageCard(blockId)
      else this.setType(blockId, item.type)
    }
    const paint = () => {
      list.innerHTML = ''
      items.forEach((item, i) => {
        const li = document.createElement('li')
        const b = document.createElement('button')
        b.className = 'sp-result' + (i === sel ? ' sp-sel' : '')
        b.type = 'button'
        b.setAttribute('role', 'option')
        b.innerHTML =
          `<span class="sp-result-ico">${ICONS[item.icon]}</span>` +
          `<span class="sp-result-txt"><strong>${escapeHtml(t(item.label))}</strong>` +
          `<span>${escapeHtml(t(item.hint))}</span></span>`
        b.addEventListener('click', () => commit(item))
        li.append(b)
        list.append(li)
      })
      if (!items.length) list.append(el('li', 'sp-noresult', t('No block matches')))
    }
    find.addEventListener('input', () => {
      const q = find.value.trim().toLowerCase()
      items = SLASH_ITEMS.filter((i) => t(i.label).toLowerCase().includes(q) || i.type.includes(q))
      sel = 0
      paint()
    })
    find.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(sel + 1, items.length - 1); paint() }
      else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(sel - 1, 0); paint() }
      else if (e.key === 'Enter') { e.preventDefault(); if (items[sel]) commit(items[sel]) }
      else if (e.key === 'Escape') { e.preventDefault(); this.closeOverlay(); this.focusBlock(blockId) }
    })
    paint()

    document.body.append(pop)
    this.overlay = pop
    place(pop, anchor ?? caretRect())
    find.focus()

    // clicking anywhere else dismisses, but not the first click that opened it
    setTimeout(() => {
      const away = (ev: MouseEvent) => {
        if (!pop.contains(ev.target as Node)) { this.closeOverlay(); document.removeEventListener('mousedown', away) }
      }
      document.addEventListener('mousedown', away)
    }, 0)
  }

  private insertPageCard(blockId: string): void {
    this.openPagePicker(blockId, null, (pageId) => {
      this.store.commit(() => {
        const b = this.store.block(blockId)
        if (b) { b.type = 'pagelink'; b.page = pageId; b.html = '' }
      })
      this.paintPage()
    })
  }

  /** `[[` — pick a page, or make one, and link it inline. */
  private openPagePicker(blockId: string, host: HTMLElement | null, then?: (pageId: string) => void): void {
    const s = this.store
    this.openOverlay(t('Link to page'), (card, close) => {
      const input = document.createElement('input')
      input.className = 'sp-find'
      input.placeholder = t('Find or create a page…')
      const list = el('ul', 'sp-results')
      const choose = (pageId: string, title: string) => {
        close()
        if (then) { then(pageId); return }
        if (!host) return
        // the two "[" that opened the picker are not content
        const html = (host.innerHTML ?? '').replace(/\[?\[$/, '')
        const link = `<a href="#p/${pageId}">${escapeHtml(title)}</a>&nbsp;`
        s.commit(() => { const b = s.block(blockId); if (b) b.html = sanitizeInline(html + link) })
        this.paintPage()
        this.focusBlock(blockId)
      }
      const run = () => {
        const q = input.value.trim().toLowerCase()
        list.innerHTML = ''
        for (const p of s.doc.pages) {
          if (q && !p.title.toLowerCase().includes(q)) continue
          const li = document.createElement('li')
          const b = document.createElement('button')
          b.className = 'sp-result'
          b.type = 'button'
          b.innerHTML =
            `<span class="sp-result-ico">${ICONS.page}</span>` +
            `<span class="sp-result-txt"><strong>${escapeHtml(p.title || t('Untitled'))}</strong></span>`
          b.addEventListener('click', () => choose(p.id, p.title || t('Untitled')))
          li.append(b)
          list.append(li)
          if (list.childElementCount > 20) break
        }
        if (input.value.trim()) {
          const li = document.createElement('li')
          const b = document.createElement('button')
          b.className = 'sp-result sp-new'
          b.type = 'button'
          b.innerHTML =
            `<span class="sp-result-ico">${ICONS.plus}</span>` +
            `<span class="sp-result-txt"><strong>${escapeHtml(t('Create “{name}”', { name: input.value.trim() }))}</strong></span>`
          b.addEventListener('click', () => {
            const page = newPage(input.value.trim())
            s.commit(() => { s.doc.pages.push(page) })
            choose(page.id, page.title)
          })
          li.append(b)
          list.append(li)
        }
      }
      input.addEventListener('input', run)
      card.append(input, list)
      run()
    })
  }

  // ---- routing ------------------------------------------------------------
  private fromHash(): void {
    const m = location.hash.match(/^#p\/(.+)$/)
    if (m && this.store.index.page.has(m[1])) this.store.goToPage(m[1], { push: false })
  }

  repaint(): void { this.paintTree(); this.paintPage() }
}

// ---- small dom helpers ------------------------------------------------------
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag)
  n.className = cls
  if (text) n.textContent = text
  return n
}

function iconBtn(name: IconName, label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button')
  b.className = 'sp-btn'
  b.type = 'button'
  b.innerHTML = ICONS[name]
  b.title = label
  b.setAttribute('aria-label', label)
  b.addEventListener('click', onClick)
  return b
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function atStart(host: HTMLElement): boolean {
  const sel = getSelection()
  if (!sel || !sel.rangeCount) return false
  const r = sel.getRangeAt(0)
  if (!r.collapsed) return false
  const probe = r.cloneRange()
  probe.selectNodeContents(host)
  probe.setEnd(r.startContainer, r.startOffset)
  return probe.toString().length === 0
}

function caretToEnd(host: HTMLElement): void {
  const r = document.createRange()
  r.selectNodeContents(host)
  r.collapse(false)
  const sel = getSelection()
  sel?.removeAllRanges()
  sel?.addRange(r)
}

function caretToOffset(host: HTMLElement, offset: number): void {
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT)
  let seen = 0
  let node: Node | null
  while ((node = walker.nextNode())) {
    const len = node.textContent?.length ?? 0
    if (seen + len >= offset) {
      const r = document.createRange()
      r.setStart(node, offset - seen)
      r.collapse(true)
      const sel = getSelection()
      sel?.removeAllRanges()
      sel?.addRange(r)
      return
    }
    seen += len
  }
  caretToEnd(host)
}

function selectAll(host: HTMLElement): void {
  const r = document.createRange()
  r.selectNodeContents(host)
  const sel = getSelection()
  sel?.removeAllRanges()
  sel?.addRange(r)
}

/** Split a block's html at the caret, returning [before, after]. */
function splitAtCaret(host: HTMLElement): [string, string] {
  const sel = getSelection()
  if (!sel || !sel.rangeCount) return [host.innerHTML, '']
  const r = sel.getRangeAt(0)
  const after = r.cloneRange()
  after.selectNodeContents(host)
  after.setStart(r.endContainer, r.endOffset)
  const tail = after.cloneContents()
  const before = r.cloneRange()
  before.selectNodeContents(host)
  before.setEnd(r.startContainer, r.startOffset)
  const head = before.cloneContents()
  const wrap = (f: DocumentFragment) => { const d = document.createElement('div'); d.append(f); return d.innerHTML }
  return [sanitizeInline(wrap(head)), sanitizeInline(wrap(tail))]
}

/** Where the caret is, in viewport coordinates. */
function caretRect(): DOMRect {
  const sel = getSelection()
  if (sel && sel.rangeCount) {
    const r = sel.getRangeAt(0).getBoundingClientRect()
    if (r.width || r.height || r.top) return r
  }
  return new DOMRect(80, 120, 0, 0)
}

/** Place a popover near an anchor without letting it leave the viewport. */
function place(pop: HTMLElement, anchor: HTMLElement | DOMRect): void {
  const r = anchor instanceof HTMLElement ? anchor.getBoundingClientRect() : anchor
  const w = pop.offsetWidth || 260
  const h = pop.offsetHeight || 260
  let left = r.left
  let top = r.bottom + 6
  if (left + w > innerWidth - 8) left = Math.max(8, innerWidth - w - 8)
  if (top + h > innerHeight - 8) top = Math.max(8, r.top - h - 6)
  pop.style.left = `${Math.max(8, left)}px`
  pop.style.top = `${top}px`
}
