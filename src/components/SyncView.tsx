import React, { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import QrScanner from 'qr-scanner'
import { db } from '../core/db'
import { createOfferAndCompress, setRemoteOfferAndCreateAnswer, setRemoteCompressedAnswer } from '../core/p2p'
import { createSyncMessageHandler, sendSyncSnapshot } from '../core/sync'

QrScanner.WORKER_PATH = new URL('qr-scanner/qr-scanner-worker.min.js', import.meta.url).toString()

type SyncMode = 'create' | 'sync'
type SyncStep = 'qr' | 'code' | 'progress'
type SyncAuthority = 'a' | 'b'

const qrOptions = {
  errorCorrectionLevel: 'H' as const,
  width: 900,
  margin: 3,
  color: {
    dark: '#000000',
    light: '#FFFFFF',
  },
}

const stepLabels: Array<{ id: SyncStep; label: string }> = [
  { id: 'qr', label: 'QR' },
  { id: 'code', label: 'Código' },
  { id: 'progress', label: 'Progreso' },
]

type SnapshotSummary = {
  notes: number
  images: number
  titles: string[]
}

export default function SyncView({
  masterKey,
  onClose,
  initialMode = 'create',
}: {
  masterKey: CryptoKey
  onClose?: () => void
  initialMode?: SyncMode
}) {
  const [mode] = useState<SyncMode>(initialMode)
  const [step, setStep] = useState<SyncStep>('qr')
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [sendProgress, setSendProgress] = useState({ current: 0, total: 0 })
  const [receiveProgress, setReceiveProgress] = useState({ current: 0, total: 0 })
  const [responseCode, setResponseCode] = useState('')
  const [pastedResponse, setPastedResponse] = useState('')
  const [uploadSummary, setUploadSummary] = useState<SnapshotSummary | null>(null)
  const [finalSummary, setFinalSummary] = useState<SnapshotSummary | null>(null)
  const [finalized, setFinalized] = useState(false)
  const [selectedAuthority, setSelectedAuthority] = useState<SyncAuthority | null>(null)
  const [pendingOffer, setPendingOffer] = useState('')
  const [cameraActive, setCameraActive] = useState(false)
  const [qrError, setQrError] = useState<string | null>(null)
  const pcRef = useRef<RTCPeerConnection | null>(null)
  const dcRef = useRef<RTCDataChannel | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const scannerRef = useRef<QrScanner | null>(null)
  const authorityRef = useRef<SyncAuthority | null>(null)
  const autoStartedRef = useRef(false)
  const autoAppliedRef = useRef(false)

  useEffect(() => {
    return () => {
      scannerRef.current?.destroy()
      try {
        dcRef.current?.close()
        pcRef.current?.close()
      } catch {
        // ignore cleanup errors
      }
    }
  }, [])

  useEffect(() => {
    if (mode === 'create' && !autoStartedRef.current) {
      autoStartedRef.current = true
      void createSession()
      return
    }

    if (mode === 'sync') {
      setStep('qr')
    }
  }, [mode])

  useEffect(() => {
    if (mode !== 'create' || step !== 'code') return
    if (!pastedResponse.trim() || autoAppliedRef.current) return

    const timer = window.setTimeout(() => {
      void applyPastedResponse(true)
    }, 450)

    return () => window.clearTimeout(timer)
  }, [mode, step, pastedResponse])

  async function stopCameraScanner() {
    scannerRef.current?.stop()
    scannerRef.current?.destroy()
    scannerRef.current = null
    setCameraActive(false)
  }

  async function closeSession() {
    await stopCameraScanner()
    try {
      dcRef.current?.close()
      pcRef.current?.close()
    } catch {
      // ignore cleanup errors
    }
    dcRef.current = null
    pcRef.current = null
    setStep(mode === 'create' ? 'qr' : 'qr')
    setQrDataUrl(null)
    setBusy(false)
    setSendProgress({ current: 0, total: 0 })
    setReceiveProgress({ current: 0, total: 0 })
    setResponseCode('')
    setPastedResponse('')
    setPendingOffer('')
    setUploadSummary(null)
    setFinalSummary(null)
    setFinalized(false)
    setSelectedAuthority(null)
    setQrError(null)
    authorityRef.current = null
    autoAppliedRef.current = false
  }

  function attachChannel(channel: RTCDataChannel) {
    dcRef.current = channel

    channel.onopen = () => {
      const authority = authorityRef.current
      setStep('progress')
      if (authority) {
        channel.send(JSON.stringify({ type: 'sync/control', id: crypto.randomUUID(), authority }))
        if (authority === 'b') {
          void sendCurrentSnapshot('B')
        }
      }
    }

    channel.onmessage = createSyncMessageHandler(
      channel,
      { masterKey },
      () => undefined,
      (current, total) => setReceiveProgress({ current, total }),
      () => {
        setFinalized(true)
        setStep('progress')
      },
      (authority) => {
        authorityRef.current = authority
        setStep('progress')
        if (authority === 'a') {
          void sendCurrentSnapshot('A')
        }
      },
      async () => {
        const summary = await buildSnapshotSummary()
        setFinalSummary(summary)
      }
    )
  }

  async function buildSnapshotSummary(): Promise<SnapshotSummary> {
    const [notes, images] = await Promise.all([db.notes.toArray(), db.images.count()])
    return {
      notes: notes.length,
      images,
      titles: notes.slice(0, 5).map((note) => note.title || 'Sin título'),
    }
  }

  async function sendCurrentSnapshot(label: 'A' | 'B') {
    const channel = dcRef.current
    if (!channel || channel.readyState !== 'open') return

    const summary = await buildSnapshotSummary()
    setUploadSummary(summary)
    setFinalSummary(summary)
    const result = await sendSyncSnapshot(channel, { masterKey }, {
      onProgress: (current, total) => setSendProgress({ current, total }),
    })

    if (result.signature) {
      setFinalized(true)
    }

    setStep('progress')
  }

  async function createSession() {
    setBusy(true)
    setQrError(null)
    setUploadSummary(null)
    setFinalSummary(null)
    setFinalized(false)
    setSelectedAuthority(null)
    setPendingOffer('')
    setResponseCode('')
    setPastedResponse('')
    setStep('qr')

    const pc = new RTCPeerConnection()
    pc.ondatachannel = (event) => attachChannel(event.channel)
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        setStep('progress')
      }
    }

    const dc = pc.createDataChannel('sync')
    attachChannel(dc)

    pcRef.current = pc
    dcRef.current = dc

    try {
      const offer = await createOfferAndCompress(pc)
      const url = await QRCode.toDataURL(offer, qrOptions)
      setQrDataUrl(url)
      setStep('qr')
    } catch (error) {
      console.error(error)
      setQrError('No se pudo crear el QR.')
    } finally {
      setBusy(false)
    }
  }

  async function loadQrFromFile(file?: File) {
    if (!file) return
    setBusy(true)
    setQrError(null)
    try {
      const result = await QrScanner.scanImage(file, {
        returnDetailedScanResult: true,
        highlightCodeOutline: true,
        alsoTryWithoutInversion: true,
      })
      const payload = typeof result === 'string' ? result : result?.data
      if (!payload) throw new Error('No se encontró contenido en el QR')
      await handleQrPayload(payload)
    } catch (error) {
      console.error(error)
      setQrError('No se pudo leer el QR.')
    } finally {
      setBusy(false)
      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
    }
  }

  async function openCameraScanner() {
    if (cameraActive) return
    const video = videoRef.current
    if (!video) return

    setBusy(true)
    setQrError(null)

    try {
      const scanner = new QrScanner(video, async (result) => {
        const payload = typeof result === 'string' ? result : result.data
        if (!payload) return
        await stopCameraScanner()
        await handleQrPayload(payload)
      }, {
        preferredCamera: 'environment',
        highlightScanRegion: true,
        highlightCodeOutline: true,
      })

      scannerRef.current = scanner
      setCameraActive(true)
      await scanner.start()
    } catch (error) {
      console.error(error)
      setQrError('No se pudo abrir la cámara.')
      await stopCameraScanner()
    } finally {
      setBusy(false)
    }
  }

  async function handleQrPayload(payload: string) {
    if (!payload) {
      throw new Error('No se encontró contenido en el QR')
    }

    if (mode === 'create') {
      if (!pcRef.current) return
      await setRemoteCompressedAnswer(pcRef.current, payload)
      setStep('progress')
      return
    }

    const pc = new RTCPeerConnection()
    pcRef.current = pc
    pc.ondatachannel = (event) => attachChannel(event.channel)

    setPendingOffer(payload)
    setSelectedAuthority(null)
    setResponseCode('')
    setPastedResponse('')
    setFinalSummary(null)
    setUploadSummary(null)
    setStep('code')
  }

  async function chooseAuthority(authority: SyncAuthority) {
    if (!pcRef.current || !pendingOffer) return
    setBusy(true)
    setQrError(null)
    setSelectedAuthority(authority)
    authorityRef.current = authority

    try {
      const answer = await setRemoteOfferAndCreateAnswer(pcRef.current, pendingOffer)
      setResponseCode(answer)
      autoAppliedRef.current = false
      await navigator.clipboard.writeText(answer).catch(() => undefined)
      setStep('code')
    } catch (error) {
      console.error(error)
      setQrError('No se pudo generar el código.')
    } finally {
      setBusy(false)
    }
  }

  async function shareOrCopyCode() {
    if (!responseCode) return
    try {
      await navigator.clipboard.writeText(responseCode)
    } catch {
      // ignore clipboard failure
    }

    if (navigator.share) {
      await navigator.share({ text: responseCode, title: 'Código de sincronización' }).catch(() => undefined)
    }
  }

  async function applyPastedResponse(auto = false) {
    if (mode === 'create' && !pastedResponse.trim()) return
    if (!pcRef.current || !pastedResponse.trim()) return

    autoAppliedRef.current = true
    setBusy(true)
    setQrError(null)

    try {
      await setRemoteCompressedAnswer(pcRef.current, pastedResponse.trim())
      setStep('progress')
    } catch (error) {
      if (!auto) {
        console.error(error)
        setQrError('No se pudo aplicar el código.')
      }
    } finally {
      setBusy(false)
    }
  }

  function confirmNext() {
    if (step === 'qr') {
      setStep('code')
      return
    }

    if (step === 'code') {
      void applyPastedResponse()
    }
  }

  const sendPercent = sendProgress.total > 0 ? Math.round((sendProgress.current / sendProgress.total) * 100) : 0
  const receivePercent = receiveProgress.total > 0 ? Math.round((receiveProgress.current / receiveProgress.total) * 100) : 0
  const isCreate = mode === 'create'
  const currentSummary = finalSummary ?? uploadSummary

  return (
    <div className="fixed inset-0 z-50 bg-black/50 p-0 sm:p-4 flex items-end sm:items-center justify-center overflow-y-auto">
      <div className="w-full h-[100dvh] sm:h-auto max-w-3xl rounded-none sm:rounded-3xl bg-white shadow-2xl border overflow-hidden max-h-[100dvh] sm:max-h-[92vh] overflow-y-auto">
        <div className="sticky top-0 z-10 flex items-center justify-between gap-3 px-4 sm:px-5 py-4 border-b bg-gray-50/95 backdrop-blur">
          <div>
            <h3 className="text-lg font-semibold text-gray-900">Sincronización</h3>
          </div>
          <button className="rounded-full border px-3 py-2 text-sm shrink-0 bg-white" onClick={onClose}>
            Cerrar
          </button>
        </div>

        <div className="p-4 sm:p-5 space-y-4">
          <div className="flex flex-wrap items-center gap-2 text-xs font-medium text-gray-500">
            {stepLabels.map((item, index) => {
              const active = step === item.id
              const done = stepLabels.findIndex((entry) => entry.id === step) > index
              return (
                <React.Fragment key={item.id}>
                  <span className={`rounded-full px-3 py-1 ${active ? 'bg-gray-900 text-white' : done ? 'bg-emerald-100 text-emerald-800' : 'bg-gray-100 text-gray-600'}`}>
                    {item.label}
                  </span>
                  {index < stepLabels.length - 1 && <span className="text-gray-300">›</span>}
                </React.Fragment>
              )
            })}
          </div>

          {qrError && (
            <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
              {qrError}
            </div>
          )}

          <div className="rounded-2xl border bg-gray-50 p-4 space-y-4">
            {step === 'qr' && isCreate && (
              <div className="space-y-4">
                <button
                  className="w-full rounded-xl bg-blue-600 text-white font-medium px-4 py-3 disabled:opacity-50"
                  onClick={createSession}
                  disabled={busy || !!qrDataUrl}
                >
                  Generar QR
                </button>

                {qrDataUrl ? (
                  <div className="space-y-3">
                    <div className="mx-auto w-full max-w-[20rem] rounded-2xl border bg-white p-2">
                      <img src={qrDataUrl} alt="QR de sincronización" className="w-full h-auto rounded-xl bg-white" />
                    </div>
                    <div className="flex gap-2">
                      <a
                        className="flex-1 text-center rounded-xl border bg-white px-3 py-3 text-sm font-medium"
                        href={qrDataUrl}
                        download="sync-qr.png"
                      >
                        Descargar
                      </a>
                      <button className="flex-1 rounded-xl bg-gray-900 px-3 py-3 text-sm font-medium text-white" onClick={confirmNext}>
                        Siguiente
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="rounded-2xl border-dashed border-2 border-gray-200 p-8 text-center text-gray-500 min-h-48 flex items-center justify-center bg-white">
                    El QR aparecerá aquí.
                  </div>
                )}
              </div>
            )}

            {step === 'qr' && !isCreate && (
              <div className="space-y-4">
                <div
                  className="rounded-2xl border-2 border-dashed bg-white p-4 text-center min-h-48 flex flex-col items-center justify-center gap-3"
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={async (event) => {
                    event.preventDefault()
                    const file = event.dataTransfer.files?.[0]
                    if (file) {
                      await loadQrFromFile(file)
                    }
                  }}
                >
                  <p className="text-sm font-medium text-gray-900">Arrastra una imagen del QR aquí</p>
                  <p className="text-xs text-gray-600">O toca para abrir cámara o archivos.</p>
                  <button className="rounded-xl bg-gray-900 px-4 py-3 text-sm font-medium text-white" onClick={() => fileInputRef.current?.click()} disabled={busy}>
                    Buscar archivo
                  </button>
                  <button className="rounded-xl border px-4 py-3 text-sm font-medium bg-white" onClick={openCameraScanner} disabled={busy}>
                    Abrir cámara
                  </button>
                </div>

                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  className="hidden"
                  onChange={(event) => loadQrFromFile(event.target.files?.[0])}
                />

                {cameraActive && (
                  <div className="rounded-2xl border bg-white p-3 space-y-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-medium text-gray-900">Cámara</p>
                      <button className="text-sm px-3 py-2 rounded border shrink-0 bg-white" onClick={stopCameraScanner}>
                        Cerrar
                      </button>
                    </div>
                    <video ref={videoRef} className="w-full rounded-xl border bg-black aspect-video object-cover max-h-[45svh]" muted playsInline />
                  </div>
                )}
              </div>
            )}

            {step === 'code' && (
              <div className="space-y-4">
                {isCreate ? (
                  <div className="space-y-3">
                    <div className="rounded-2xl border bg-white p-4">
                      <p className="text-sm font-medium text-gray-900 mb-2">Pega el código de respuesta</p>
                      <textarea
                        className="w-full min-h-32 rounded-2xl border bg-gray-50 p-3 font-mono text-[11px] break-all"
                        placeholder="Pega aquí el código que te envió B"
                        value={pastedResponse}
                        onChange={(event) => {
                          setPastedResponse(event.target.value)
                          autoAppliedRef.current = false
                        }}
                      />
                      <div className="mt-3 flex gap-2">
                        <button className="flex-1 rounded-xl border bg-white px-3 py-3 text-sm font-medium" onClick={confirmNext} disabled={busy || !pastedResponse.trim()}>
                          Siguiente
                        </button>
                      </div>
                    </div>
                    <div className="text-xs text-gray-500">Al pegar el código, avanzará solo.</div>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {!selectedAuthority && (
                      <div className="grid gap-3 sm:grid-cols-2">
                        <button
                          className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-4 text-left min-h-24"
                          onClick={() => {
                            setSelectedAuthority('a')
                            void chooseAuthority('a')
                          }}
                          disabled={busy}
                        >
                          <div className="font-semibold text-blue-900">Bajar datos del otro dispositivo</div>
                          <div className="text-sm text-blue-900/80">A prevalece y este dispositivo recibe.</div>
                        </button>
                        <button
                          className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-4 text-left min-h-24"
                          onClick={() => {
                            setSelectedAuthority('b')
                            void chooseAuthority('b')
                          }}
                          disabled={busy}
                        >
                          <div className="font-semibold text-emerald-900">Subir datos de este dispositivo</div>
                          <div className="text-sm text-emerald-900/80">Este equipo manda su base.</div>
                        </button>
                      </div>
                    )}

                    {responseCode && (
                      <div className="rounded-2xl border bg-white p-4 space-y-3">
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-sm font-medium text-gray-900">Código para copiar</p>
                          <div className="flex gap-2">
                            <button className="rounded-lg border px-3 py-2 text-sm bg-white" onClick={shareOrCopyCode}>
                              Copiar / compartir
                            </button>
                          </div>
                        </div>
                        <textarea className="w-full min-h-32 rounded-2xl border bg-gray-50 p-3 font-mono text-[11px] break-all" readOnly value={responseCode} />
                      </div>
                    )}

                    {responseCode && (
                      <p className="text-xs text-gray-500">El código se copió al portapapeles y puedes compartirlo desde aquí.</p>
                    )}
                  </div>
                )}
              </div>
            )}

            {step === 'progress' && (
              <div className="space-y-4">
                <div className="rounded-2xl border bg-white p-4 space-y-3">
                  <div>
                    <div className="flex justify-between mb-1 text-sm">
                      <span className="font-medium">Enviando</span>
                      <span>{sendPercent}%</span>
                    </div>
                    <div className="h-2 rounded-full bg-gray-200 overflow-hidden">
                      <div className="h-full bg-blue-600" style={{ width: `${sendPercent}%` }} />
                    </div>
                  </div>
                  <div>
                    <div className="flex justify-between mb-1 text-sm">
                      <span className="font-medium">Recibiendo</span>
                      <span>{receivePercent}%</span>
                    </div>
                    <div className="h-2 rounded-full bg-gray-200 overflow-hidden">
                      <div className="h-full bg-emerald-600" style={{ width: `${receivePercent}%` }} />
                    </div>
                  </div>
                </div>

                <div className="rounded-2xl border bg-white p-4 space-y-3">
                  <p className="text-sm font-medium text-gray-900">{mode === 'sync' && !uploadSummary ? 'Sincronizado en este dispositivo' : 'Cambios subidos'}</p>
                  {currentSummary ? (
                    <div className="space-y-2 text-sm text-gray-700">
                      <p>{currentSummary.notes} nota{currentSummary.notes === 1 ? '' : 's'} y {currentSummary.images} imagen{currentSummary.images === 1 ? '' : 'es'}.</p>
                      {currentSummary.titles.length > 0 && (
                        <div className="flex flex-wrap gap-2">
                          {currentSummary.titles.map((title) => (
                            <span key={title} className="rounded-full bg-gray-100 px-3 py-1 text-xs text-gray-700">
                              {title}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  ) : (
                    <p className="text-sm text-gray-500">Cambios sincronizados.</p>
                  )}
                </div>

                {finalized && (
                  <div className="rounded-2xl border bg-emerald-50 p-4 text-emerald-900 font-medium">
                    Sincronización terminada.
                  </div>
                )}

                <button className="w-full rounded-xl border bg-white px-4 py-3 text-sm font-medium" onClick={closeSession}>
                  Cerrar
                </button>
              </div>
            )}
          </div>

          {step !== 'progress' && mode === 'create' && (
            <div className="flex gap-2">
              <button className="flex-1 rounded-xl border bg-white px-4 py-3 text-sm font-medium" onClick={onClose}>
                Cerrar
              </button>
              {step !== 'qr' && (
                <button className="flex-1 rounded-xl bg-gray-900 px-4 py-3 text-sm font-medium text-white disabled:opacity-50" onClick={confirmNext} disabled={busy}>
                  Siguiente
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
