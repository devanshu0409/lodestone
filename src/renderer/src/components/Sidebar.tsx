import { useState } from 'react'
import {
  Plus,
  Lock,
  Sun,
  Moon,
  Monitor,
  ChevronRight,
  MoreVertical,
  FolderPlus,
  Pencil,
  Copy,
  Trash2,
  PanelLeftClose,
  PanelLeftOpen
} from 'lucide-react'
import type { ClusterConnection } from '@shared/types'
import { useApp, type Session } from '../store'
import { useTheme, type ThemePref } from '../theme'
import { hostOf } from '../lib/format'
import { Menu, MenuItem, MenuSep, ConfirmDialog } from './ui'

const THEME_OPTIONS: { pref: ThemePref; icon: typeof Sun; label: string }[] = [
  { pref: 'light', icon: Sun, label: 'Light theme' },
  { pref: 'system', icon: Monitor, label: 'Follow system theme' },
  { pref: 'dark', icon: Moon, label: 'Dark theme' }
]

const UNGROUPED = ' ungrouped' // sorts/render last; never a real folder name
const COLLAPSE_KEY = 'lodestone.rail.collapsed'
const FOLDERS_KEY = 'lodestone.rail.folders' // folders that exist before any cluster joins them
const MINI_KEY = 'lodestone.rail.mini' // whole-sidebar collapsed state

function loadCollapsed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? '[]') as string[])
  } catch {
    return new Set()
  }
}

function loadFolders(): string[] {
  try {
    return JSON.parse(localStorage.getItem(FOLDERS_KEY) ?? '[]') as string[]
  } catch {
    return []
  }
}

