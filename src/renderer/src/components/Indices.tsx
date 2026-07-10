import { useCallback, useEffect, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { MoreHorizontal, Plus, Search } from 'lucide-react'
import type { ClusterConnection } from '@shared/types'
import { useApp } from '../store'
import {
  aliasAction,
  createIndex,
  deleteIndex,
  fetchCatIndices,
  fetchIndexDetails,
  putIndexSettings,
  runIndexOp,
  INDEX_OP_LABEL,
  REFRESH_MS,
  type CatIndex,
  type IndexDetails,
  type IndexOp
} from '../lib/api'
import { formatBytes, formatCompact } from '../lib/format'
import { CodeEditor } from './CodeEditor'
import { ConfirmDialog, Menu, MenuItem, MenuSep } from './ui'

export function Indices({
  conn,
  onBrowse
}: {
  conn: ClusterConnection
  onBrowse: (index: string) => void
}): React.JSX.Element {
  const refreshNonce = useApp((s) => s.refreshNonce)
  const pushToast = useApp((s) => s.pushToast)
  const [indices, setIndices] = useState<CatIndex[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [showSystem, setShowSystem] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [detailsIndex, setDetailsIndex] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)

  const load = useCallback((): void => {
    fetchCatIndices(conn.id)
      .then((list) => {
        setIndices(list)
        setError(null)
      })
      .catch((err: Error) => setError(err.message))
  }, [conn.id])

  useEffect(() => {
    load()
    const t = setInterval(load, REFRESH_MS)
    return () => clearInterval(t)
  }, [load, refreshNonce])

  const op = async (index: string, kind: IndexOp): Promise<void> => {
    try {
      await runIndexOp(conn.id, index, kind)
      pushToast('ok', `${INDEX_OP_LABEL[kind]} — ${index}: done`)
      load()
    } catch (err) {
      pushToast('err', (err as Error).message)
    }
  }

  const remove = async (): Promise<void> => {
    if (!deleteTarget) return
    try {
      await deleteIndex(conn.id, deleteTarget)
      pushToast('ok', `Deleted ${deleteTarget}`)
      setDeleteTarget(null)
      load()
    } catch (err) {
      pushToast('err', (err as Error).message)
      setDeleteTarget(null)
    }
  }

  if (error && !indices) {
    return (
      <div className="state-screen">
        <h2>Can’t load indices</h2>
        <div className="err">{error}</div>
      </div>
    )
  }

  if (!indices) {
    return (
      <div className="state-screen">
        <div className="spinner" />
      </div>
    )
  }

  const systemCount = indices.filter((i) => i.index.startsWith('.')).length
  const needle = filter.trim().toLowerCase()
  const visible = indices.filter((i) => {
    if (!showSystem && i.index.startsWith('.')) return false
    return needle === '' || i.index.toLowerCase().includes(needle)
  })

  return (
    <div className="shards-view">
      <div className="grid-toolbar">
        <input
          className="input"
          style={{ width: 220 }}
          placeholder="Filter indices"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        {systemCount > 0 && (
          <label className="check" style={{ alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={showSystem}
              onChange={(e) => setShowSystem(e.target.checked)}
            />
            <span>System indices ({systemCount})</span>
          </label>
        )}
        <div className="spacer" />
        {error && <span className="form-error">refresh failed: {error}</span>}
        <button className="btn primary" onClick={() => setCreateOpen(true)}>
          <Plus size={13} />
          Create index
        </button>
      </div>

      <div className="shard-grid-wrap" style={{ marginBottom: 14 }}>
        <table className="data-table" style={{ border: 'none' }}>
          <thead>
            <tr>
              <th style={{ width: '40%' }}>Index</th>
              <th>Status</th>
              <th>Shards</th>
              <th>Docs</th>
              <th>Size</th>
              <th style={{ width: 90 }}></th>
            </tr>
          </thead>
          <tbody>
            {visible.map((idx) => (
              <tr key={idx.index}>
                <td>
                  <span className="sg-index-row">
                    <span className={`health-led ${idx.health}`} />
                    <button className="link-btn mono" onClick={() => setDetailsIndex(idx.index)}>
                      {idx.index}
                    </button>
                  </span>
                </td>
                <td className="mono">{idx.status}</td>
                <td className="mono">
                  {idx.primaries}×{idx.replicas + 1}
                </td>
                <td className="mono">{formatCompact(idx.docs)}</td>
                <td className="mono">{formatBytes(idx.storeBytes)}</td>
                <td>
                  <span style={{ display: 'inline-flex', gap: 4 }}>
                    <button
                      className="icon-btn"
                      title="Browse documents"
                      onClick={() => onBrowse(idx.index)}
                    >
                      <Search size={13} />
                    </button>
                    <Menu
                      trigger={
                        <button className="icon-btn" title="Actions">
                          <MoreHorizontal size={14} />
                        </button>
                      }
                    >
                      <MenuItem onSelect={() => setDetailsIndex(idx.index)}>
                        Settings, mappings & aliases
                      </MenuItem>
                      <MenuSep />
                      <MenuItem onSelect={() => void op(idx.index, 'refresh')}>Refresh</MenuItem>
                      <MenuItem onSelect={() => void op(idx.index, 'flush')}>Flush</MenuItem>
                      <MenuItem onSelect={() => void op(idx.index, 'forcemerge')}>
                        Force-merge
                      </MenuItem>
                      {idx.status === 'close' ? (
                        <MenuItem onSelect={() => void op(idx.index, 'open')}>Open</MenuItem>
                      ) : (
                        <MenuItem onSelect={() => void op(idx.index, 'close')}>Close</MenuItem>
                      )}
                      <MenuSep />
                      <MenuItem danger onSelect={() => setDeleteTarget(idx.index)}>
                        Delete index…
                      </MenuItem>
                    </Menu>
                  </span>
                </td>
              </tr>
            ))}
            {visible.length === 0 && (
              <tr>
                <td colSpan={6} className="sg-empty">
                  {indices.length === 0
                    ? 'This cluster has no indices yet.'
                    : 'No indices match the filter.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <CreateIndexDialog
        conn={conn}
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          setCreateOpen(false)
          load()
        }}
      />

      {detailsIndex && (
        <IndexDetailsDialog
          conn={conn}
          index={detailsIndex}
          onClose={() => setDetailsIndex(null)}
          onChanged={load}
        />
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        title={`Delete ${deleteTarget}?`}
        body={
          <>
            This permanently removes the index and all of its documents from{' '}
            <strong>{conn.name}</strong>. There is no undo.
          </>
        }
        confirmLabel="Delete index"
        requireText={deleteTarget ?? ''}
        onConfirm={remove}
        onClose={() => setDeleteTarget(null)}
      />
    </div>
  )
}

/* ---------- create index ---------- */

const CREATE_TEMPLATE = `{
  "settings": {
    "number_of_shards": 1,
    "number_of_replicas": 1
  },
  "mappings": {
    "properties": {
    }
  }
}`

function CreateIndexDialog({
  conn,
  open,
  onClose,
  onCreated
}: {
  conn: ClusterConnection
  open: boolean
  onClose: () => void
  onCreated: () => void
}): React.JSX.Element {
  const pushToast = useApp((s) => s.pushToast)
  const [name, setName] = useState('')
  const [json, setJson] = useState(CREATE_TEMPLATE)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const create = async (): Promise<void> => {
    const trimmed = name.trim()
    if (!trimmed) {
      setError('Give the index a name.')
      return
    }
    let body: unknown
    try {
      body = JSON.parse(json)
    } catch {
      setError('Settings/mappings is not valid JSON.')
      return
    }
    setBusy(true)
    try {
      await createIndex(conn.id, trimmed, body)
      pushToast('ok', `Created ${trimmed}`)
      setName('')
      setJson(CREATE_TEMPLATE)
      setError(null)
      onCreated()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="dlg-overlay" />
        <Dialog.Content className="dlg-content" aria-describedby={undefined} style={{ width: 560 }}>
          <Dialog.Title className="dlg-title">Create index</Dialog.Title>
          <div className="dlg-form">
            <div className="field">
              <label htmlFor="ci-name">Name</label>
              <input
                id="ci-name"
                className="input mono"
                placeholder="e.g. logs-2026.07"
                value={name}
                onChange={(e) => setName(e.target.value)}
                spellCheck={false}
              />
            </div>
            <div className="field">
              <label>Settings & mappings</label>
              <CodeEditor value={json} onChange={setJson} height={240} />
            </div>
            {error && <div className="form-error">{error}</div>}
            <div className="dlg-foot">
              <div className="spacer" />
              <button className="btn ghost" onClick={onClose}>
                Cancel
              </button>
              <button className="btn primary" disabled={busy} onClick={() => void create()}>
                {busy ? 'Creating…' : 'Create index'}
              </button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/* ---------- details: settings / mappings / aliases ---------- */

function IndexDetailsDialog({
  conn,
  index,
  onClose,
  onChanged
}: {
  conn: ClusterConnection
  index: string
  onClose: () => void
  onChanged: () => void
}): React.JSX.Element {
  const pushToast = useApp((s) => s.pushToast)
  const [details, setDetails] = useState<IndexDetails | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [section, setSection] = useState<'settings' | 'mappings' | 'aliases'>('settings')
  const [settingsJson, setSettingsJson] = useState('')
  const [newAlias, setNewAlias] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback((): void => {
    fetchIndexDetails(conn.id, index)
      .then((d) => {
        setDetails(d)
        setSettingsJson(JSON.stringify(d.settings, null, 2))
        setError(null)
      })
      .catch((err: Error) => setError(err.message))
  }, [conn.id, index])

  useEffect(load, [load])

  const saveSettings = async (): Promise<void> => {
    let parsed: { index?: Record<string, unknown> }
    try {
      parsed = JSON.parse(settingsJson)
    } catch {
      pushToast('err', 'Settings is not valid JSON.')
      return
    }
    // Only dynamic settings can be updated on a live index; strip the
    // static/private ones ES returns in GET _settings so the PUT succeeds.
    const STATIC = new Set([
      'creation_date',
      'uuid',
      'version',
      'provided_name',
      'number_of_shards',
      'routing_partition_size',
      'soft_deletes'
    ])
    const idx = { ...(parsed.index ?? {}) }
    for (const key of Object.keys(idx)) if (STATIC.has(key)) delete idx[key]
    setBusy(true)
    try {
      await putIndexSettings(conn.id, index, { index: idx })
      pushToast('ok', `Updated settings — ${index}`)
      load()
      onChanged()
    } catch (err) {
      pushToast('err', (err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const alias = async (action: 'add' | 'remove', name: string): Promise<void> => {
    try {
      await aliasAction(conn.id, action, index, name)
      pushToast('ok', `${action === 'add' ? 'Added' : 'Removed'} alias ${name}`)
      setNewAlias('')
      load()
      onChanged()
    } catch (err) {
      pushToast('err', (err as Error).message)
    }
  }

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="dlg-overlay" />
        <Dialog.Content className="dlg-content" aria-describedby={undefined} style={{ width: 640 }}>
          <Dialog.Title className="dlg-title mono">{index}</Dialog.Title>

          <nav className="tab-bar" style={{ padding: 0, marginBottom: 14 }}>
            {(['settings', 'mappings', 'aliases'] as const).map((s) => (
              <button key={s} className={`tab ${section === s ? 'on' : ''}`} onClick={() => setSection(s)}>
                {s}
              </button>
            ))}
          </nav>

          {error && <div className="test-result fail">{error}</div>}
          {!details && !error && (
            <div style={{ display: 'flex', justifyContent: 'center', padding: 24 }}>
              <div className="spinner" />
            </div>
          )}

          {details && section === 'settings' && (
            <div className="dlg-form">
              <CodeEditor value={settingsJson} onChange={setSettingsJson} height={280} />
              <span className="hint" style={{ fontSize: 11, color: 'var(--ink-3)' }}>
                Static settings (shard count, uuid, …) are stripped automatically — only dynamic
                settings are sent.
              </span>
              <div className="dlg-foot">
                <div className="spacer" />
                <button className="btn primary" disabled={busy} onClick={() => void saveSettings()}>
                  {busy ? 'Saving…' : 'Save settings'}
                </button>
              </div>
            </div>
          )}

          {details && section === 'mappings' && (
            <CodeEditor value={JSON.stringify(details.mappings, null, 2)} readOnly height={320} />
          )}

          {details && section === 'aliases' && (
            <div className="dlg-form">
              {details.aliases.length === 0 && (
                <p style={{ fontSize: 12.5, color: 'var(--ink-3)' }}>
                  No aliases point to this index yet.
                </p>
              )}
              {details.aliases.map((a) => (
                <div key={a} className="alias-row">
                  <span className="mono">{a}</span>
                  <button className="btn ghost" onClick={() => void alias('remove', a)}>
                    Remove
                  </button>
                </div>
              ))}
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  className="input mono"
                  placeholder="new-alias-name"
                  value={newAlias}
                  onChange={(e) => setNewAlias(e.target.value)}
                  spellCheck={false}
                />
                <button
                  className="btn"
                  disabled={!newAlias.trim()}
                  onClick={() => void alias('add', newAlias.trim())}
                >
                  Add alias
                </button>
              </div>
            </div>
          )}

          <div className="dlg-foot">
            <div className="spacer" />
            <button className="btn ghost" onClick={onClose}>
              Close
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
