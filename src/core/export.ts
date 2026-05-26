import { db } from './db'
import { ensureDbReady } from './db'

// Export entire DB as a JSON structure (encrypted at higher layer)
export async function dumpAllData() {
  await ensureDbReady()
  const images = await db.images.toArray()
  const notes = await db.notes.toArray()
  return { images, notes }
}

export async function importAllData(payload: { images: any[]; notes: any[] }) {
  await ensureDbReady()
  await db.transaction('rw', db.images, db.notes, async () => {
    await db.images.clear()
    await db.notes.clear()
    await db.images.bulkAdd(payload.images)
    await db.notes.bulkAdd(payload.notes)
  })
}
