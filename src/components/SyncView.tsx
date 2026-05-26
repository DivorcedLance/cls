import React, { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { createOfferAndCompress, setRemoteOfferAndCreateAnswer, setRemoteCompressedAnswer } from '../core/p2p'
import { createSyncMessageHandler, sendSyncSnapshot } from '../core/sync'

type SyncStage = 'idle' | 'hosting' | 'waiting-for-answer' | 'responding' | 'connected' | 'error'
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
  const pcRef = useRef<RTCPeerConnection | null>(null)
  const dcRef = useRef<RTCDataChannel | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const isConnectedRef = useRef(false)
  const authorityRef = useRef<SyncAuthority | null>(null)

  useEffect(() => {
    return () => {
      try {
        dcRef.current?.close()
        pcRef.current?.close()
      } catch {
        // ignore cleanup errors
      }
    }
  }, [])

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

  async function createSession() {
    setBusy(true)
    setLogs((prev) => [...prev, 'Creando sesión...'])
    setStatus('Generando QR')
    setInstruction('Muestra este QR en la otra ventana. B elegirá qué base debe prevalecer.')
    setStage('hosting')
    setSyncResult('idle')
    setChosenAuthority(null)
    setPendingOffer(null)
    authorityRef.current = null
    setQrDataUrl(null)

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
      const QrScanner = (await import('qr-scanner')).default
      const result = await QrScanner.scanImage(file, {
        returnDetailedScanResult: true,
        highlightCodeOutline: true,
        alsoTryWithoutInversion: true,
      })
      const payload = typeof result === 'string' ? result : result?.data

      if (!payload) {
        throw new Error('No se encontró contenido en el QR')
      }

      if (stage === 'waiting-for-answer' && pcRef.current) {
        await setRemoteCompressedAnswer(pcRef.current, payload)
        setStage('connected')
        setStatus('Respuesta aceptada')
        setInstruction('Conexión lista. Esperando la prioridad que elija B.')
        setPendingOffer(payload)
        setLogs((prev) => [...prev, 'Respuesta leída. Esperando decisión de prioridad.'])
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

  function openFilePicker() {
    fileInputRef.current?.click()
  }

  async function chooseAuthority(authority: SyncAuthority) {
    if (!pendingOffer || !pcRef.current) return
    authorityRef.current = authority
    setChosenAuthority(authority)
    setBusy(true)
    setLogs((prev) => [...prev, authority === 'a' ? 'Elegiste prioridad de A' : 'Elegiste prioridad de B'])
    setStatus('Generando QR de respuesta')

    try {
      const answer = await setRemoteOfferAndCreateAnswer(pcRef.current, pendingOffer)
      const answerQr = await QRCode.toDataURL(answer, qrOptions)
      setQrDataUrl(answerQr)
      setStage('responding')
      setInstruction(authority === 'a'
        ? 'La base de A prevalecerá. Muestra este QR a A.'
        : 'La base de B prevalecerá. Muestra este QR a A para completar la conexión.')
      setStatus(authority === 'a' ? 'A tendrá prioridad' : 'B tendrá prioridad')
      setLogs((prev) => [...prev, 'Respuesta QR generada'])
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
  }

  const sendPercent = sendProgress.total > 0 ? Math.round((sendProgress.current / sendProgress.total) * 100) : 0
  const receivePercent = receiveProgress.total > 0 ? Math.round((receiveProgress.current / receiveProgress.total) * 100) : 0

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl p-6">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <h3 className="text-xl font-semibold">Sincronización entre dispositivos</h3>
            <p className="text-sm text-gray-600 mt-1">{instruction}</p>
            {syncResult === 'complete' && (
              <div className="mt-3 inline-flex items-center rounded-full bg-emerald-100 text-emerald-800 px-3 py-1 text-sm font-medium">
                Sincronización terminada
              </div>
            )}
          </div>
          <div className="flex gap-2">
            <button className="px-3 py-2 rounded border" onClick={resetSession} disabled={busy}>
              Reiniciar
            </button>
            <button className="px-3 py-2 rounded border" onClick={onClose}>
              Cerrar
            </button>
          </div>
        </div>

        <div className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
          <div className="space-y-4">
            <div className="rounded-xl border p-4 bg-gray-50">
              <div className="flex flex-wrap items-center gap-3 mb-3">
                <button
                  className="px-4 py-3 rounded-lg bg-blue-600 text-white font-medium disabled:opacity-50"
                  onClick={createSession}
                  disabled={busy || stage !== 'idle'}
                >
                  {stage === 'idle' ? 'Crear sincronización' : 'Sesión en curso'}
                </button>
                <button className="px-4 py-3 rounded-lg bg-emerald-600 text-white font-medium disabled:opacity-50" onClick={openFilePicker} disabled={busy}>
                  Escanear QR
                </button>
              </div>

              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(event) => processQrFile(event.target.files?.[0])}
              />

              <div className="text-sm text-gray-700 space-y-2">
                <p><span className="font-semibold">Estado:</span> {status}</p>
                <p><span className="font-semibold">1.</span> En A pulsa <span className="font-semibold">Crear sincronización</span>.</p>
                <p><span className="font-semibold">2.</span> En B pulsa <span className="font-semibold">Escanear QR</span> y elige la imagen.</p>
                <p><span className="font-semibold">3.</span> En B elige <span className="font-semibold">Prioridad de A</span> o <span className="font-semibold">Prioridad de B</span>.</p>
                <p><span className="font-semibold">4.</span> El lado con prioridad envía su base completa y la otra se reemplaza.</p>
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
                      className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-left hover:bg-blue-100 transition"
                      onClick={() => chooseAuthority('a')}
                      disabled={busy}
                    >
                      <div className="font-semibold text-blue-900">Prioridad de A</div>
                      <div className="text-sm text-blue-900/80">Esta ventana adoptará lo que venga de A. A sobrescribe a B.</div>
                    </button>
                    <button
                      className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-left hover:bg-emerald-100 transition"
                      onClick={() => chooseAuthority('b')}
                      disabled={busy}
                    >
                      <div className="font-semibold text-emerald-900">Prioridad de B</div>
                      <div className="text-sm text-emerald-900/80">Esta ventana conserva lo propio y empuja su DB hacia A.</div>
                    </button>
                  </div>
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
                <img src={qrDataUrl} alt="QR de sincronización" className="w-full max-w-sm mx-auto rounded-lg border bg-white" />
                <a
                  className="block text-center px-4 py-2 rounded-lg bg-indigo-600 text-white font-medium"
                  href={qrDataUrl}
                  download="sync-qr.png"
                >
                  Descargar QR
                </a>
                <p className="text-sm text-gray-600 text-center">
                  {stage === 'waiting-for-answer'
                    ? 'Este QR debe verlo la otra ventana.'
                    : stage === 'responding'
                      ? 'Esta es la respuesta que debe volver a A.'
                      : 'El QR aparecerá aquí cuando pulses crear sincronización o escanees uno.'}
                </p>
              </div>
            ) : (
              <div className="rounded-lg border-dashed border-2 border-gray-200 p-6 text-center text-gray-500">
                Aquí se mostrará el QR.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}