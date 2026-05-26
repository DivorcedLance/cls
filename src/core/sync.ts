import LZString from 'lz-string'
import { arrayBufferToBase64, base64ToArrayBuffer, decryptData, decryptToString, encryptData, encryptString, uint8ToBase64, base64ToUint8 } from './crypto'
import { db, notifyDbChanged, ImageEntry, NoteEntry, ensureDbReady } from './db'

const CHUNK_SIZE = 12_000

interface SerializableImageEntry extends Omit<ImageEntry, 'data'> {
  data: string
}

interface SerializableNoteEntry extends Omit<NoteEntry, 'body'> {
  body: string
}

interface SyncPayload {
  version: 1
  notes: SerializableNoteEntry[]
  images: SerializableImageEntry[]
  updatedAt: number
}

interface ChunkMessage {
  type: 'sync/control' | 'sync/snapshot-single' | 'sync/snapshot-start' | 'sync/snapshot-chunk' | 'sync/snapshot-end' | 'sync/ack'
  id: string
  payload?: string
  total?: number
  index?: number
  chunk?: string
  signature?: string
  received?: number
  authority?: 'a' | 'b'
}

interface SnapshotAssembly {
  total: number
  chunks: string[]
  received: number
}

interface SyncContext {
  masterKey: CryptoKey
}

export async function createSyncPayload(context: SyncContext) {
  await ensureDbReady()
  const [notes, images] = await Promise.all([db.notes.toArray(), db.images.toArray()])
  const payload: SyncPayload = {
    version: 1,
    notes: await Promise.all(notes.map((note) => serializeNote(note, context.masterKey))),
    images: await Promise.all(images.map((image) => serializeImage(image, context.masterKey))),
    updatedAt: Date.now(),
  }
  return LZString.compressToEncodedURIComponent(JSON.stringify(payload))
}

export async function createPayloadSignature(payload: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload))
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('')
}

export async function applySyncPayload(serialized: string, context: SyncContext) {
  return applySyncPayloadWithOptions(serialized, context)
}

export async function applySyncPayloadWithOptions(
  serialized: string,
  context: SyncContext,
  options?: { replaceExisting?: boolean }
) {
  await ensureDbReady()
  const json = LZString.decompressFromEncodedURIComponent(serialized)
  if (!json) throw new Error('No se pudo desempaquetar la sincronización')

  const payload = JSON.parse(json) as SyncPayload
  if (payload.version !== 1) throw new Error('Versión de sincronización no soportada')

  await db.transaction('rw', db.images, db.notes, async () => {
    if (options?.replaceExisting) {
      await db.images.clear()
      await db.notes.clear()
    }

    for (const image of payload.images) {
      await mergeImage(await deserializeImage(image, context.masterKey))
    }

    for (const note of payload.notes) {
      await mergeNote(await deserializeNote(note, context.masterKey))
    }
  })

  notifyDbChanged('remote')
}

export async function sendSyncSnapshot(
  channel: RTCDataChannel,
  context: SyncContext,
  options?: {
    onProgress?: (received: number, total: number) => void
    skipIfSignature?: string
  }
) {
  const payload = await createSyncPayload(context)
  const signature = await createPayloadSignature(payload)
  if (options?.skipIfSignature && options.skipIfSignature === signature) {
    return { signature, skipped: true }
  }

  const messageId = crypto.randomUUID()

  if (payload.length <= CHUNK_SIZE) {
    const message: ChunkMessage = {
      type: 'sync/snapshot-single',
      id: messageId,
      payload,
      signature,
    }
    channel.send(JSON.stringify(message))
    options?.onProgress?.(1, 1)
    return { signature, skipped: false }
  }

  const total = Math.ceil(payload.length / CHUNK_SIZE)
  const start: ChunkMessage = { type: 'sync/snapshot-start', id: messageId, total, signature }
  channel.send(JSON.stringify(start))
  options?.onProgress?.(0, total)

  for (let index = 0; index < total; index++) {
    const chunk = payload.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE)
    const part: ChunkMessage = { type: 'sync/snapshot-chunk', id: messageId, index, chunk, signature }
    channel.send(JSON.stringify(part))
    options?.onProgress?.(index + 1, total)
  }

  const end: ChunkMessage = { type: 'sync/snapshot-end', id: messageId, total, signature }
  channel.send(JSON.stringify(end))
  return { signature, skipped: false }
}

