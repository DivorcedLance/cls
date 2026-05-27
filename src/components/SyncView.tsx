import React, { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import QrScanner from 'qr-scanner'
import { createOfferAndCompress, setRemoteOfferAndCreateAnswer, setRemoteCompressedAnswer } from '../core/p2p'
import { createSyncMessageHandler, sendSyncSnapshot } from '../core/sync'

QrScanner.WORKER_PATH = new URL('qr-scanner/qr-scanner-worker.min.js', import.meta.url).toString()

type SyncStage = 'idle' | 'hosting' | 'waiting-for-answer' | 'scanning' | 'responding' | 'connected' | 'error'
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

export default function SyncView({ masterKey, onClose }: { masterKey: CryptoKey; onClose?: () => void }) {
  const [flowStep, setFlowStep] = useState<'qr' | 'code' | 'progress'>('qr')
  const [stage, setStage] = useState<SyncStage>('idle')
  const [instruction, setInstruction] = useState('Paso 1 de 3')
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  const [status, setStatus] = useState('Listo')
  const [logs, setLogs] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [sendProgress, setSendProgress] = useState({ current: 0, total: 0 })
  const [receiveProgress, setReceiveProgress] = useState({ current: 0, total: 0 })
  const [chosenAuthority, setChosenAuthority] = useState<SyncAuthority | null>(null)
  const [pendingOffer, setPendingOffer] = useState<string | null>(null)
  const [syncResult, setSyncResult] = useState<'idle' | 'complete'>('idle')
  const [cameraActive, setCameraActive] = useState(false)
  const [responseToken, setResponseToken] = useState('')
  const [pastedResponse, setPastedResponse] = useState('')
  const pcRef = useRef<RTCPeerConnection | null>(null)
  const dcRef = useRef<RTCDataChannel | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const scannerRef = useRef<QrScanner | null>(null)
  const isConnectedRef = useRef(false)
  const authorityRef = useRef<SyncAuthority | null>(null)

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

  async function stopCameraScanner() {
    scannerRef.current?.stop()
    scannerRef.current?.destroy()
    scannerRef.current = null
    setCameraActive(false)
  }

  function attachChannel(channel: RTCDataChannel) {
    dcRef.current = channel
    channel.onopen = () => {
      isConnectedRef.current = true
      setStage('connected')
      setStatus('Canal listo')
      setInstruction('Conexión establecida. Esperando confirmación de la prioridad elegida.')
      setLogs((prev) => [...prev, 'Canal de datos abierto'])

      const authority = authorityRef.current
      if (authority) {
        channel.send(JSON.stringify({ type: 'sync/control', id: crypto.randomUUID(), authority }))
        setLogs((prev) => [...prev, authority === 'a' ? 'Se pidió prioridad de A' : 'Se pidió prioridad de B'])
        if (authority === 'b') {
          void sendCurrentSnapshot('B')
        }
      }
    }
    channel.onclose = () => {
      isConnectedRef.current = false
      setStatus('Desconectado')
      setLogs((prev) => [...prev, 'Canal cerrado'])
    }
    channel.onmessage = createSyncMessageHandler(
      channel,
      { masterKey },
      (text) => {
        setLogs((prev) => [...prev, text])
        setStatus('Sincronizando')
      },
      (current, total) => setReceiveProgress({ current, total }),
      (signature) => {
        setStatus('Sincronización confirmada')
        setSyncResult('complete')
        setLogs((prev) => [...prev, 'La otra ventana confirmó la sincronización'])
        setLogs((prev) => [...prev, `Firma final: ${signature.slice(0, 8)}…`])
      },
      (authority) => {
        authorityRef.current = authority
        if (authority === 'a') {
          setLogs((prev) => [...prev, 'La prioridad final es A'])
          void sendCurrentSnapshot('A')
        } else {
          setLogs((prev) => [...prev, 'La prioridad final es B'])
        }
      }
    )
  }

  async function sendCurrentSnapshot(label: 'A' | 'B') {
    const channel = dcRef.current
    if (!channel || channel.readyState !== 'open') return
    setStatus(`Enviando DB de ${label}`)
    const result = await sendSyncSnapshot(channel, { masterKey }, {
      onProgress: (current, total) => setSendProgress({ current, total }),
    })
    if (result.signature) {
      setLogs((prev) => [...prev, `Snapshot de ${label} enviado`])
    }
  }

  async function handleQrPayload(payload: string) {
    if (!payload) {
      throw new Error('No se encontró contenido en el QR')
    }

    if (stage === 'waiting-for-answer' && pcRef.current) {
      await setRemoteCompressedAnswer(pcRef.current, payload)
      setStage('connected')
      setStatus('Respuesta aceptada')
      setInstruction('Paso 3 de 3')
      setFlowStep('progress')
      setPendingOffer(payload)
      setLogs((prev) => [...prev, 'Respuesta recibida'])
      return
    }

    const pc = new RTCPeerConnection()
    pcRef.current = pc
    pc.onconnectionstatechange = () => {
      setStatus(`Conexión: ${pc.connectionState}`)
      if (pc.connectionState === 'connected') {
        setStage('connected')
        setLogs((prev) => [...prev, 'Conexión establecida'])
      }
    }

    pc.ondatachannel = (event) => {
      attachChannel(event.channel)
    }

    setStage('responding')
    setStatus('Oferta recibida')
    setInstruction('Paso 2 de 3')
    setFlowStep('code')
    setPendingOffer(payload)
    setLogs((prev) => [...prev, 'Oferta recibida. Debes elegir la prioridad.'])
  }

  async function createSession() {
    setBusy(true)
    setLogs((prev) => [...prev, 'Creando sesión...'])
    setStatus('Generando QR')
    setInstruction('Paso 1 de 3')
    setStage('hosting')
    setFlowStep('qr')
    setSyncResult('idle')
    setChosenAuthority(null)
    setPendingOffer(null)
    authorityRef.current = null
    setQrDataUrl(null)
    setResponseToken('')
    setPastedResponse('')

    const pc = new RTCPeerConnection()
    pc.onconnectionstatechange = () => {
      setStatus(`Conexión: ${pc.connectionState}`)
      if (pc.connectionState === 'connected') {
        setStage('connected')
        setLogs((prev) => [...prev, 'Conexión establecida'])
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
      setStage('waiting-for-answer')
      setStatus('Oferta lista')
      setInstruction('Paso 1 de 3')
      setLogs((prev) => [...prev, 'QR de oferta listo'])
    } catch (error) {
      console.error(error)
      setStage('error')
      setStatus('Error al crear QR')
      setLogs((prev) => [...prev, 'No se pudo crear la sesión'])
    } finally {
      setBusy(false)
    }
  }

  async function processQrFile(file?: File) {
    if (!file) return
    setBusy(true)
    setLogs((prev) => [...prev, `Leyendo QR: ${file.name}`])

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
      setStage('error')
      setStatus('No se pudo leer el QR')
      setInstruction('Paso 2 de 3')
      setLogs((prev) => [...prev, `Error: ${String(error)}`])
    } finally {
      setBusy(false)
      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
    }
  }

  async function startCameraScanner() {
    if (cameraActive) return
    const videoElement = videoRef.current
    if (!videoElement) return

    setBusy(true)
    setLogs((prev) => [...prev, 'Iniciando cámara...'])
    setStage('scanning')
    setStatus('Cámara activa')
    setInstruction('Apunta la cámara al QR que quieras leer.')

    try {
      const scanner = new QrScanner(
        videoElement,
        async (result) => {
          const payload = typeof result === 'string' ? result : result.data
          if (!payload) return

          await stopCameraScanner()
          try {
            await handleQrPayload(payload)
          } catch (error) {
            console.error(error)
            setStage('error')
            setStatus('No se pudo procesar el QR')
            setLogs((prev) => [...prev, `Error: ${String(error)}`])
          }
        },
        {
          preferredCamera: 'environment',
          highlightScanRegion: true,
          highlightCodeOutline: true,
        }
      )

      scannerRef.current = scanner
      setCameraActive(true)
      await scanner.start()
    } catch (error) {
      console.error(error)
      setStage('error')
      setStatus('No se pudo abrir la cámara')
      setInstruction('Paso 2 de 3')
      setLogs((prev) => [...prev, `Error cámara: ${String(error)}`])
      await stopCameraScanner()
    } finally {
      setBusy(false)
    }
  }

  async function toggleCameraScanner() {
    if (cameraActive) {
      await stopCameraScanner()
      setStatus('Cámara detenida')
      return
    }

    await startCameraScanner()
  }

  function openFilePicker() {
    fileInputRef.current?.click()
  }

  async function chooseAuthority(authority: SyncAuthority) {
    if (!pendingOffer || !pcRef.current) return
    authorityRef.current = authority
    setChosenAuthority(authority)
    setBusy(true)
    setLogs((prev) => [...prev, authority === 'a' ? 'Elegiste prioridad de A' : 'Elegiste prioridad de B'])
    setStatus('Generando respuesta')

    try {
      const answer = await setRemoteOfferAndCreateAnswer(pcRef.current, pendingOffer)
      setResponseToken(answer)
      setStage('responding')
      setFlowStep('code')
      setInstruction(authority === 'a'
        ? 'La base de A prevalecerá. Copia este texto y pégalo en A para completar la conexión.'
        : 'La base de B prevalecerá. Copia este texto y pégalo en A para completar la conexión.')
      setStatus(authority === 'a' ? 'A tendrá prioridad' : 'B tendrá prioridad')
      setLogs((prev) => [...prev, 'Respuesta generada como texto'])
    } catch (error) {
      console.error(error)
      setStage('error')
      setStatus('No se pudo generar la respuesta')
      setLogs((prev) => [...prev, `Error: ${String(error)}`])
    } finally {
      setBusy(false)
    }
  }

  function resetSession() {
    void stopCameraScanner()
    try {
      dcRef.current?.close()
      pcRef.current?.close()
    } catch {
      // ignore cleanup errors
    }
    dcRef.current = null
    pcRef.current = null
    setStage('idle')
    setQrDataUrl(null)
    setFlowStep('qr')
    setStatus('Listo')
    setInstruction('Paso 1 de 3')
    setLogs([])
    setSendProgress({ current: 0, total: 0 })
    setReceiveProgress({ current: 0, total: 0 })
    setChosenAuthority(null)
    setPendingOffer(null)
    setSyncResult('idle')
    authorityRef.current = null
    setResponseToken('')
    setPastedResponse('')
  }

  async function applyPastedResponse() {
    if (!pastedResponse.trim() || !pcRef.current) return
    setBusy(true)
    try {
      await setRemoteCompressedAnswer(pcRef.current, pastedResponse.trim())
      setStage('connected')
      setStatus('Respuesta aplicada')
      setInstruction('Paso 3 de 3')
      setFlowStep('progress')
      setLogs((prev) => [...prev, 'Respuesta pegada manualmente'])
    } catch (error) {
      console.error(error)
      setStage('error')
      setStatus('No se pudo aplicar la respuesta')
      setLogs((prev) => [...prev, `Error: ${String(error)}`])
    } finally {
      setBusy(false)
    }
  }

  const sendPercent = sendProgress.total > 0 ? Math.round((sendProgress.current / sendProgress.total) * 100) : 0
  const receivePercent = receiveProgress.total > 0 ? Math.round((receiveProgress.current / receiveProgress.total) * 100) : 0

  const canGoNext = flowStep === 'qr' ? Boolean(qrDataUrl) : flowStep === 'code' ? true : true

  async function goNextFromQr() {
    setFlowStep('code')
  }

  async function goNextFromCode() {
    if (stage === 'waiting-for-answer') {
      await applyPastedResponse()
      return
    }

    if (stage === 'responding' && responseToken) {
      setFlowStep('progress')
      return
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 p-0 sm:p-4 flex items-end sm:items-center justify-center overflow-y-auto">
      <div className="w-full h-[100dvh] sm:h-auto max-w-3xl rounded-none sm:rounded-3xl bg-white shadow-2xl border overflow-hidden max-h-[100dvh] sm:max-h-[92vh] overflow-y-auto">
        <div className="sticky top-0 z-10 flex items-start justify-between gap-3 px-4 sm:px-5 py-4 border-b bg-gray-50/95 backdrop-blur">
          <div>
            <h3 className="text-lg font-semibold text-gray-900">Sincronización</h3>
            <p className="text-xs text-gray-600 mt-1">{instruction}</p>
          </div>
          <button className="rounded-full border px-3 py-2 text-sm shrink-0 bg-white" onClick={onClose}>
            Cerrar
          </button>
        </div>

        <div className="p-4 sm:p-5 space-y-4">
          <div className="flex items-center gap-2 text-xs font-medium text-gray-500">
            <span className={`rounded-full px-2 py-1 ${flowStep === 'qr' ? 'bg-gray-900 text-white' : 'bg-gray-100'}`}>1. QR</span>
            <span className={`rounded-full px-2 py-1 ${flowStep === 'code' ? 'bg-gray-900 text-white' : 'bg-gray-100'}`}>2. Código</span>
            <span className={`rounded-full px-2 py-1 ${flowStep === 'progress' ? 'bg-gray-900 text-white' : 'bg-gray-100'}`}>3. Progreso</span>
          </div>

          <div className="grid gap-4">
            <div className="rounded-2xl border bg-gray-50 p-4 space-y-4">
              {flowStep === 'qr' && (
                <div className="space-y-4">
                  <button
                    className="w-full rounded-xl bg-blue-600 text-white font-medium px-4 py-3 disabled:opacity-50"
                    onClick={createSession}
                    disabled={busy || stage !== 'idle'}
                  >
                    {stage === 'idle' ? 'Crear sincronización' : 'Generando QR...'}
                  </button>

                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(event) => processQrFile(event.target.files?.[0])}
                  />

                  <div className="flex gap-2">
                    <button className="flex-1 rounded-xl border bg-white px-3 py-3 text-sm font-medium disabled:opacity-50" onClick={openFilePicker} disabled={busy}>
                      Escanear QR
                    </button>
                    <button className="flex-1 rounded-xl border bg-white px-3 py-3 text-sm font-medium disabled:opacity-50" onClick={toggleCameraScanner} disabled={busy}>
                      Cámara
                    </button>
                  </div>

                  {qrDataUrl ? (
                    <div className="mx-auto w-full max-w-[20rem] rounded-2xl border bg-white p-2">
                      <img src={qrDataUrl} alt="QR de sincronización" className="w-full h-auto rounded-xl bg-white" />
                    </div>
                  ) : (
                    <div className="rounded-2xl border-dashed border-2 border-gray-200 p-8 text-center text-gray-500 min-h-48 flex items-center justify-center bg-white">
                      El QR aparecerá aquí.
                    </div>
                  )}

                  <button
                    className="w-full rounded-xl bg-gray-900 text-white font-medium px-4 py-3 disabled:opacity-50"
                    onClick={goNextFromQr}
                    disabled={!canGoNext}
                  >
                    Siguiente
                  </button>
                </div>
              )}

              {flowStep === 'code' && (
                <div className="space-y-4">
                  {stage === 'responding' && !responseToken && pendingOffer && (
                    <div className="grid gap-3 sm:grid-cols-2">
                      <button
                        className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-left min-h-24"
                        onClick={() => chooseAuthority('a')}
                        disabled={busy}
                      >
                        <div className="font-semibold text-blue-900">Prioridad A</div>
                        <div className="text-sm text-blue-900/80">A manda su base.</div>
                      </button>
                      <button
                        className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-left min-h-24"
                        onClick={() => chooseAuthority('b')}
                        disabled={busy}
                      >
                        <div className="font-semibold text-emerald-900">Prioridad B</div>
                        <div className="text-sm text-emerald-900/80">B conserva su base.</div>
                      </button>
                    </div>
                  )}

                  {stage === 'responding' && responseToken && (
                    <div className="space-y-3">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-sm font-medium text-gray-900">Código para A</p>
                        <button
                          className="rounded-lg border px-3 py-2 text-sm bg-white"
                          onClick={async () => {
                            await navigator.clipboard.writeText(responseToken)
                          }}
                        >
                          Copiar
                        </button>
                      </div>
                      <textarea className="w-full min-h-32 rounded-2xl border bg-white p-3 font-mono text-[11px] break-all" readOnly value={responseToken} />
                    </div>
                  )}

                  {stage === 'waiting-for-answer' && (
                    <div className="space-y-3">
                      <p className="text-sm font-medium text-gray-900">Pega el código de B</p>
                      <textarea
                        className="w-full min-h-32 rounded-2xl border bg-white p-3 font-mono text-[11px] break-all"
                        placeholder="Pega aquí el código"
                        value={pastedResponse}
                        onChange={(event) => setPastedResponse(event.target.value)}
                      />
                      <div className="flex gap-2">
                        <button
                          className="flex-1 rounded-xl border bg-white px-3 py-3 text-sm font-medium"
                          onClick={async () => setPastedResponse(await navigator.clipboard.readText())}
                        >
                          Pegar
                        </button>
                      </div>
                    </div>
                  )}

                  {stage === 'connected' && (
                    <div className="rounded-2xl border bg-white p-4 text-sm text-gray-700">
                      Sincronización lista.
                    </div>
                  )}

                  <div className="flex gap-2">
                    <button
                      className="flex-1 rounded-xl border bg-white px-4 py-3 text-sm font-medium"
                      onClick={() => setFlowStep('qr')}
                    >
                      Atrás
                    </button>
                    <button
                      className="flex-1 rounded-xl bg-gray-900 px-4 py-3 text-sm font-medium text-white disabled:opacity-50"
                      onClick={goNextFromCode}
                      disabled={busy || (stage === 'waiting-for-answer' && !pastedResponse.trim()) || (stage === 'responding' && !responseToken && !chosenAuthority)}
                    >
                      Siguiente
                    </button>
                  </div>
                </div>
              )}

              {flowStep === 'progress' && (
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

                  {syncResult === 'complete' ? (
                    <div className="rounded-2xl border bg-emerald-50 p-4 text-emerald-900 font-medium">
                      Sincronización terminada.
                    </div>
                  ) : (
                    <div className="rounded-2xl border bg-white p-4 text-sm text-gray-700">
                      Esperando el avance de la sincronización.
                    </div>
                  )}

                  <button
                    className="w-full rounded-xl border bg-white px-4 py-3 text-sm font-medium"
                    onClick={resetSession}
                  >
                    Reiniciar
                  </button>
                </div>
              )}

              {cameraActive && (
                <div className="rounded-2xl border bg-white p-3 space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-medium text-gray-900">Cámara</p>
                    <button className="text-sm px-3 py-2 rounded border shrink-0" onClick={stopCameraScanner}>
                      Cerrar
                    </button>
                  </div>
                  <video ref={videoRef} className="w-full rounded-xl border bg-black aspect-video object-cover max-h-[45svh]" muted playsInline />
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 text-xs text-gray-600">
              <div className="rounded-xl border bg-white px-3 py-2">Estado: {status}</div>
              <div className="rounded-xl border bg-white px-3 py-2">Paso: {flowStep}</div>
              <div className="rounded-xl border bg-white px-3 py-2 col-span-2 sm:col-span-1">Conexión: {stage}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