export function Sidebar(): React.JSX.Element {
  const {
    connections,
    activeId,
    sessions,
    selectCluster,
    openDialog,
    cloneConnection,
    moveConnection,
    deleteConnection
  } = useApp()
  const { pref, setPref } = useTheme()
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed)
  const [mini, setMini] = useState<boolean>(() => localStorage.getItem(MINI_KEY) === '1')
  const [extraFolders, setExtraFolders] = useState<string[]>(loadFolders)
  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState('')
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropGroup, setDropGroup] = useState<string | null>(null)
  const [confirmId, setConfirmId] = useState<string | null>(null)

  const toggle = (group: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      next.has(group) ? next.delete(group) : next.add(group)
      localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...next]))
      return next
    })
  }

  const persistFolders = (next: string[]): void => {
    setExtraFolders(next)
    localStorage.setItem(FOLDERS_KEY, JSON.stringify(next))
  }

  // Group connections by folder, preserving insertion order within each group.
  const groups = new Map<string, ClusterConnection[]>()
  for (const conn of connections) {
    const key = conn.group?.trim() || UNGROUPED
    const list = groups.get(key) ?? []
    list.push(conn)
    groups.set(key, list)
  }
  // Surface folders that exist but have no members yet.
  for (const f of extraFolders) if (f && !groups.has(f)) groups.set(f, [])

  const named = [...groups.keys()].filter((g) => g !== UNGROUPED).sort((a, b) => a.localeCompare(b))
  const hasFolders = named.length > 0
  // When folders exist we always show an Ungrouped drop zone so a cluster can be
  // dragged back out of a folder even if nothing else is ungrouped.
  const showUngrouped = groups.has(UNGROUPED) || hasFolders
  const ordered = [...named, ...(showUngrouped ? [UNGROUPED] : [])]

  const commitNewFolder = (): void => {
    const name = newName.trim()
    setAdding(false)
    setNewName('')
    if (!name || name === UNGROUPED || groups.has(name)) return
    persistFolders([...new Set([...extraFolders, name])])
  }

  const removeFolder = (name: string): void => {
    persistFolders(extraFolders.filter((f) => f !== name))
  }

  const dropHandlers = (group: string): React.HTMLAttributes<HTMLDivElement> => ({
    onDragOver: (e) => {
      if (!dragId) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      if (dropGroup !== group) setDropGroup(group)
    },
    onDragLeave: (e) => {
      // Only clear when leaving the whole group box, not a child.
      if (!e.currentTarget.contains(e.relatedTarget as Node)) {
        setDropGroup((g) => (g === group ? null : g))
      }
    },
    onDrop: (e) => {
      e.preventDefault()
      const id = e.dataTransfer.getData('text/plain') || dragId
      setDropGroup(null)
      setDragId(null)
      if (id) void moveConnection(id, group === UNGROUPED ? '' : group)
    }
  })

  const confirmConn = connections.find((c) => c.id === confirmId) ?? null

  const toggleMini = (): void => {
    setMini((m) => {
      localStorage.setItem(MINI_KEY, m ? '0' : '1')
      return !m
    })
  }

  if (mini) {
    return (
      <aside className="rail mini">
        <button className="rail-mini-toggle" title="Expand sidebar" onClick={toggleMini}>
          <PanelLeftOpen size={15} />
        </button>
        <nav className="rail-mini-list">
          {connections.map((conn) => {
            const status = sessions[conn.id]?.status
            return (
              <button
                key={conn.id}
                className={`rail-mini-item ${activeId === conn.id ? 'active' : ''} ${status === 'connected' ? 'connected' : ''}`}
                title={`${conn.name}${conn.group ? ` — ${conn.group}` : ''}${status === 'connected' ? ' (connected)' : ''}`}
                onClick={() => selectCluster(conn.id)}
              >
                <span className="rail-mini-led" style={{ background: conn.color, color: conn.color }} />
                <span className="rail-mini-letter">{conn.name.charAt(0).toUpperCase()}</span>
              </button>
            )
          })}
          <button className="rail-mini-item add" title="Add cluster" onClick={() => openDialog()}>
            <Plus size={14} />
          </button>
        </nav>
      </aside>
    )
  }

  return (
    <aside className="rail">
      <div className="rail-brand">
        <span className="wordmark">LODESTONE</span>
        <span className="version">v0.2</span>
        <span className="spacer" />
        <button className="rail-mini-toggle inline" title="Collapse sidebar" onClick={toggleMini}>
          <PanelLeftClose size={15} />
        </button>
      </div>

      <div className="rail-label">
        Clusters
        <button className="rail-label-add" title="New folder" onClick={() => setAdding(true)}>
          <FolderPlus size={13} />
        </button>
      </div>

      <nav className="rail-list">
        {adding && (
          <input
            className="input mono rail-folder-input"
            autoFocus
            placeholder="Folder name…"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onBlur={commitNewFolder}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitNewFolder()
              else if (e.key === 'Escape') {
                setAdding(false)
                setNewName('')
              }
            }}
          />
        )}
        {ordered.map((group) => {
          const items = groups.get(group) ?? []
          const isUngrouped = group === UNGROUPED
          const showHeader = !isUngrouped || hasFolders
          const isCollapsed = collapsed.has(group)
          const emptyRemovable = isUngrouped ? false : items.length === 0 && extraFolders.includes(group)
          return (
            <div
              key={group}
              className={`rail-group ${dropGroup === group ? 'drop-target' : ''}`}
              {...dropHandlers(group)}
            >
              {showHeader && (
                <div className="folder-head" onClick={() => toggle(group)}>
                  <ChevronRight size={12} className={`folder-caret ${isCollapsed ? '' : 'open'}`} />
                  <span className="folder-name">{isUngrouped ? 'Ungrouped' : group}</span>
                  <span className="folder-count">{items.length}</span>
                  {emptyRemovable && (
                    <button
                      className="folder-del"
                      title="Delete empty folder"
                      onClick={(e) => {
                        e.stopPropagation()
                        removeFolder(group)
                      }}
                    >
                      <Trash2 size={12} />
                    </button>
                  )}
                </div>
              )}
              {!isCollapsed &&
                items.map((conn) => (
                  <ClusterItem
                    key={conn.id}
                    conn={conn}
                    active={activeId === conn.id}
                    session={sessions[conn.id]}
                    indented={showHeader}
                    dragging={dragId === conn.id}
                    onSelect={() => selectCluster(conn.id)}
                    onEdit={() => openDialog(conn.id)}
                    onClone={() => void cloneConnection(conn.id)}
                    onDelete={() => setConfirmId(conn.id)}
                    onDragStart={(e) => {
                      e.dataTransfer.setData('text/plain', conn.id)
                      e.dataTransfer.effectAllowed = 'move'
                      setDragId(conn.id)
                    }}
                    onDragEnd={() => {
                      setDragId(null)
                      setDropGroup(null)
                    }}
                  />
                ))}
            </div>
          )
        })}
        <button className="rail-add" onClick={() => openDialog()}>
          <Plus size={13} />
          Add cluster
        </button>
      </nav>

      <div className="rail-foot">
        <div className="seg" role="radiogroup" aria-label="Theme">
          {THEME_OPTIONS.map(({ pref: p, icon: Icon, label }) => (
            <button
              key={p}
              className={pref === p ? 'on' : ''}
              role="radio"
              aria-checked={pref === p}
              title={label}
              onClick={() => setPref(p)}
            >
              <Icon size={13} />
            </button>
          ))}
        </div>
      </div>

      <ConfirmDialog
        open={confirmId !== null}
        title={`Delete ${confirmConn?.name ?? 'cluster'}?`}
        body={
          <>
            Removes this connection from Lodestone. Your cluster and its data are untouched — only
            the saved connection (and its stored password) is deleted.
          </>
        }
        confirmLabel="Delete connection"
        onConfirm={async () => {
          if (confirmId) await deleteConnection(confirmId)
          setConfirmId(null)
        }}
        onClose={() => setConfirmId(null)}
      />
    </aside>
  )
}

