import { useEffect, useState } from 'react'

export interface StorageQuotaState {
  usage: number
  quota: number
  usageRatio: number
  available: number
}

export function useStorageQuota() {
  const [state, setState] = useState<StorageQuotaState>({
    usage: 0,
    quota: 0,
    usageRatio: 0,
    available: 0,
  })

  useEffect(() => {
    let mounted = true

    async function refresh() {
      if (!navigator.storage?.estimate) return
      const estimate = await navigator.storage.estimate()
      const usage = estimate.usage ?? 0
      const quota = estimate.quota ?? 0
      if (!mounted) return
      setState({
        usage,
        quota,
        usageRatio: quota > 0 ? usage / quota : 0,
        available: Math.max(quota - usage, 0),
      })
    }

    refresh()
    const interval = window.setInterval(refresh, 15_000)
    return () => {
      mounted = false
      window.clearInterval(interval)
    }
  }, [])

  return state
}