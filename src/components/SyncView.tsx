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
  const [stage, setStage] = useState<SyncStage>('idle')
  const [instruction, setInstruction] = useState('Pulsa crear sincronización para mostrar el QR.')
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
      setInstruction('Conexión lista. Ya no hace falta repetir el intercambio.')
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
    setInstruction('Selecciona qué base debe prevalecer en caso de conflicto.')
    setPendingOffer(payload)
    setLogs((prev) => [...prev, 'Oferta recibida. Debes elegir la prioridad.'])
  }

  async function createSession() {
    setBusy(true)
    setLogs((prev) => [...prev, 'Creando sesión...'])
    setStatus('Generando QR')
    setInstruction('Muestra este QR en el celular para que B lo escanee.')
    setStage('hosting')
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
      setInstruction('No se pudo leer el QR. Intenta con otra imagen o vuelve a tomarla más cerca.')
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
      setInstruction('No se pudo abrir la cámara. Revisa permisos o vuelve a intentarlo con HTTPS.')
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
    setStatus('Listo')
    setInstruction('Pulsa crear sincronización para mostrar el QR.')
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
      setInstruction('Conexión lista. Ya no hace falta repetir el intercambio.')
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

  return (
    <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className="bg-white rounded-none sm:rounded-2xl shadow-2xl w-full h-[100dvh] sm:h-auto max-w-5xl p-4 sm:p-6 overflow-y-auto max-h-[100dvh] sm:max-h-[92vh]">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between mb-4">
          <div className="space-y-1">
            <h3 className="text-lg sm:text-xl font-semibold">Sincronización entre dispositivos</h3>
            <p className="text-sm text-gray-600 leading-snug">{instruction}</p>
            {syncResult === 'complete' && (
              <div className="mt-3 inline-flex items-center rounded-full bg-emerald-100 text-emerald-800 px-3 py-1 text-sm font-medium">
                Sincronización terminada
              </div>
            )}
          </div>
          <div className="grid grid-cols-2 gap-2 sm:flex sm:justify-end">
            <button className="w-full px-3 py-2 rounded border text-sm sm:w-auto" onClick={resetSession} disabled={busy}>
              Reiniciar
            </button>
            <button className="w-full px-3 py-2 rounded border text-sm sm:w-auto" onClick={onClose}>
              Cerrar
            </button>
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
          <div className="space-y-4">
            <div className="rounded-xl border p-3 sm:p-4 bg-gray-50">
              <div className="grid grid-cols-1 gap-2 sm:flex sm:flex-wrap items-stretch sm:items-center mb-3">
                <button
                  className="w-full sm:w-auto px-4 py-3 rounded-lg bg-blue-600 text-white font-medium disabled:opacity-50"
                  onClick={createSession}
                  disabled={busy || stage !== 'idle'}
                >
                  {stage === 'idle' ? 'Crear sincronización' : 'Sesión en curso'}
                </button>
                <button className="w-full sm:w-auto px-4 py-3 rounded-lg bg-emerald-600 text-white font-medium disabled:opacity-50" onClick={openFilePicker} disabled={busy}>
                  Escanear QR
                </button>
                <button className="w-full sm:w-auto px-4 py-3 rounded-lg bg-slate-900 text-white font-medium disabled:opacity-50" onClick={toggleCameraScanner} disabled={busy}>
                  {cameraActive ? 'Detener cámara' : 'Escanear con cámara'}
                </button>
              </div>

              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(event) => processQrFile(event.target.files?.[0])}
              />

              <div className="text-sm text-gray-700 space-y-2 leading-snug">
                <p><span className="font-semibold">Estado:</span> {status}</p>
                <p><span className="font-semibold">1.</span> En A pulsa <span className="font-semibold">Crear sincronización</span>.</p>
                <p><span className="font-semibold">2.</span> En B escanea el QR de A.</p>
                <p><span className="font-semibold">3.</span> En B elige <span className="font-semibold">Prioridad de A</span> o <span className="font-semibold">Prioridad de B</span>.</p>
                <p><span className="font-semibold">4.</span> B copia el texto de respuesta y A lo pega aquí.</p>
                <p><span className="font-semibold">5.</span> El lado con prioridad envía su base completa y la otra se reemplaza.</p>
              </div>

              <div className="mt-4 space-y-3 text-sm">
                <div>
                  <div className="flex justify-between mb-1">
                    <span className="font-medium">Enviando</span>
                    <span>{sendPercent}%</span>
                  </div>
                  <div className="h-2 rounded-full bg-gray-200 overflow-hidden">
                    <div className="h-full bg-blue-600" style={{ width: `${sendPercent}%` }} />
                  </div>
                </div>
                <div>
                  <div className="flex justify-between mb-1">
                    <span className="font-medium">Recibiendo</span>
                    <span>{receivePercent}%</span>
                  </div>
                  <div className="h-2 rounded-full bg-gray-200 overflow-hidden">
                    <div className="h-full bg-emerald-600" style={{ width: `${receivePercent}%` }} />
                  </div>
                </div>
              </div>

              {stage === 'responding' && pendingOffer && !chosenAuthority && (
                <div className="mt-5 rounded-2xl border bg-white p-4 shadow-sm">
                  <p className="text-sm font-medium text-gray-900 mb-2">¿Qué base debe prevalecer si hay conflicto?</p>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <button
                      className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-left hover:bg-blue-100 transition min-h-24"
                      onClick={() => chooseAuthority('a')}
                      disabled={busy}
                    >
                      <div className="font-semibold text-blue-900">Prioridad de A</div>
                      <div className="text-sm text-blue-900/80">Esta ventana adoptará lo que venga de A. A sobrescribe a B.</div>
                    </button>
                    <button
                      className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-left hover:bg-emerald-100 transition min-h-24"
                      onClick={() => chooseAuthority('b')}
                      disabled={busy}
                    >
                      <div className="font-semibold text-emerald-900">Prioridad de B</div>
                      <div className="text-sm text-emerald-900/80">Esta ventana conserva lo propio y empuja su DB hacia A.</div>
                    </button>
                  </div>
                </div>
              )}

              {stage === 'responding' && responseToken && (
                <div className="mt-5 rounded-2xl border bg-white p-4 shadow-sm space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-medium text-gray-900">Respuesta para A</p>
                    <button
                      className="text-sm px-3 py-2 rounded border shrink-0"
                      onClick={async () => {
                        await navigator.clipboard.writeText(responseToken)
                        setLogs((prev) => [...prev, 'Respuesta copiada al portapapeles'])
                      }}
                    >
                      Copiar
                    </button>
                  </div>
                  <textarea
                    className="w-full min-h-32 sm:min-h-36 rounded-xl border p-3 font-mono text-[11px] sm:text-xs bg-gray-50 break-all"
                    readOnly
                    value={responseToken}
                  />
                  <p className="text-sm text-gray-600">
                    En A pega este texto abajo para terminar la conexión.
                  </p>
                </div>
              )}

              {stage === 'waiting-for-answer' && (
                <div className="mt-5 rounded-2xl border bg-white p-4 shadow-sm space-y-3">
                  <p className="text-sm font-medium text-gray-900">Pegar respuesta de B</p>
                  <textarea
                    className="w-full min-h-32 sm:min-h-36 rounded-xl border p-3 font-mono text-[11px] sm:text-xs bg-gray-50 break-all"
                    placeholder="Pega aquí el texto de respuesta que te mandó B"
                    value={pastedResponse}
                    onChange={(event) => setPastedResponse(event.target.value)}
                  />
                  <div className="grid grid-cols-1 sm:flex gap-2">
                    <button
                      className="w-full sm:w-auto px-4 py-2 rounded-lg bg-indigo-600 text-white font-medium disabled:opacity-50"
                      onClick={applyPastedResponse}
                      disabled={busy || !pastedResponse.trim()}
                    >
                      Aplicar respuesta
                    </button>
                    <button
                      className="w-full sm:w-auto px-4 py-2 rounded-lg border font-medium"
                      onClick={async () => {
                        const clipboard = await navigator.clipboard.readText()
                        setPastedResponse(clipboard)
                      }}
                    >
                      Pegar desde portapapeles
                    </button>
                  </div>
                </div>
              )}

              {cameraActive && (
                <div className="mt-5 rounded-2xl border bg-white p-4 shadow-sm space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-medium text-gray-900">Cámara de lectura</p>
                    <button className="text-sm px-3 py-2 rounded border shrink-0" onClick={stopCameraScanner}>
                      Cerrar cámara
                    </button>
                  </div>
                  <video ref={videoRef} className="w-full rounded-xl border bg-black aspect-video object-cover max-h-[52svh]" muted playsInline />
                </div>
              )}
            </div>

            <div className="rounded-xl border p-4">
              <h4 className="font-medium mb-2">Registro</h4>
              <div className="h-40 overflow-auto rounded bg-gray-50 p-3 text-sm text-gray-700 space-y-1">
                {logs.length === 0 ? (
                  <p className="text-gray-500">Sin eventos todavía.</p>
                ) : (
                  logs.map((line, index) => <p key={`${line}-${index}`}>{line}</p>)
                )}
              </div>
            </div>
          </div>

          <div className="rounded-xl border p-4 bg-white">
            <h4 className="font-medium mb-3">QR actual</h4>
            {qrDataUrl ? (
              <div className="space-y-3">
                <div className="mx-auto w-full max-w-[22rem] sm:max-w-sm rounded-xl border bg-white p-2">
                  <img src={qrDataUrl} alt="QR de sincronización" className="w-full h-auto rounded-lg bg-white" />
                </div>
                <a
                  className="block text-center px-4 py-2 rounded-lg bg-indigo-600 text-white font-medium"
                  href={qrDataUrl}
                  download="sync-qr.png"
                >
                  Descargar QR
                </a>
                <p className="text-sm text-gray-600 text-center">
                  Este QR debe verlo B.
                </p>
              </div>
            ) : (
              <div className="rounded-lg border-dashed border-2 border-gray-200 p-6 text-center text-gray-500 min-h-48 flex items-center justify-center">
                Aquí se mostrará el QR.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
