import React, { useRef, useState } from 'react'
import { useStorageQuota } from '../hooks/useStorageQuota'
import { createEncryptedBackup, restoreEncryptedBackup } from '../core/backup'
import { deriveKeyFromPassword } from '../core/crypto'
import { clearAllData } from '../core/db'

type SettingsModalProps = {
  open: boolean
  masterKey: CryptoKey
  salt: Uint8Array | null
  onClose: () => void
  onOpenSync: (mode: 'create' | 'sync') => void
  onLogout: () => void
}

export default function SettingsModal({ open, masterKey, salt, onClose, onOpenSync, onLogout }: SettingsModalProps) {
  const [exportBusy, setExportBusy] = useState(false)
  const [importBusy, setImportBusy] = useState(false)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [importPassword, setImportPassword] = useState('')
  const [deletePassword, setDeletePassword] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [selectedFileText, setSelectedFileText] = useState<string | null>(null)

  if (!open) return null

  async function handleExport() {
    if (!salt) {
      setMessage('No se pudo leer la sal de la sesión.')
      return
    }

    setExportBusy(true)
    setMessage(null)
    try {
      const backup = await createEncryptedBackup(masterKey, salt)
      const blob = new Blob([backup], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `cls-backup-${new Date().toISOString().slice(0, 10)}.json`
      anchor.click()
      URL.revokeObjectURL(url)
      setMessage('Backup exportado correctamente.')
    } catch (error) {
      setMessage(`Error al exportar: ${String(error)}`)
    } finally {
      setExportBusy(false)
    }
  }

  function openImportPicker() {
    fileInputRef.current?.click()
  }

  async function handleImportFile(file?: File) {
    if (!file) return
    setImportBusy(true)
    setMessage(null)
    try {
      const text = await file.text()
      setSelectedFileText(text)
      if (!importPassword) {
        setMessage('Escribe la contraseña del backup para importarlo.')
        return
      }
      await restoreEncryptedBackup(text, importPassword, { masterKey })
      setMessage('Backup importado y aplicado en esta sesión.')
      setImportPassword('')
      setSelectedFileText(null)
    } catch (error) {
      setMessage(`No se pudo importar: ${String(error)}`)
    } finally {
      setImportBusy(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  async function handleImportSubmit() {
    if (!selectedFileText) {
      setMessage('Primero selecciona un archivo de backup.')
      return
    }
    setImportBusy(true)
    setMessage(null)
    try {
      await restoreEncryptedBackup(selectedFileText, importPassword, { masterKey })
      setMessage('Backup importado y aplicado en esta sesión.')
      setImportPassword('')
      setSelectedFileText(null)
    } catch (error) {
      setMessage(`No se pudo importar: ${String(error)}`)
    } finally {
      setImportBusy(false)
    }
  }

  async function handleDeleteAll() {
    if (!salt) {
      setMessage('No se pudo verificar la contraseña.')
      return
    }

    if (!deletePassword.trim()) {
      setMessage('Escribe la contraseña para borrar los datos.')
      return
    }

    setDeleteBusy(true)
    setMessage(null)
    try {
      const storedSalt = salt
      const candidate = await deriveKeyFromPassword(deletePassword, storedSalt)
      const challenge = crypto.getRandomValues(new Uint8Array(16))
      const challengeCipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: new Uint8Array(12).fill(7) }, masterKey, challenge)
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(12).fill(7) }, candidate.key, challengeCipher)
      await clearAllData()
      setMessage('Todos los datos se eliminaron correctamente.')
      setDeletePassword('')
      onLogout()
      onClose()
    } catch (error) {
      setMessage('La contraseña no coincide.')
      console.error(error)
    } finally {
      setDeleteBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 p-0 sm:p-6 flex items-end sm:items-center justify-center overflow-y-auto">
      <div className="w-full h-[100dvh] sm:h-auto max-w-3xl rounded-none sm:rounded-3xl bg-white shadow-2xl border overflow-hidden max-h-[100dvh] sm:max-h-[92vh] overflow-y-auto">
        <div className="sticky top-0 z-10 flex items-center justify-between px-4 sm:px-5 py-4 border-b bg-gray-50/95 backdrop-blur">
          <div>
            <h3 className="text-lg font-semibold text-gray-900">Configuración</h3>
            <p className="text-sm text-gray-600">Exporta, importa, sincroniza o borra la sesión.</p>
          </div>
          <button className="rounded-full border px-3 py-2 text-sm" onClick={onClose}>Cerrar</button>
        </div>

        <div className="grid gap-4 p-4 sm:p-5 sm:grid-cols-2">
          <section className="rounded-2xl border bg-white p-4 space-y-3">
            <h4 className="font-semibold text-gray-900">Backup cifrado</h4>
            <p className="text-sm text-gray-600">Descarga toda la sesión en un archivo cifrado. Solo podrás importarlo con la contraseña original del backup.</p>
            <button
              className="w-full rounded-xl bg-blue-600 px-4 py-3 text-white font-medium disabled:opacity-50"
              onClick={handleExport}
              disabled={exportBusy || !salt}
            >
              {exportBusy ? 'Exportando...' : 'Exportar sesión'}
            </button>
          </section>

          <section className="rounded-2xl border bg-white p-4 space-y-3">
            <h4 className="font-semibold text-gray-900">Importar backup</h4>
            <p className="text-sm text-gray-600">Carga un archivo y escribe la contraseña original del backup para restaurarlo en esta sesión.</p>
            <button className="w-full rounded-xl border px-4 py-3 font-medium" onClick={openImportPicker} disabled={importBusy}>
              Seleccionar archivo
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/json"
              className="hidden"
              onChange={(event) => handleImportFile(event.target.files?.[0])}
            />
            <input
              value={importPassword}
              onChange={(e) => setImportPassword(e.target.value)}
              type="password"
              placeholder="Contraseña del backup"
              className="w-full rounded-xl border px-4 py-3 outline-none focus:border-blue-500"
            />
            <button
              className="w-full rounded-xl bg-emerald-600 px-4 py-3 text-white font-medium disabled:opacity-50"
              onClick={handleImportSubmit}
              disabled={importBusy || !selectedFileText}
            >
              {importBusy ? 'Importando...' : 'Importar backup'}
            </button>
          </section>

          <section className="rounded-2xl border bg-white p-4 space-y-3 sm:col-span-2">
            <h4 className="font-semibold text-gray-900">Sincronización</h4>
            <p className="text-sm text-gray-600">Elige el flujo que quieras usar.</p>
            <div className="grid gap-2 sm:grid-cols-2">
              <button className="w-full rounded-xl bg-gray-900 px-4 py-3 text-white font-medium" onClick={() => onOpenSync('create')}>
                Crear sincronización
              </button>
              <button className="w-full rounded-xl border px-4 py-3 font-medium bg-white" onClick={() => onOpenSync('sync')}>
                Sincronizar
              </button>
            </div>
          </section>

          <section className="rounded-2xl border bg-white p-4 space-y-3 sm:col-span-2">
            <h4 className="font-semibold text-gray-900">Borrar sesión</h4>
            <p className="text-sm text-gray-600">Esto eliminará notas, imágenes y metadatos locales. Se pedirá confirmación con tu contraseña.</p>
            <div className="flex flex-col gap-3 sm:flex-row">
              <input
                value={deletePassword}
                onChange={(e) => setDeletePassword(e.target.value)}
                type="password"
                placeholder="Confirma tu contraseña"
                className="flex-1 rounded-xl border px-4 py-3 outline-none focus:border-red-500"
              />
              <button
                className="rounded-xl bg-red-600 px-4 py-3 text-white font-medium disabled:opacity-50"
                onClick={handleDeleteAll}
                disabled={deleteBusy}
              >
                {deleteBusy ? 'Borrando...' : 'Borrar todo'}
              </button>
            </div>
          </section>
        </div>

        {message && <div className="px-4 sm:px-5 pb-5 text-sm text-gray-700">{message}</div>}

        {/* Storage usage at bottom of Settings */}
        <div className="px-4 sm:px-5 pb-6">
          <StorageInfo />
        </div>
      </div>
    </div>
  )
}

function formatBytes(value: number) {
  if (!value) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let index = 0
  let size = value
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024
    index += 1
  }
  return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[index]}`
}

function StorageInfo() {
  const quota = useStorageQuota()
  return (
    <div className="rounded-2xl border bg-white p-3 text-sm">
      <div className="font-medium text-gray-900">Almacenamiento</div>
      <div className="text-gray-700">{formatBytes(quota.usage)} usados de {formatBytes(quota.quota)}</div>
      <div className="text-gray-600">{Math.round(quota.usageRatio * 100)}% en uso</div>
    </div>
  )
}