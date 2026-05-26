import Dexie, { Table } from 'dexie'

export interface ImageEntry {
  id: string
  data: ArrayBuffer // encrypted blob
  iv: string // base64
  createdAt: number
}

export interface NoteEntry {
  id: string
  title: string
  body: ArrayBuffer // encrypted
  iv: string // base64
  imageIds: string[]
  updatedAt: number
}

export interface MetaEntry {
  key: string
  value: any
}

class AppDB extends Dexie {
  images!: Table<ImageEntry, string>
  notes!: Table<NoteEntry, string>
  meta!: Table<MetaEntry, string>

  constructor() {
    super('cls-notes-db')
    this.version(1).stores({ images: 'id,createdAt', notes: 'id,updatedAt' })
    this.version(2).stores({ images: 'id,createdAt', notes: 'id,updatedAt', meta: 'key' })
  }
}

export const db = new AppDB()

export async function ensureDbReady() {
  await db.open()
}

export async function setMeta(key: string, value: any) {
  await db.meta.put({ key, value })
}

export async function getMeta<T = any>(key: string): Promise<T | undefined> {
  const r = await db.meta.get(key)
  return r?.value as T | undefined
}

export async function clearAllData() {
  await ensureDbReady()
  await db.transaction('rw', db.images, db.notes, db.meta, async () => {
    await db.images.clear()
    await db.notes.clear()
    await db.meta.clear()
  })
}

export type DbChangeSource = 'local' | 'remote'

export function notifyDbChanged(source: DbChangeSource = 'local') {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent('cls:db-changed', { detail: { source } }))
}

export function subscribeDbChanged(listener: (source: DbChangeSource) => void) {
  if (typeof window === 'undefined') return () => {}
  const handler = (event: Event) => {
    const custom = event as CustomEvent<{ source?: DbChangeSource }>
    listener(custom.detail?.source ?? 'local')
  }
  window.addEventListener('cls:db-changed', handler)
  return () => window.removeEventListener('cls:db-changed', handler)
}
