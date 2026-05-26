import React, { useEffect, useState } from 'react'
import { db, NoteEntry } from '../core/db'
import { encryptString, decryptToString, encryptData, uint8ToBase64, base64ToUint8, decryptData } from '../core/crypto'
import { notifyDbChanged } from '../core/db'
import { useNotes } from '../hooks/useNotes'

export default function NotesView({ masterKey }: { masterKey: CryptoKey }) {
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const notes = useNotes()

  const [selectedImageIds, setSelectedImageIds] = useState<string[]>([])

  async function handleAddImage(file: File) {
    const ab = await file.arrayBuffer()
    const { cipher, iv } = await encryptData(masterKey, ab)
    const id = crypto.randomUUID()
    await db.images.add({ id, data: cipher.buffer, iv: uint8ToBase64(iv), createdAt: Date.now() })
    notifyDbChanged('local')
    setSelectedImageIds((s) => [...s, id])
    return id
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    const { cipher, iv } = await encryptString(masterKey, body)
    const id = crypto.randomUUID()
    const entry: NoteEntry = { id, title, body: cipher.buffer, iv: uint8ToBase64(iv), imageIds: selectedImageIds, updatedAt: Date.now() }
    await db.notes.add(entry)
    notifyDbChanged('local')
    setTitle('')
    setBody('')
    setSelectedImageIds([])
  }

  async function handleRemoveSelectedImage(imageId: string) {
    const image = await db.images.get(imageId)
    if (image) {
      await db.images.delete(imageId)
    }
    setSelectedImageIds((current) => current.filter((id) => id !== imageId))
    notifyDbChanged('local')
  }

  return (
    <div className="min-h-screen px-4 py-6 sm:px-6 lg:px-8 bg-gradient-to-b from-gray-50 to-white">
      <div className="max-w-6xl mx-auto space-y-6">
        <div className="rounded-3xl border bg-white shadow-sm p-4 sm:p-6">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between mb-5">
            <div>
              <h2 className="text-3xl font-semibold text-gray-900">Tus notas</h2>
              <p className="text-sm text-gray-600 mt-1">Texto enriquecido en Markdown e imágenes cifradas localmente.</p>
            </div>
            <div className="text-sm text-gray-500">{notes.length} nota{notes.length === 1 ? '' : 's'}</div>
          </div>

          <form onSubmit={handleSave} className="space-y-4">
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Título"
              className="w-full rounded-2xl border border-gray-200 bg-gray-50 px-4 py-3 outline-none focus:border-blue-500 focus:bg-white"
            />
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Escribe tu nota en Markdown..."
              className="w-full rounded-2xl border border-gray-200 bg-gray-50 px-4 py-3 outline-none focus:border-blue-500 focus:bg-white h-32"
            />

            <div className="flex flex-wrap items-center gap-3">
              <label className="inline-flex items-center gap-2 rounded-xl border border-dashed border-gray-300 px-4 py-3 bg-white text-sm text-gray-700 cursor-pointer hover:border-blue-400 hover:text-blue-700 transition">
                <input
                  type="file"
                  className="hidden"
                  accept="image/*"
                  onChange={async (ev) => {
                    const f = ev.target.files?.[0]
                    if (f) {
                      await handleAddImage(f)
                    }
                  }}
                />
                <span>Agregar imagen</span>
              </label>
              <button className="px-5 py-3 bg-blue-600 text-white rounded-xl font-medium hover:bg-blue-700 transition shadow-sm">
                Guardar nota
              </button>
            </div>

            {selectedImageIds.length > 0 && (
              <div className="rounded-2xl border border-gray-200 bg-gray-50 p-4">
                <p className="text-sm font-medium text-gray-700 mb-3">Imágenes adjuntas</p>
                <div className="flex flex-wrap gap-3">
                    {selectedImageIds.map((imageId) => (
                      <SelectedImageChip key={imageId} imageId={imageId} masterKey={masterKey} onRemove={handleRemoveSelectedImage} />
                  ))}
                </div>
              </div>
            )}
          </form>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          {notes.length === 0 ? (
            <div className="rounded-3xl border border-dashed bg-white p-8 text-center text-gray-500 lg:col-span-2">
              Aún no hay notas. Crea la primera arriba.
            </div>
          ) : (
            notes.map((n) => <NoteItem key={n.id} note={n} masterKey={masterKey} />)
          )}
        </div>
      </div>
    </div>
  )
}

