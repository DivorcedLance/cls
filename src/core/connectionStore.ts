export type SavedConnection = {
  pc: RTCPeerConnection
  dc: RTCDataChannel
}

let savedConnection: SavedConnection | null = null

export function saveConnection(connection: SavedConnection) {
  savedConnection = connection
}

export function getConnection() {
  return savedConnection
}

export function clearConnection() {
  savedConnection = null
}
