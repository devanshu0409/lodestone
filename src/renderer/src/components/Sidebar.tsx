import { useEffect, useRef, useState } from 'react'
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
  Pin,
  PanelLeftClose
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
const PIN_KEY = 'lodestone.rail.pinned' // pinned = full sidebar column; unpinned = icon strip + hover flyout

// Hover intent: don't flash the flyout open on a drive-by cursor, and don't
// snap it shut when the pointer briefly exits while moving to a menu.
const HOVER_OPEN_MS = 140
const HOVER_CLOSE_MS = 240

const APP_VERSION =
  typeof __APP_VERSION__ === 'string' && __APP_VERSION__ ? `v${__APP_VERSION__}` : ''

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
  const [extraFolders, setExtraFolders] = useState<string[]>(loadFolders)
  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState('')
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropGroup, setDropGroup] = useState<string | null>(null)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  // Pinned (default) = sidebar is a fixed column. Unpinned = icon strip; the
  // full sidebar appears as a flyout while hovering.
  const [pinned, setPinned] = useState<boolean>(() => localStorage.getItem(PIN_KEY) !== '0')
  const [flyoutOpen, setFlyoutOpen] = useState(false)
  const hoverTimer = useRef<number | null>(null)

  const clearHoverTimer = (): void => {
    if (hoverTimer.current !== null) {
      window.clearTimeout(hoverTimer.current)
      hoverTimer.current = null
    }
  }

  const scheduleFlyout = (open: boolean): void => {
    clearHoverTimer()
    hoverTimer.current = window.setTimeout(
      () => setFlyoutOpen(open),
      open ? HOVER_OPEN_MS : HOVER_CLOSE_MS
    )
  }

  const togglePin = (): void => {
    setPinned((p) => {
      localStorage.setItem(PIN_KEY, p ? '0' : '1')
      return !p
    })
    clearHoverTimer()
    setFlyoutOpen(false)
  }

  // Ctrl/Cmd+B toggles the sidebar, VS Code style.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        togglePin()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => clearHoverTimer, [])

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

  const handleSelect = (id: string): void => {
    selectCluster(id)
    if (!pinned) {
      clearHoverTimer()
      setFlyoutOpen(false)
    }
  }

  const fullSidebar = (
    <>
      <div className="rail-brand">
        <span className="wordmark">LODESTONE</span>
        {APP_VERSION && <span className="version">{APP_VERSION}</span>}
        <span className="spacer" />
        <button
          className="rail-pin"
          title={pinned ? 'Collapse sidebar (Ctrl+B)' : 'Pin sidebar open (Ctrl+B)'}
          onClick={togglePin}
        >
          {pinned ? <PanelLeftClose size={15} /> : <Pin size={14} />}
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
          const emptyRemovable = isUngrouped
            ? false
            : items.length === 0 && extraFolders.includes(group)
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
                    onSelect={() => handleSelect(conn.id)}
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
    </>
  )

  return (
    <>
      {pinned ? (
        <aside className="rail">{fullSidebar}</aside>
      ) : (
        <aside
          className={`rail mini ${flyoutOpen ? 'hovered' : ''}`}
          onMouseEnter={() => scheduleFlyout(true)}
          onMouseLeave={() => scheduleFlyout(false)}
        >
          <nav className="rail-mini-list">
            {ordered.map((group) => {
              const items = groups.get(group) ?? []
              if (items.length === 0) return null
              const isUngrouped = group === UNGROUPED
              return (
                <div key={group} className="rail-mini-group">
                  {hasFolders && (
                    <div className="rail-mini-sep" title={isUngrouped ? 'Ungrouped' : group}>
                      {isUngrouped ? '···' : group}
                    </div>
                  )}
                  {items.map((conn) => {
                    const session = sessions[conn.id]
                    const dot = statusDot(session)
                    return (
                      <button
                        key={conn.id}
                        className={`rail-mini-item ${activeId === conn.id ? 'active' : ''}`}
                        // The avatar carries the tag color when collapsed.
                        style={{ background: conn.color }}
                        title={`${conn.name}${conn.group ? ` — ${conn.group}` : ''}${
                          session?.status === 'connected' ? ' · connected' : ''
                        }`}
                        onClick={() => selectCluster(conn.id)}
                      >
                        <span className={`rail-mini-led ${dot}`} />
                        <span className="rail-mini-letter">
                          {conn.name.charAt(0).toUpperCase()}
                        </span>
                      </button>
                    )
                  })}
                </div>
              )
            })}
            <button className="rail-mini-item add" title="Add cluster" onClick={() => openDialog()}>
              <Plus size={14} />
            </button>
          </nav>
          <div className="rail-flyout">{fullSidebar}</div>
        </aside>
      )}

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
    </>
  )
}

/** Connection indicator: cluster health while connected, pulse while
 *  connecting, red when unreachable, dim when idle. Independent of tag color. */
function statusDot(session: Session | undefined): string {
  if (session?.status === 'connected') return session.overview?.health.status ?? 'green'
  if (session?.status === 'connecting') return 'connecting'
  if (session?.status === 'error') return 'red'
  return 'off'
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
      // Warp-style: the row itself is tinted with the tag color (see app.css).
      style={{ ['--tag' as string]: conn.color }}
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
      <span className={`conn-dot ${statusDot(session)}`} title={connected ? 'connected' : undefined} />
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