function NoteItem({ note, masterKey }: { note: NoteEntry; masterKey: CryptoKey }) {
  const [text, setText] = useState<string | null>(null)
  const [images, setImages] = useState<string[]>([])

  useEffect(() => {
    let mounted = true
    ;(async () => {
      try {
        const ivBytes = base64ToUint8(note.iv)
        const plain = await decryptToString(masterKey, note.body, ivBytes)
        if(mounted) setText(plain)
      } catch(e) {
        setText('[No se puede descifrar]')
      }
    })()
    return ()=>{ mounted=false }
  }, [note, masterKey])

  useEffect(()=>{
    let mounted = true
    ;(async ()=>{
      if(!note.imageIds || note.imageIds.length===0) return
      const urls: string[] = []
      for(const id of note.imageIds){
        const img = await db.images.get(id)
        if(!img) continue
        try{
          const iv = base64ToUint8(img.iv)
          const plain = await decryptData(masterKey, img.data, iv)
          const blob = new Blob([plain.buffer], { type: 'application/octet-stream' })
          urls.push(URL.createObjectURL(blob))
        }catch(e){ }
      }
      if(mounted) setImages(urls)
    })()
    return ()=>{ mounted=false }
  }, [note, masterKey])

  useEffect(() => {
    return () => {
      images.forEach((src) => URL.revokeObjectURL(src))
    }
  }, [images])

  async function handleDeleteNote() {
    const confirmed = window.confirm(`¿Eliminar la nota "${note.title || 'Sin título'}"?`)
    if (!confirmed) return

    await db.notes.delete(note.id)
    for (const imageId of note.imageIds ?? []) {
      await db.images.delete(imageId)
    }
    notifyDbChanged('local')
  }

  return (
    <article className="rounded-3xl border bg-white shadow-sm p-4 sm:p-5 flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold text-lg text-gray-900">{note.title || 'Sin título'}</h3>
          <p className="text-xs text-gray-500 mt-1">Actualizada {new Date(note.updatedAt).toLocaleString()}</p>
        </div>
        <button
          onClick={handleDeleteNote}
          className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-100 transition"
        >
          Borrar
        </button>
      </div>
      <div className="prose prose-sm max-w-none text-gray-800 whitespace-pre-wrap">{text}</div>
      {images.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2">
          {images.map((src) => (
            <img key={src} src={src} className="w-full rounded-2xl border object-cover max-h-56" />
          ))}
        </div>
      )}
    </article>
  )
}

function SelectedImageChip({ imageId, masterKey, onRemove }: { imageId: string; masterKey: CryptoKey; onRemove: (imageId: string) => Promise<void> }) {
  const [src, setSrc] = useState<string | null>(null)

  useEffect(() => {
    let mounted = true
    ;(async () => {
      const image = await db.images.get(imageId)
      if (!image) return
      try {
        const ivBytes = base64ToUint8(image.iv)
        const plain = await decryptData(masterKey, image.data, ivBytes)
        const blob = new Blob([plain.buffer], { type: 'application/octet-stream' })
        const url = URL.createObjectURL(blob)
        if (mounted) setSrc(url)
        else URL.revokeObjectURL(url)
      } catch {
        if (mounted) setSrc(null)
      }
    })()

    return () => {
      mounted = false
      if (src) URL.revokeObjectURL(src)
    }
  }, [imageId, masterKey])

  return (
    <div className="relative w-24 h-24 rounded-2xl overflow-hidden border bg-white group">
      {src ? <img src={src} alt="Adjunta" className="w-full h-full object-cover" /> : <div className="w-full h-full bg-gray-200" />}
      <button
        type="button"
        onClick={() => onRemove(imageId)}
        className="absolute top-2 right-2 rounded-full bg-black/70 text-white w-7 h-7 text-sm opacity-90 group-hover:opacity-100"
        aria-label="Eliminar imagen"
      >
        ×
      </button>
    </div>
  )
}
