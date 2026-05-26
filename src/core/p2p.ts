import LZString from 'lz-string'

export function compressSDP(sdp: string) {
  return LZString.compressToEncodedURIComponent(sdp)
}

export function decompressSDP(compressed: string) {
  return LZString.decompressFromEncodedURIComponent(compressed) || ''
}

export async function createOfferAndCompress(pc: RTCPeerConnection) {
  const offer = await pc.createOffer()
  await pc.setLocalDescription(offer)
  // wait for ICE gathering to complete so SDP contains candidates
  await waitForIceGatheringComplete(pc)
  return compressSDP(pc.localDescription?.sdp || '')
}

export async function setRemoteCompressed(pc: RTCPeerConnection, compressed: string) {
  const sdp = decompressSDP(compressed)
  if (!sdp) throw new Error('Invalid compressed SDP')
  await pc.setRemoteDescription({ type: 'answer', sdp } as any)
}

export async function setRemoteOfferAndCreateAnswer(pc: RTCPeerConnection, compressedOffer: string) {
  const sdp = decompressSDP(compressedOffer)
  if (!sdp) throw new Error('Invalid compressed SDP')
  await pc.setRemoteDescription({ type: 'offer', sdp } as any)
  const answer = await pc.createAnswer()
  await pc.setLocalDescription(answer)
  await waitForIceGatheringComplete(pc)
  return compressSDP(pc.localDescription?.sdp || '')
}

export async function setRemoteCompressedAnswer(pc: RTCPeerConnection, compressedAnswer: string) {
  const sdp = decompressSDP(compressedAnswer)
  if (!sdp) throw new Error('Invalid compressed SDP')
  await pc.setRemoteDescription({ type: 'answer', sdp } as any)
}

async function waitForIceGatheringComplete(pc: RTCPeerConnection) {
  if (pc.iceGatheringState === 'complete') return
  await new Promise<void>((resolve) => {
    function check() {
      if (pc.iceGatheringState === 'complete') {
        pc.removeEventListener('icegatheringstatechange', check)
        resolve()
      }
    }
    pc.addEventListener('icegatheringstatechange', check)
    // fallback: also resolve after some time
    setTimeout(() => resolve(), 5000)
  })
}
