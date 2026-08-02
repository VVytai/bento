// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The recents store — the one thing bento/home actually keeps.
//
// WHAT IT HOLDS AND WHY THAT IS THE WHOLE DESIGN. A `FileSystemFileHandle` is
// structured-cloneable, so it survives a round trip through IndexedDB and can
// be re-granted write access in a later session with one permission click.
// That is the entire mechanism behind "recent decks I can still save to", and
// it is unavailable to a deck opened by double-clicking, because a `file://`
// page has an OPAQUE origin — Chrome: "'file:' URLs are treated as unique
// security origins" — so two decks in the same folder are two different
// origins and neither has anywhere durable to write.
//
// Home has a stable origin, so it can hold the handles. It holds NOTHING ELSE:
// name, title, timestamp, size. A store that kept document content would be a
// library, and a library is a different product from a launcher.
//
// EVICTION IS THE RISK THAT MATTERS. IndexedDB can be cleared under storage
// pressure, and clearing this store destroys the handles — the only thing home
// exists to keep. Everything else here is reconstructible; those are not. Hence
// `requestPersistence()` and the fact that its answer is surfaced rather than
// swallowed.

/** A remembered deck. `handle` is the part that cannot be reconstructed. */
export interface RecentEntry {
  /** stable key — see `keyFor` */
  id: string
  handle: FileSystemFileHandle
  /** file name at the time it was last opened */
  name: string
  /** the deck's own title, when we could read it — for display only */
  title?: string
  /** which app wrote it, from the file's generator meta */
  app?: string
  /** epoch ms */
  lastOpened: number
  /** bytes, last time we looked */
  size?: number
}

/**
 * How an entry is currently reachable.
 *
 * `missing` exists because a remembered file can be moved, renamed or deleted
 * between sessions, and a launcher that silently drops those entries is worse
 * than one that says so: the user is left wondering whether they imagined
 * opening it. A missing entry stays in the list, visibly broken, until removed.
 */
export type EntryState = 'granted' | 'needs-permission' | 'missing'

const DB = 'bento-home'
const STORE = 'recents'
const VERSION = 1

function open(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB, VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' })
    }
    req.onsuccess = () => res(req.result)
    req.onerror = () => rej(req.error)
  })
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((res, rej) => {
        const t = db.transaction(STORE, mode)
        const req = fn(t.objectStore(STORE))
        req.onsuccess = () => res(req.result)
        req.onerror = () => rej(req.error)
        t.oncomplete = () => db.close()
      }),
  )
}

/**
 * A stable id for a handle.
 *
 * There is no path to key on — the API deliberately does not expose one — so
 * two files with the same name in different folders are indistinguishable by
 * name alone. `isSameEntry` is the only authoritative comparison the platform
 * offers, so the id is a cheap bucket and `find` does the real check.
 */
const keyFor = (name: string) => `${name}`

/** Every remembered deck, most recently opened first. */
export async function list(): Promise<RecentEntry[]> {
  try {
    const all = await tx<RecentEntry[]>('readonly', (s) => s.getAll() as IDBRequest<RecentEntry[]>)
    return all.sort((a, b) => b.lastOpened - a.lastOpened)
  } catch {
    return [] // a blocked or unavailable IndexedDB is not fatal to a launcher
  }
}

/** The existing entry for this handle, by the platform's own identity check. */
export async function find(handle: FileSystemFileHandle): Promise<RecentEntry | null> {
  for (const e of await list()) {
    try {
      if (await e.handle.isSameEntry(handle)) return e
    } catch {
      /* a dead handle cannot match */
    }
  }
  return null
}

/** Record (or refresh) a deck. Returns the stored entry. */
export async function remember(
  handle: FileSystemFileHandle,
  meta: { title?: string; app?: string; size?: number } = {},
): Promise<RecentEntry> {
  const existing = await find(handle)
  const entry: RecentEntry = {
    id: existing?.id ?? `${keyFor(handle.name)}:${crypto.randomUUID()}`,
    handle,
    name: handle.name,
    title: meta.title ?? existing?.title,
    app: meta.app ?? existing?.app,
    size: meta.size ?? existing?.size,
    lastOpened: Date.now(),
  }
  await tx('readwrite', (s) => s.put(entry))
  return entry
}

export async function forget(id: string): Promise<void> {
  await tx('readwrite', (s) => s.delete(id))
}

export async function clear(): Promise<void> {
  await tx('readwrite', (s) => s.clear())
}

/**
 * What state is this entry in, without prompting for anything.
 *
 * `queryPermission` never prompts, so this is safe to call for the whole list
 * on load. A handle whose file has gone reports `missing` — `getFile()` throws
 * `NotFoundError` — which is the case worth showing rather than hiding.
 */
export async function stateOf(entry: RecentEntry): Promise<EntryState> {
  try {
    const perm = await entry.handle.queryPermission({ mode: 'readwrite' })
    if (perm === 'granted') {
      // granted, but the file may still have been deleted since
      await entry.handle.getFile()
      return 'granted'
    }
    return 'needs-permission'
  } catch {
    return 'missing'
  }
}

/**
 * Ask for write access. MUST be called inside a user gesture — the browser
 * refuses otherwise, and refuses silently enough that it looks like a bug.
 */
export async function grant(entry: RecentEntry): Promise<EntryState> {
  try {
    const perm = await entry.handle.requestPermission({ mode: 'readwrite' })
    if (perm !== 'granted') return 'needs-permission'
    await entry.handle.getFile()
    return 'granted'
  } catch {
    return 'missing'
  }
}

/**
 * Ask the browser not to evict this origin's storage.
 *
 * Granted far more readily to an installed app than an ordinary tab, which is
 * the second reason home offers installation (the first being double-click).
 * The answer is returned rather than logged because the user deserves to know
 * their recents list is on borrowed time.
 */
export async function requestPersistence(): Promise<boolean> {
  try {
    if (await navigator.storage?.persisted?.()) return true
    return (await navigator.storage?.persist?.()) ?? false
  } catch {
    return false
  }
}
