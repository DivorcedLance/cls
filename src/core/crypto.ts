
const enc = new TextEncoder()
const dec = new TextDecoder()

export async function deriveKeyFromPassword(password: string, salt?: Uint8Array) {
  const pwKey = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey'])
  const usedSalt = salt ?? crypto.getRandomValues(new Uint8Array(16))
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: usedSalt, iterations: 200_000, hash: 'SHA-256' },
    pwKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
  return { key, salt: usedSalt }
}

export async function encryptData(key: CryptoKey, data: ArrayBuffer) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data)
  return { cipher: new Uint8Array(cipher), iv: new Uint8Array(iv) }
}

export async function decryptData(key: CryptoKey, cipher: ArrayBuffer, iv: Uint8Array) {
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher)
  return new Uint8Array(plain)
}

export async function encryptString(key: CryptoKey, text: string) {
  const data = enc.encode(text)
  const { cipher, iv } = await encryptData(key, data.buffer)
  return { cipher, iv }
}

export async function decryptToString(key: CryptoKey, cipher: ArrayBuffer, iv: Uint8Array) {
  const plain = await decryptData(key, cipher, iv)
  return dec.decode(plain)
}

export function uint8ToBase64(u8: Uint8Array) {
  let binary = ''
  for (let i = 0; i < u8.length; i++) binary += String.fromCharCode(u8[i])
  return btoa(binary)
}

export function base64ToUint8(s: string) {
  const bin = atob(s)
  const arr = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
  return arr
}

export function arrayBufferToBase64(ab: ArrayBuffer) {
  return uint8ToBase64(new Uint8Array(ab))
}

export function base64ToArrayBuffer(b64: string) {
  const u8 = base64ToUint8(b64)
  return u8.buffer
}
