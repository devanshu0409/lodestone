import { useMemo, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import type { ClusterConnection, SaveConnectionPayload, TestConnectionResult } from '@shared/types'
import { useApp } from '../store'

// Deliberately spread across the hue wheel so no two tags read as
// "the same color at a glance" in the rail.
const TAG_COLORS = [
  '#6b7684', // slate (neutral)
  '#e5484d', // red
  '#f76b15', // orange
  '#f0b429', // yellow
  '#46a758', // green
  '#00b3c2', // cyan
  '#3e7bfa', // blue
  '#8b5cf6', // violet
  '#d6409f', // magenta
  '#a18072' // brown
]

interface Draft {
  name: string
  group: string
  color: string
  seedsText: string
  authType: 'none' | 'basic'
  username: string
  password: string
  insecureTls: boolean
  readOnly: boolean
}

function draftFrom(conn: ClusterConnection | undefined): Draft {
  return {
    name: conn?.name ?? '',
    group: conn?.group ?? '',
    color: conn?.color ?? TAG_COLORS[0],
    seedsText: conn?.seeds.join('\n') ?? '',
    authType: conn?.auth.type ?? 'none',
    username: conn?.auth.username ?? '',
    password: '',
    insecureTls: conn?.tls.insecure ?? false,
    readOnly: conn?.readOnly ?? false
  }
}

function validate(draft: Draft): { seeds: string[]; error: string | null } {
  const seeds = draft.seedsText
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
  if (!draft.name.trim()) return { seeds, error: 'Give this cluster a name.' }
  if (seeds.length === 0) return { seeds, error: 'Add at least one node URL.' }
  for (const s of seeds) {
    try {
      const u = new URL(s)
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error()
    } catch {
      return { seeds, error: `"${s}" is not a valid http(s) URL.` }
    }
  }
  if (draft.authType === 'basic' && !draft.username.trim()) {
    return { seeds, error: 'Basic auth needs a username.' }
  }
  return { seeds, error: null }
}

export function ConnectionDialog(): React.JSX.Element {
  const { dialogOpen, editingId, connections, closeDialog, saveConnection, deleteConnection } =
    useApp()
  const editing = connections.find((c) => c.id === editingId)
  const groups = [...new Set(connections.map((c) => c.group).filter((g): g is string => !!g))].sort()

  // Remount the form whenever the dialog target changes so state stays fresh.
  const formKey = `${dialogOpen}-${editingId ?? 'new'}`
  return (
    <Dialog.Root open={dialogOpen} onOpenChange={(open) => !open && closeDialog()}>
      <Dialog.Portal>
        <Dialog.Overlay className="dlg-overlay" />
        <Dialog.Content
          className="dlg-content"
          aria-describedby={undefined}
          onOpenAutoFocus={(e) => {
            // Focus the name input instead of the whole dialog.
            const el = (e.target as HTMLElement)?.querySelector?.('input')
            if (el) {
              e.preventDefault()
              ;(el as HTMLInputElement).focus()
            }
          }}
        >
          <ConnectionForm
            key={formKey}
            editing={editing}
            groups={groups}
            onCancel={closeDialog}
            onSave={saveConnection}
            onDelete={deleteConnection}
          />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function ConnectionForm(props: {
  editing: ClusterConnection | undefined
  groups: string[]
  onCancel: () => void
  onSave: (payload: SaveConnectionPayload) => Promise<string | null>
  onDelete: (id: string) => Promise<void>
}): React.JSX.Element {
  const { editing } = props
  const [draft, setDraft] = useState<Draft>(() => draftFrom(editing))
  const [error, setError] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testResult, setTestResult] = useState<TestConnectionResult | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const set = <K extends keyof Draft>(key: K, value: Draft[K]): void => {
    setDraft((d) => ({ ...d, [key]: value }))
    setTestResult(null)
  }

  const payload = useMemo((): SaveConnectionPayload | null => {
    const { seeds, error } = validate(draft)
    if (error) return null
    return {
      connection: {
        id: editing?.id ?? crypto.randomUUID(),
        name: draft.name.trim(),
        seeds,
        auth: draft.authType === 'basic' ? { type: 'basic', username: draft.username.trim() } : { type: 'none' },
        tls: { insecure: draft.insecureTls },
        readOnly: draft.readOnly,
        group: draft.group.trim() || undefined,
        color: draft.color
      },
      secret:
        draft.authType === 'none'
          ? null // switching to no-auth clears any stored password
          : draft.password.length > 0
            ? draft.password
            : undefined // keep the stored one
    }
  }, [draft, editing])

  const runValidated = async (fn: (p: SaveConnectionPayload) => Promise<void>): Promise<void> => {
    const { error } = validate(draft)
    setError(error)
    if (error || !payload) return
    await fn(payload)
  }

  const test = (): Promise<void> =>
    runValidated(async (p) => {
      setTesting(true)
      setTestResult(null)
      const res = await window.lodestone.connections.test(p)
      setTestResult(res.ok ? res.data : { ok: false, message: res.error })
      setTesting(false)
    })

  const save = (): Promise<void> =>
    runValidated(async (p) => {
      setSaving(true)
      const err = await props.onSave(p)
      setSaving(false)
      if (err) setError(err)
    })

  return (
    <>
      <Dialog.Title className="dlg-title">
        {editing ? `Edit ${editing.name}` : 'Add cluster'}
      </Dialog.Title>

      <div className="dlg-form">
        <div className="dlg-row">
          <div className="field">
            <label htmlFor="cx-name">Name</label>
            <input
              id="cx-name"
              className="input"
              placeholder="e.g. logs — production"
              value={draft.name}
              onChange={(e) => set('name', e.target.value)}
            />
          </div>
          <div className="field">
            <label>Tag color</label>
            <div className="swatches" style={{ alignItems: 'center', height: 30 }}>
              {TAG_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`swatch ${draft.color === c ? 'on' : ''}`}
                  style={{ background: c }}
                  aria-label={`Tag color ${c}`}
                  onClick={() => set('color', c)}
                />
              ))}
            </div>
          </div>
        </div>

        <div className="field">
          <label htmlFor="cx-group">Folder</label>
          <input
            id="cx-group"
            className="input"
            list="cx-group-list"
            placeholder="Optional — e.g. Production, Team A"
            value={draft.group}
            onChange={(e) => set('group', e.target.value)}
          />
          <datalist id="cx-group-list">
            {props.groups.map((g) => (
              <option key={g} value={g} />
            ))}
          </datalist>
          <span className="hint">Group clusters into collapsible folders in the sidebar.</span>
        </div>

        <div className="field">
          <label htmlFor="cx-seeds">Node URLs</label>
          <textarea
            id="cx-seeds"
            className="input"
            rows={3}
            placeholder={'http://localhost:9200\nhttps://node2.internal:9200'}
            value={draft.seedsText}
            onChange={(e) => set('seedsText', e.target.value)}
          />
          <span className="hint">
            One URL per line. One node is enough — the rest of the cluster is discovered
            automatically.
          </span>
        </div>

        <div className="field">
          <label htmlFor="cx-auth">Authentication</label>
          <select
            id="cx-auth"
            className="input"
            value={draft.authType}
            onChange={(e) => set('authType', e.target.value as Draft['authType'])}
          >
            <option value="none">None</option>
            <option value="basic">Basic (username / password)</option>
          </select>
        </div>

        {draft.authType === 'basic' && (
          <div className="dlg-row">
            <div className="field">
              <label htmlFor="cx-user">Username</label>
              <input
                id="cx-user"
                className="input"
                autoComplete="off"
                value={draft.username}
                onChange={(e) => set('username', e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="cx-pass">Password</label>
              <input
                id="cx-pass"
                className="input"
                type="password"
                autoComplete="new-password"
                placeholder={editing?.hasSecret ? '•••••••• (unchanged)' : ''}
                value={draft.password}
                onChange={(e) => set('password', e.target.value)}
              />
            </div>
          </div>
        )}

        <label className="check">
          <input
            type="checkbox"
            checked={draft.insecureTls}
            onChange={(e) => set('insecureTls', e.target.checked)}
          />
          <span>
            Trust self-signed certificates
            <span className="check-sub" style={{ display: 'block' }}>
              Skips TLS verification for this cluster only.
            </span>
          </span>
        </label>

        <label className="check">
          <input
            type="checkbox"
            checked={draft.readOnly}
            onChange={(e) => set('readOnly', e.target.checked)}
          />
          <span>
            Read-only
            <span className="check-sub" style={{ display: 'block' }}>
              Blocks every request that would modify this cluster. Recommended for production.
            </span>
          </span>
        </label>

        {error && <div className="form-error">{error}</div>}
        {testResult && (
          <div className={`test-result ${testResult.ok ? 'ok' : 'fail'}`}>{testResult.message}</div>
        )}

        <div className="dlg-foot">
          {editing &&
            (confirmDelete ? (
              <button className="btn danger" onClick={() => void props.onDelete(editing.id)}>
                Confirm remove
              </button>
            ) : (
              <button className="btn ghost" onClick={() => setConfirmDelete(true)}>
                Remove
              </button>
            ))}
          <div className="spacer" />
          <button className="btn ghost" onClick={props.onCancel}>
            Cancel
          </button>
          <button className="btn" onClick={() => void test()} disabled={testing}>
            {testing ? 'Testing…' : 'Test connection'}
          </button>
          <button className="btn primary" onClick={() => void save()} disabled={saving}>
            {saving ? 'Saving…' : 'Save cluster'}
          </button>
        </div>
      </div>
    </>
  )
}
