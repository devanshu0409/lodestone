import type { HttpMethod } from '@shared/types'

/**
 * Per-cluster console history and saved requests, persisted in localStorage.
 * These contain no secrets (just method/path/body you typed), so renderer-side
 * storage is fine and avoids widening the IPC surface.
 */

export interface ConsoleRequest {
  method: HttpMethod
  path: string
  body: string
}

export interface HistoryEntry extends ConsoleRequest {
  id: string
  at: number
  status?: number
}

export interface SavedRequest extends ConsoleRequest {
  id: string
  name: string
}

const HISTORY_LIMIT = 50

const historyKey = (connId: string): string => `lodestone.console.history.${connId}`
const savedKey = (connId: string): string => `lodestone.console.saved.${connId}`

function read<T>(key: string): T[] {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T[]) : []
  } catch {
    return []
  }
}

function write<T>(key: string, value: T[]): void {
  localStorage.setItem(key, JSON.stringify(value))
}

export function loadHistory(connId: string): HistoryEntry[] {
  return read<HistoryEntry>(historyKey(connId))
}

export function pushHistory(connId: string, entry: Omit<HistoryEntry, 'id' | 'at'>): HistoryEntry[] {
  const record: HistoryEntry = { ...entry, id: crypto.randomUUID(), at: Date.now() }
  const existing = loadHistory(connId).filter(
    (h) => !(h.method === record.method && h.path === record.path && h.body === record.body)
  )
  const next = [record, ...existing].slice(0, HISTORY_LIMIT)
  write(historyKey(connId), next)
  return next
}

export function clearHistory(connId: string): void {
  write(historyKey(connId), [])
}

export function loadSaved(connId: string): SavedRequest[] {
  return read<SavedRequest>(savedKey(connId))
}

export function saveRequest(connId: string, name: string, req: ConsoleRequest): SavedRequest[] {
  const record: SavedRequest = { ...req, id: crypto.randomUUID(), name }
  const next = [record, ...loadSaved(connId)]
  write(savedKey(connId), next)
  return next
}

export function deleteSaved(connId: string, id: string): SavedRequest[] {
  const next = loadSaved(connId).filter((s) => s.id !== id)
  write(savedKey(connId), next)
  return next
}
