# Arquitectura: sincronización P2P (QR + WebRTC) — CLS Notes

Este documento describe cómo funciona la sincronización entre dos instancias (A y B) usando intercambio QR + WebRTC DataChannel, y cómo se envían datos y archivos cifrados.

Resumen del flujo

- A inicia la sincronización y crea una oferta SDP comprimida.
- A muestra un QR con la oferta (o la descarga como imagen).
- B escanea el QR (o carga la imagen) y crea una respuesta (answer) comprimida.
- B comparte la respuesta con A (copiar/pegar, portapapeles, compartir nativo).
- A aplica la respuesta, se establece la conexión PeerConnection y abren `RTCDataChannel`.
- Dependiendo de la autoridad elegida (A o B), el canal coordina quién envía el snapshot.
- El snapshot es un payload comprimido (LZString) que contiene notas e imágenes serializadas y cifradas.

Componentes clave

- `src/core/p2p.ts`: helpers para crear ofertas y respuestas comprimidas.
- `src/core/sync.ts`: empaqueta la base de datos en un payload, lo firma, lo envía en chunks mediante `RTCDataChannel` y aplica payloads entrantes.
- `src/components/SyncView.tsx`: UI que orquesta la creación/escaneo de QR, selección de autoridad, progreso de envío/recepción y el resumen final.

Formato de los datos

El payload de sincronización (antes de compresión) tiene la forma:

```
interface SyncPayload {
  version: 1
  notes: Array<{ id: string; title?: string; body: string; updatedAt: number; ... }>
  images: Array<{ id: string; filename?: string; data: string (base64); updatedAt: number; ... }>
  updatedAt: number
}
```

- Las notas e imágenes se serializan desencriptando con la `masterKey` y luego incluyendo el contenido plano en el JSON; al reimportar se re-encriptan.
- El payload completo se comprime con `LZString.compressToEncodedURIComponent` para reducir tamaño y facilitar su transporte en QR/códigos largos.

Envío chunked

- Si el payload es pequeño (<= CHUNK_SIZE), se envía como `sync/snapshot-single`.
- Si es más grande, se divide en `sync/snapshot-start`, múltiples `sync/snapshot-chunk` y `sync/snapshot-end`.
- Cada chunk incluye la misma `signature` (SHA-256 del payload comprimido) para identificar y comprobar integridad.

Confirmación y aplicación

- Cuando el receptor reconstruye y aplica el payload (`applySyncPayloadWithOptions`), envía un `sync/ack` de vuelta con la `signature`.
- El remitente que recibe el `sync/ack` marca la sincronización como confirmada.

Fragmentos de código relevantes

- Crear y enviar snapshot:

```ts
// src/core/sync.ts (simplificado)
export async function sendSyncSnapshot(channel: RTCDataChannel, context: SyncContext) {
  const payload = await createSyncPayload(context)
  const signature = await createPayloadSignature(payload)
  if (payload.length <= CHUNK_SIZE) {
    channel.send(JSON.stringify({ type: 'sync/snapshot-single', id: crypto.randomUUID(), payload, signature }))
    return { signature, skipped: false }
  }
  // enviar start / chunks / end
}
```

- Receptor: ensamblaje y aplicación

```ts
// src/core/sync.ts (simplificado)
if (message.type === 'sync/snapshot-chunk') {
  // almacenar en assembly
  if (assembly.received === assembly.total) {
    const payload = assembly.chunks.join('')
    await applySyncPayloadWithOptions(payload, context, { replaceExisting: true })
    channel.send(JSON.stringify({ type: 'sync/ack', id: message.id, signature: message.signature }))
  }
}
```

UX y decisiones de diseño

- Señalización sin servidor: se eligió QR + texto (copiar/pegar) para evitar necesidad de servidor de señalización.
- No hay persistencia de reconexión: mantener sesiones requeriría un servidor de señalización o almacenamiento de ICE y reintentos, lo cual añade complejidad y riesgos de seguridad.
- Confianza y autoridad: antes de transferir, el usuario elige si su dispositivo manda o recibe (`authority`). Si B elige recibir, A manda su snapshot y B lo aplica (reemplazo o merge, según la implementación).

Seguridad

- Cifrado: la `masterKey` se deriva por PBKDF2 y se usa AES-GCM para cifrar notas e imágenes en IndexedDB.
- Transferencia: el payload se serializa desencriptado y luego la reconstrucción en el receptor es re-encriptada con la `masterKey` del receptor. Esto significa que ambos lados deben compartir la misma passphrase/clave para poder leer el contenido real.
- Integridad: se calcula SHA-256 del payload comprimido y se usa como `signature` para confirmar recepción completa.

Cómo extender / mejorar

- Añadir un servidor de señalización para reconexiones y reintentos.
- Implementar delta-sync en lugar de snapshots completos para ahorrar ancho de banda.
- Soportar streaming de archivos grandes (chunks binarios) usando `Blob` y `FileReader`.

Referencias de archivos

- `src/core/sync.ts`
- `src/core/p2p.ts`
- `src/components/SyncView.tsx`


---
Generado como guía de arquitectura para el flujo de sincronización del proyecto.
