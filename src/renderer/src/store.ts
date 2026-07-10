import { create } from 'zustand'
import type { ClusterConnection, ClusterOverview, SaveConnectionPayload } from '@shared/types'

export type SessionStatus = 'idle' | 'connecting' | 'connected' | 'error'

export interface Session {
  status: SessionStatus
  overview?: ClusterOverview
  error?: string
}

interface AppState {
  connections: ClusterConnection[]
  loaded: boolean
  activeId: string | null
  sessions: Record<string, Session>
  dialogOpen: boolean
  editingId: string | null
  /** Bumped by the context-bar refresh button; live views re-fetch when it changes. */
  refreshNonce: number
  toasts: Toast[]

  bumpRefresh(): void
  pushToast(kind: Toast['kind'], text: string): void
  dismissToast(id: number): void
  loadConnections(): Promise<void>
  openDialog(editingId?: string): void
  closeDialog(): void
  saveConnection(payload: SaveConnectionPayload): Promise<string | null>
  deleteConnection(id: string): Promise<void>
  cloneConnection(id: string): Promise<void>
  /** Reassign a cluster's folder without disturbing its live session. */
  moveConnection(id: string, group: string): Promise<void>
  selectCluster(id: string): void
  connect(id: string, opts?: { silent?: boolean }): Promise<void>
  disconnect(id: string): void
}

const idle: Session = { status: 'idle' }

export interface Toast {
  id: number
  kind: 'ok' | 'err'
  text: string
}

let toastSeq = 0

export const useApp = create<AppState>((set, get) => ({
  connections: [],
  loaded: false,
  activeId: null,
  sessions: {},
  dialogOpen: false,
  editingId: null,
  refreshNonce: 0,
  toasts: [],

  bumpRefresh: () => set((s) => ({ refreshNonce: s.refreshNonce + 1 })),

  pushToast: (kind, text) => {
    const id = ++toastSeq
    set((s) => ({ toasts: [...s.toasts, { id, kind, text }] }))
    setTimeout(() => get().dismissToast(id), kind === 'err' ? 6500 : 3500)
  },

  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  loadConnections: async () => {
    const res = await window.lodestone.connections.list()
    if (res.ok) set({ connections: res.data, loaded: true })
  },

  openDialog: (editingId) => set({ dialogOpen: true, editingId: editingId ?? null }),
  closeDialog: () => set({ dialogOpen: false, editingId: null }),

  saveConnection: async (payload) => {
    const res = await window.lodestone.connections.save(payload)
    if (!res.ok) return res.error
    await get().loadConnections()
    // Settings may have changed (seeds/auth) — drop any live session so the
    // next connect uses them.
    get().disconnect(payload.connection.id)
    set({ dialogOpen: false, editingId: null, activeId: payload.connection.id })
    void get().connect(payload.connection.id)
    return null
  },

  deleteConnection: async (id) => {
    await window.lodestone.connections.delete(id)
    const { activeId, sessions } = get()
    const rest = { ...sessions }
    delete rest[id]
    set({
      sessions: rest,
      activeId: activeId === id ? null : activeId,
      dialogOpen: false,
      editingId: null
    })
    await get().loadConnections()
  },

  cloneConnection: async (id) => {
    const conn = get().connections.find((c) => c.id === id)
    if (!conn) return
    const { hasSecret: _hasSecret, ...rest } = conn
    const newId = crypto.randomUUID()
    // secret: undefined keeps any existing secret for this id — a brand-new id
    // has none, so the clone starts without a password (edit to add one).
    await window.lodestone.connections.save({
      connection: { ...rest, id: newId, name: `${conn.name} (copy)` },
      secret: undefined
    })
    await get().loadConnections()
    set({ activeId: newId })
  },

  moveConnection: async (id, group) => {
    const conn = get().connections.find((c) => c.id === id)
    if (!conn || (conn.group ?? '') === group) return
    const { hasSecret: _hasSecret, ...rest } = conn
    await window.lodestone.connections.save({
      connection: { ...rest, group },
      secret: undefined
    })
    await get().loadConnections()
  },

  selectCluster: (id) => {
    set({ activeId: id })
    const status = get().sessions[id]?.status ?? 'idle'
    if (status === 'idle' || status === 'error') void get().connect(id)
  },

  connect: async (id, opts) => {
    const current = get().sessions[id] ?? idle
    if (current.status === 'connecting') return
    if (!opts?.silent || current.status !== 'connected') {
      set((s) => ({ sessions: { ...s.sessions, [id]: { ...current, status: 'connecting' } } }))
    }
    const res = await window.lodestone.cluster.connect(id)
    set((s) => ({
      sessions: {
        ...s.sessions,
        [id]: res.ok
          ? { status: 'connected', overview: res.data }
          : { status: 'error', error: res.error, overview: current.overview }
      }
    }))
  },

  disconnect: (id) => {
    void window.lodestone.cluster.disconnect(id)
    set((s) => {
      const rest = { ...s.sessions }
      delete rest[id]
      return { sessions: rest }
    })
  }
}))