export function createSyncMessageHandler(
  channel: RTCDataChannel,
  context: SyncContext,
  onLog: (text: string) => void,
  onProgress?: (received: number, total: number) => void,
  onConfirmed?: (signature: string) => void,
  onControl?: (authority: 'a' | 'b') => void,
) {
  const assemblies = new Map<string, SnapshotAssembly>()

  return async (event: MessageEvent) => {
    let message: ChunkMessage | null = null

    try {
      message = JSON.parse(String(event.data)) as ChunkMessage
    } catch {
      return
    }

    if (message.type === 'sync/control' && message.authority) {
      onLog(message.authority === 'a' ? 'Prioridad de A activada' : 'Prioridad de B activada')
      onControl?.(message.authority)
      return
    }

    if (message.type === 'sync/snapshot-single' && message.payload) {
      onLog('Snapshot recibido en un solo mensaje')
      onProgress?.(1, 1)
      await applySyncPayloadWithOptions(message.payload, context, { replaceExisting: true })
      if (message.signature) {
        channel.send(JSON.stringify({ type: 'sync/ack', id: message.id, signature: message.signature, received: 1 }))
      }
      return
    }

    if (message.type === 'sync/snapshot-start' && message.total) {
      assemblies.set(message.id, { total: message.total, chunks: new Array(message.total), received: 0 })
      onLog(`Iniciando recepción de snapshot (${message.total} partes)`)
      onProgress?.(0, message.total)
      return
    }

    if (message.type === 'sync/snapshot-chunk' && typeof message.index === 'number' && message.chunk) {
      const assembly = assemblies.get(message.id)
      if (!assembly) return
      if (!assembly.chunks[message.index]) {
        assembly.received += 1
      }
      assembly.chunks[message.index] = message.chunk
      onProgress?.(assembly.received, assembly.total)

      if (assembly.received === assembly.total) {
        assemblies.delete(message.id)
        const payload = assembly.chunks.join('')
        onLog('Snapshot reconstruido, aplicando cambios...')
        await applySyncPayloadWithOptions(payload, context, { replaceExisting: true })
        if (message.signature) {
          channel.send(JSON.stringify({ type: 'sync/ack', id: message.id, signature: message.signature, received: assembly.total }))
        }
      }
      return
    }

    if (message.type === 'sync/snapshot-end') {
      const assembly = assemblies.get(message.id)
      if (!assembly) return
      if (assembly.received === assembly.total) {
        assemblies.delete(message.id)
        const payload = assembly.chunks.join('')
        onLog('Snapshot completo recibido, aplicando cambios...')
        await applySyncPayloadWithOptions(payload, context, { replaceExisting: true })
        if (message.signature) {
          channel.send(JSON.stringify({ type: 'sync/ack', id: message.id, signature: message.signature, received: assembly.total }))
        }
      }
      return
    }

    if (message.type === 'sync/ack' && message.signature) {
      onLog('Sincronización confirmada por la otra ventana')
      onConfirmed?.(message.signature)
    }
  }
}

async function mergeImage(image: ImageEntry) {
  const existing = await db.images.get(image.id)
  if (!existing || existing.createdAt <= image.createdAt) {
    await db.images.put(image)
  }
}

async function mergeNote(note: NoteEntry) {
  const existing = await db.notes.get(note.id)
  if (!existing || existing.updatedAt <= note.updatedAt) {
    await db.notes.put(note)
  }
}

async function serializeImage(image: ImageEntry, masterKey: CryptoKey): Promise<SerializableImageEntry> {
  const plain = await decryptData(masterKey, image.data, base64ToUint8(image.iv))
  return {
    ...image,
    data: arrayBufferToBase64(plain.buffer),
  }
}

async function serializeNote(note: NoteEntry, masterKey: CryptoKey): Promise<SerializableNoteEntry> {
  const plain = await decryptToString(masterKey, note.body, base64ToUint8(note.iv))
  return {
    ...note,
    body: plain,
  }
}

async function deserializeImage(image: SerializableImageEntry, masterKey: CryptoKey): Promise<ImageEntry> {
  const plain = base64ToArrayBuffer(image.data)
  const { cipher, iv } = await encryptData(masterKey, plain)
  return {
    ...image,
    data: cipher.buffer,
    iv: uint8ToBase64(iv),
  }
}

async function deserializeNote(note: SerializableNoteEntry, masterKey: CryptoKey): Promise<NoteEntry> {
  const { cipher, iv } = await encryptString(masterKey, note.body)
  return {
    ...note,
    body: cipher.buffer,
    iv: uint8ToBase64(iv),
  }
}