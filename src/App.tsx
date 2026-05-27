import React, { useState } from 'react'
import { deriveKeyFromPassword, base64ToUint8, uint8ToBase64 } from './core/crypto'
import { getMeta, setMeta } from './core/db'
import NotesView from './components/NotesView'
import SyncView from './components/SyncView'
import { useStorageQuota } from './hooks/useStorageQuota'
import SettingsModal from './components/SettingsModal'

export default function App() {
  const [masterKey, setMasterKey] = useState<CryptoKey | null>(null)
  const [salt, setSalt] = useState<Uint8Array | null>(null)
  const [syncOpen, setSyncOpen] = useState(false)
  const [syncMode, setSyncMode] = useState<'create' | 'sync'>('create')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const quota = useStorageQuota()

  async function handleUnlock(password: string) {
    const stored = await getMeta<string>('salt')
    if (stored) {
      const s = base64ToUint8(stored)
      const { key } = await deriveKeyFromPassword(password, s)
      setMasterKey(key)
      setSalt(s)
    } else {
      const { key, salt: s } = await deriveKeyFromPassword(password)
      await setMeta('salt', uint8ToBase64(s))
      setMasterKey(key)
      setSalt(s)
    }
  }

  if (!masterKey) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-50 via-white to-slate-100 px-4 py-8">
        <div className="p-6 sm:p-8 bg-white rounded-3xl shadow-xl w-full max-w-md border">
          <h1 className="text-2xl font-semibold mb-2 text-gray-900">CLS Notes</h1>
          <p className="text-sm text-gray-600 mb-6">Desbloquea la sesión local para entrar.</p>
          <UnlockForm onUnlock={handleUnlock} />
        </div>
      </div>
    )
  }
  return (
    <div className="min-h-screen bg-gray-50">
      <header className="sticky top-0 z-20 border-b bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
          <div>
            <h1 className="text-lg font-semibold text-gray-900">CLS Notes</h1>
            <p className="text-xs text-gray-500">Privacidad local, notas cifradas y sync P2P</p>
          </div>
          <div className="flex justify-end">
            <button className="w-full rounded-xl border px-3 py-2 text-sm font-medium bg-white sm:w-auto" onClick={() => setSettingsOpen(true)}>Configuración</button>
          </div>
        </div>
      </header>
      <NotesView masterKey={masterKey} salt={salt} />
      <div className="fixed bottom-3 left-3 right-3 sm:left-auto sm:right-4 sm:bottom-4 bg-white border rounded-2xl shadow-lg px-4 py-3 text-sm text-gray-700 max-w-none sm:max-w-xs">
        <div className="font-medium text-gray-900">Almacenamiento</div>
        <div>{formatBytes(quota.usage)} usados de {formatBytes(quota.quota)}</div>
        <div>{Math.round(quota.usageRatio * 100)}% en uso</div>
      </div>
      {settingsOpen && masterKey && salt && (
        <SettingsModal
          open={settingsOpen}
          masterKey={masterKey}
          salt={salt}
          onClose={() => setSettingsOpen(false)}
          onOpenSync={(mode) => {
            setSettingsOpen(false)
            setSyncMode(mode)
            setSyncOpen(true)
          }}
          onLogout={() => {
            setMasterKey(null)
            setSalt(null)
            setSyncOpen(false)
            setSettingsOpen(false)
          }}
        />
      )}
      {syncOpen && masterKey && <SyncView masterKey={masterKey} onClose={()=>setSyncOpen(false)} initialMode={syncMode} />}
    </div>
  )
}

function UnlockForm({ onUnlock }: { onUnlock: (pw: string) => void }) {
  const [pw, setPw] = useState('')
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        onUnlock(pw)
        setPw('')
      }}
    >
      <label className="block mb-2">Contraseña maestra</label>
      <input
        value={pw}
        onChange={(e) => setPw(e.target.value)}
        type="password"
        className="w-full rounded-2xl border border-gray-200 bg-gray-50 px-4 py-3 outline-none focus:border-blue-500 focus:bg-white mb-4"
      />
      <button className="w-full rounded-2xl bg-blue-600 px-4 py-3 text-white font-medium hover:bg-blue-700 transition">Desbloquear</button>
    </form>
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
