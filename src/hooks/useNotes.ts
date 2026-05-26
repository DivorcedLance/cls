import { useEffect, useState } from 'react'
import { db, subscribeDbChanged } from '../core/db'
import type { NoteEntry } from '../core/db'

export function useNotes() {
  const [notes, setNotes] = useState<NoteEntry[]>([])

  useEffect(() => {
    let mounted = true

    async function load() {
      const all = await db.notes.orderBy('updatedAt').reverse().toArray()
      if (mounted) setNotes(all)
    }

    load()
    const unsubscribe = subscribeDbChanged(() => {
      load()
    })

    return () => {
      mounted = false
      unsubscribe()
    }
  }, [])

  return notes
}