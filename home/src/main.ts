// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// bento/home — a launcher for Bento documents.
//
// It holds no document content. It remembers handles to files you have opened,
// so a deck you were working on is one click away with write access still
// attached, and it is a drop target that is always there — drop-to-open
// (slides 1.0.12) works beautifully and needs a Bento editor already open in
// the window you drop into, which is exactly what a homepage is.
//
// See home/README.md for the invariants, and working/home-design.md for the
// measurements behind them.

import './styles.css'
import * as recents from './recents.ts'
import type { RecentEntry, EntryState } from './recents.ts'
import { metaFromFile, displayName, isBento } from './deckmeta.ts'
import { launchDeck, launchSupport } from './launch.ts'

const app = document.getElementById('app')!
let entries: Array<RecentEntry & { state: EntryState }> = []
let persisted = false

// ————————————————————————————————————————————————— render

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))

/** "3 minutes ago" at the granularity a launcher needs, which is coarse. */
function ago(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000)
  if (s < 90) return 'just now'
  const m = s / 60
  if (m < 60) return `${Math.round(m)} min ago`
  const h = m / 60
  if (h < 24) return `${Math.round(h)}h ago`
  const d = h / 24
  if (d < 7) return `${Math.round(d)}d ago`
  return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

function render() {
  const support = launchSupport()
  app.innerHTML = `
    <div class="h-top">
      <div class="h-mark">bento<span>/</span>home</div>
      <div class="h-ver">${escape(__APP_VERSION__)}</div>
    </div>

    <div class="h-drop" id="drop">
      <strong>Drop a deck here to open it</strong>
      <span class="h-drop-sub">…and it stays in the list below, with permission to save back</span>
    </div>

    <div class="h-actions">
      <button class="primary" id="pick">Open a deck…</button>
      <button id="new-slides">New presentation</button>
    </div>

    <div class="h-sec">
      <span>Recent</span>
      ${entries.length ? '<button class="ghost" id="clear">Clear all</button>' : ''}
    </div>
    ${entries.length ? `<ul class="h-list">${entries.map(row).join('')}</ul>` : emptyState()}

    <p class="h-note">
      Home keeps <em>references</em> to your files — never their contents — in this
      browser only. Nothing is uploaded, and every Bento document opens on its own
      without it.${persisted ? '' : ' <span class="h-warn">This browser has not granted persistent storage, so the list can be cleared automatically if the disk gets tight.</span>'}
      ${support.ok ? '' : `<br><span class="h-warn">${escape(support.why)}</span>`}
    </p>`

  app.querySelector('#pick')!.addEventListener('click', pickDeck)
  app.querySelector('#new-slides')!.addEventListener('click', () => newDeck('slides'))
  app.querySelector('#clear')?.addEventListener('click', async () => {
    if (!confirm('Forget every deck in this list? The files themselves are untouched.')) return
    await recents.clear()
    await refresh()
  })
  for (const el of app.querySelectorAll<HTMLElement>('[data-open]')) {
    el.addEventListener('click', () => openEntry(el.dataset.open!))
  }
  for (const el of app.querySelectorAll<HTMLElement>('[data-forget]')) {
    el.addEventListener('click', async () => {
      await recents.forget(el.dataset.forget!)
      await refresh()
    })
  }
  wireDrop(app.querySelector<HTMLElement>('#drop')!)
}

const emptyState = () => `
  <p class="h-empty">Nothing yet. Drop a <code>.bento.html</code> above, or open one —
  it will be waiting here next time.</p>`

function row(e: RecentEntry & { state: EntryState }): string {
  const gone = e.state === 'missing'
  const tag = gone
    ? '<span class="h-tag gone">moved or deleted</span>'
    : e.state === 'needs-permission'
      ? '<span class="h-tag locked">click to allow</span>'
      : ''
  return `
    <li class="h-item${gone ? ' missing' : ''}">
      <button class="h-open" data-open="${escape(e.id)}"${gone ? ' disabled' : ''}>
        <span class="h-name">${escape(e.title || e.name)}</span>
        <span class="h-file">${escape(e.name)}</span>
      </button>
      ${tag}
      <span class="h-when">${gone ? '' : ago(e.lastOpened)}</span>
      <button class="ghost" data-forget="${escape(e.id)}" title="Remove from this list">✕</button>
    </li>`
}

