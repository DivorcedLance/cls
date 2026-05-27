export type SavedConnection = {
  id: string
  name: string
  pc: RTCPeerConnection
  dc: RTCDataChannel
  createdAt: number
  lastUsedAt: number
}

let savedConnections: SavedConnection[] = []

function buildLabel(index: number) {
  return `Conexión guardada ${index + 1}`
}

export function getSavedConnections() {
  return savedConnections
}

export function saveConnection(connection: {
  id?: string
  name?: string
  pc: RTCPeerConnection
  dc: RTCDataChannel
}) {
  const now = Date.now()
  const existingIndex = connection.id ? savedConnections.findIndex((item) => item.id === connection.id) : -1

  if (existingIndex >= 0) {
    const previous = savedConnections[existingIndex]
    const updated: SavedConnection = {
      ...previous,
      ...connection,
      id: previous.id,
      name: connection.name ?? previous.name,
      pc: connection.pc,
      dc: connection.dc,
      lastUsedAt: now,
    }
    savedConnections = [...savedConnections.slice(0, existingIndex), updated, ...savedConnections.slice(existingIndex + 1)]
    return updated
  }

  const created: SavedConnection = {
    id: connection.id ?? crypto.randomUUID(),
    name: connection.name ?? buildLabel(savedConnections.length),
    pc: connection.pc,
    dc: connection.dc,
    createdAt: now,
    lastUsedAt: now,
  }

  savedConnections = [...savedConnections, created]
  return created
}

export function touchConnection(id: string) {
  savedConnections = savedConnections.map((connection) =>
    connection.id === id ? { ...connection, lastUsedAt: Date.now() } : connection
  )
}

export function removeConnection(id: string) {
  savedConnections = savedConnections.filter((connection) => connection.id !== id)
}

export function getConnection(id?: string) {
  if (id) {
    return savedConnections.find((connection) => connection.id === id) ?? null
  }

  return savedConnections[0] ?? null
}

export function clearConnection(id?: string) {
  if (id) {
    removeConnection(id)
    return
  }

  savedConnections = []
}
