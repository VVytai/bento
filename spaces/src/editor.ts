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

const SLASH_ITEMS: Array<{ type: string; label: string; hint: string }> = [
  { type: 'p', label: 'Text', hint: 'Plain paragraph' },
  { type: 'h1', label: 'Heading 1', hint: '#' },
  { type: 'h2', label: 'Heading 2', hint: '##' },
  { type: 'h3', label: 'Heading 3', hint: '###' },
  { type: 'bullet', label: 'Bulleted list', hint: '-' },
  { type: 'number', label: 'Numbered list', hint: '1.' },
  { type: 'todo', label: 'To-do', hint: '[]' },
  { type: 'toggle', label: 'Toggle', hint: 'Collapsible section' },
  { type: 'quote', label: 'Quote', hint: '>' },
  { type: 'code', label: 'Code', hint: '```' },
  { type: 'divider', label: 'Divider', hint: '---' },
  { type: 'pagelink', label: 'Link to page', hint: 'A card that opens a page' },
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
    const menu = btn('☰', t('Pages'), () => this.sidebar.classList.toggle('sp-open'))
    menu.classList.add('sp-menu')
    const search = btn('⌕', t('Search all pages (⌘K)'), () => this.openSearch())
    const about = btn('ⓘ', t('About this space'), () =>
      openAbout({ store: this.store, onRepaint: () => { this.build() } }))
    const save = btn('⤓', t('Save (⌘S)'), () => this.onSave?.())
    save.classList.add('sp-primary')
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

  private status(msg: string): void {
    this.statusEl.textContent = msg
    clearTimeout((this.statusEl as any)._t)
    ;(this.statusEl as any)._t = setTimeout(() => { this.statusEl.textContent = '' }, 1800)
  }

  // ---- the page tree ------------------------------------------------------
  private paintTree(): void {
    const s = this.store
    this.sidebar.innerHTML = ''
    const head = el('div', 'sp-side-head')
    head.append(el('span', 'sp-side-title', t('Pages')))
    head.append(btn('＋', t('New page (⌘⌥N)'), () => this.newPage()))
    this.sidebar.append(head)

    const list = el('ul', 'sp-tree')
    for (const { page, depth } of s.tree()) {
      if (page.archived) continue
      const li = document.createElement('li')
      li.style.paddingInlineStart = `${depth * 14}px`
      const a = document.createElement('a')
      a.href = `#p/${page.id}`
      a.className = 'sp-treelink' + (page.id === s.pageId ? ' sp-here' : '')
      a.textContent = `${page.icon ? page.icon + ' ' : ''}${page.title || t('Untitled')}`
      a.draggable = true
      a.addEventListener('click', (e) => { e.preventDefault(); s.goToPage(page.id); this.sidebar.classList.remove('sp-open') })
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
    const view = renderPage(page, s.doc, {
      editable: !s.readOnly,
      titleOf: (id) => s.index.page.get(id)?.title,
    })
    this.main.append(view)
    this.wire(view)
    this.main.append(this.backlinks(page.id))
    this.painting = false
  }

  /** Attach behaviour to a freshly painted page. */
  private wire(view: HTMLElement): void {
    const s = this.store

    const title = view.querySelector<HTMLElement>('[data-page-title]')
    title?.addEventListener('input', () => {
      if (this.painting) return
      const id = title.dataset.pageTitle!
      s.runEdit(`title:${id}`, () => {
        const p = s.index.page.get(id)
        if (p) p.title = title.textContent ?? ''
      })
      this.paintTreeSoon()
    })

    for (const host of view.querySelectorAll<HTMLElement>('[data-edit]')) {
      const id = host.dataset.edit!
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
          a.innerHTML = `<strong>${escapeHtml(p.title || t('Untitled'))}</strong>` +
            (p.archived ? ` <em class="sp-arch">${t('archived')}</em>` : '') +
            `<span>${escapeHtml(hits.slice(0, 2).join(' · ').slice(0, 140))}</span>`
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
      card.append(input, results)
    })
  }

  private openSlash(blockId: string): void {
    this.openOverlay(t('Turn into'), (card, close) => {
      const list = el('ul', 'sp-results')
      for (const item of SLASH_ITEMS) {
        const li = document.createElement('li')
        const b = document.createElement('button')
        b.className = 'sp-result'
        b.innerHTML = `<strong>${escapeHtml(t(item.label))}</strong><span>${escapeHtml(t(item.hint))}</span>`
        b.addEventListener('click', () => {
          close()
          // the "/" that opened the menu is not content
          const blk = this.store.block(blockId)
          if (blk) blk.html = ''
          if (item.type === 'pagelink') this.insertPageCard(blockId)
          else this.setType(blockId, item.type)
        })
        li.append(b)
        list.append(li)
      }
      card.append(el('h2', 'sp-card-h', t('Turn into')), list)
    })
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
          b.textContent = p.title || t('Untitled')
          b.addEventListener('click', () => choose(p.id, p.title || t('Untitled')))
          li.append(b)
          list.append(li)
          if (list.childElementCount > 20) break
        }
        if (input.value.trim()) {
          const li = document.createElement('li')
          const b = document.createElement('button')
          b.className = 'sp-result sp-new'
          b.textContent = t('Create “{name}”', { name: input.value.trim() })
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

function btn(glyph: string, label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button')
  b.className = 'sp-btn'
  b.type = 'button'
  b.textContent = glyph
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
