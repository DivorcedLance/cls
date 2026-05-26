import { applySyncPayloadWithOptions, createSyncPayload } from './sync'
import { arrayBufferToBase64, base64ToArrayBuffer, decryptData, encryptData, uint8ToBase64, base64ToUint8, deriveKeyFromPassword } from './crypto'

const enc = new TextEncoder()
const dec = new TextDecoder()

export interface BackupEnvelope {
  version: 1
  salt: string
  iv: string
  payload: string
}

interface SyncContext {
  masterKey: CryptoKey
}

export async function createEncryptedBackup(masterKey: CryptoKey, salt: Uint8Array) {
  const payload = await createSyncPayload({ masterKey })
  const { cipher, iv } = await encryptData(masterKey, enc.encode(payload).buffer)

  const envelope: BackupEnvelope = {
    version: 1,
    salt: uint8ToBase64(salt),
    iv: uint8ToBase64(iv),
    payload: arrayBufferToBase64(cipher.buffer),
  }

  return JSON.stringify(envelope)
}

export async function restoreEncryptedBackup(fileText: string, password: string, context: SyncContext) {
  const envelope = JSON.parse(fileText) as BackupEnvelope

  if (!envelope || envelope.version !== 1) {
    throw new Error('Backup inválido')
  }

  const exportKey = await deriveKeyFromPassword(password, base64ToUint8(envelope.salt))
  const plain = await decryptData(
    exportKey.key,
    base64ToArrayBuffer(envelope.payload),
    base64ToUint8(envelope.iv)
  )

  const payload = dec.decode(plain)
  await applySyncPayloadWithOptions(payload, context, { replaceExisting: true })
}