// ————————————————————————————————————————————————— actions

async function refresh() {
  const list = await recents.list()
  entries = await Promise.all(list.map(async (e) => ({ ...e, state: await recents.stateOf(e) })))
  render()
}

/** Record a handle and open it. Shared by the picker, drops and file handlers. */
async function adopt(handle: FileSystemFileHandle, opts: { open?: boolean } = {}) {
  let file: File
  try {
    file = await handle.getFile()
  } catch {
    alert(`Could not read ${handle.name}.`)
    return
  }
  const meta = await metaFromFile(file)
  if (!isBento(meta) && !/\.bento\.html$/i.test(handle.name)) {
    alert(`${handle.name} does not look like a Bento document.`)
    return
  }
  const entry = await recents.remember(handle, {
    title: displayName(meta, handle.name),
    app: meta.format,
    size: file.size,
  })
  await refresh()
  if (opts.open !== false) await launchDeck(entry, file)
}

async function pickDeck() {
  try {
    const [handle] = await window.showOpenFilePicker({
      multiple: false,
      types: [{ description: 'Bento document', accept: { 'text/html': ['.html'] } }],
    })
    // Ask for write access inside THIS gesture — deferring it to the moment we
    // want to save means asking outside a gesture, which browsers refuse.
    await handle.requestPermission({ mode: 'readwrite' })
    await adopt(handle)
  } catch {
    /* the user cancelled the picker */
  }
}

async function openEntry(id: string) {
  const entry = entries.find((e) => e.id === id)
  if (!entry) return
  // This click IS the gesture the permission request needs.
  const state = entry.state === 'granted' ? 'granted' : await recents.grant(entry)
  if (state === 'missing') {
    await refresh()
    return
  }
  if (state !== 'granted') return
  const file = await entry.handle.getFile()
  await recents.remember(entry.handle, { size: file.size })
  await refresh()
  await launchDeck(entry, file)
}

function newDeck(app: 'slides') {
  // The distributable IS a blank deck — opening the release URL starts one.
  window.open(`https://bento.page/releases/${app}/Bento_Slides.bento.html`, '_blank', 'noopener')
}

function wireDrop(zone: HTMLElement) {
  const stop = (ev: DragEvent) => { ev.preventDefault(); ev.stopPropagation() }
  for (const type of ['dragenter', 'dragover'] as const) {
    zone.addEventListener(type, (ev) => { stop(ev); zone.classList.add('over') })
  }
  for (const type of ['dragleave', 'drop'] as const) {
    zone.addEventListener(type, (ev) => { stop(ev); zone.classList.remove('over') })
  }
  zone.addEventListener('drop', async (ev) => {
    const item = ev.dataTransfer?.items?.[0]
    if (!item) return
    // getAsFileSystemHandle is what makes a DROP different from a file input:
    // it yields a real handle, and a dropped handle can be granted write
    // access. A plain `files[0]` would give bytes and no way back to the disk.
    const handle = (await item.getAsFileSystemHandle?.()) as FileSystemFileHandle | null
    if (!handle || handle.kind !== 'file') {
      alert('Drop a single .bento.html file.')
      return
    }
    await handle.requestPermission({ mode: 'readwrite' })
    await adopt(handle)
  })
}

// Dropping anywhere on the page is the gesture people actually make — the
// dashed box says where, it should not be the only place that works.
for (const type of ['dragover', 'drop'] as const) {
  document.addEventListener(type, (ev) => {
    if (!(ev.target as HTMLElement)?.closest?.('#drop')) ev.preventDefault()
  })
}

// ————————————————————————————————————————————————— boot

async function boot() {
  persisted = await recents.requestPersistence()
  await refresh()
}

void boot()