function ClusterItem({
  conn,
  active,
  session,
  indented,
  dragging,
  onSelect,
  onEdit,
  onClone,
  onDelete,
  onDragStart,
  onDragEnd
}: {
  conn: ClusterConnection
  active: boolean
  session: Session | undefined
  indented: boolean
  dragging: boolean
  onSelect: () => void
  onEdit: () => void
  onClone: () => void
  onDelete: () => void
  onDragStart: (e: React.DragEvent) => void
  onDragEnd: () => void
}): React.JSX.Element {
  const connected = session?.status === 'connected'
  const sub = connected
    ? `${session!.overview!.info.distribution === 'opensearch' ? 'opensearch' : 'es'} ${session!.overview!.info.version}`
    : session?.status === 'connecting'
      ? 'connecting…'
      : session?.status === 'error'
        ? 'unreachable'
        : hostOf(conn.seeds[0] ?? '')
  return (
    <div
      className={`cluster-item ${active ? 'active' : ''} ${connected ? 'connected' : ''} ${indented ? 'indented' : ''} ${dragging ? 'dragging' : ''}`}
      role="button"
      tabIndex={0}
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect()
        }
      }}
    >
      <span className="led" style={{ background: conn.color, color: conn.color }} />
      <span className="c-text">
        <span className="c-name" style={{ display: 'block' }}>
          {conn.name}
        </span>
        <span className="c-sub" style={{ display: 'block' }}>
          {sub}
        </span>
      </span>
      {conn.readOnly && (
        <span className="c-lock" title="Read-only">
          <Lock size={11} />
        </span>
      )}
      <Menu
        trigger={
          <button
            className="cluster-kebab"
            title="Cluster actions"
            onClick={(e) => e.stopPropagation()}
          >
            <MoreVertical size={14} />
          </button>
        }
      >
        <MenuItem onSelect={onEdit}>
          <Pencil size={13} /> Edit…
        </MenuItem>
        <MenuItem onSelect={onClone}>
          <Copy size={13} /> Clone
        </MenuItem>
        <MenuSep />
        <MenuItem danger onSelect={onDelete}>
          <Trash2 size={13} /> Delete…
        </MenuItem>
      </Menu>
    </div>
  )
}
