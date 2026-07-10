import { useMemo, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import type { ClusterConnection } from '@shared/types'
import { useApp } from '../store'
import { deleteDocument, saveDocument, type SearchHit } from '../lib/api'
import { CodeEditor } from './CodeEditor'
import { ConfirmDialog } from './ui'

export function DocDrawer({
  conn,
  hit,
  onClose,
  onSaved,
  onDeleted
}: {
  conn: ClusterConnection
  hit: SearchHit
  onClose: () => void
  /** Called with the new _source after a successful save (for optimistic UI). */
  onSaved: (source: Record<string, unknown>) => void
  /** Called after a successful delete. */
  onDeleted: () => void
}): React.JSX.Element {
  const pushToast = useApp((s) => s.pushToast)
  const initial = useMemo(() => JSON.stringify(hit._source, null, 2), [hit])
  const [json, setJson] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [confirmSave, setConfirmSave] = useState(false)
  const dirty = json !== initial

  /** Validate + ask for confirmation before writing (a save overwrites the doc). */
  const requestSave = (): void => {
    try {
      JSON.parse(json)
    } catch {
      pushToast('err', 'The document is not valid JSON.')
      return
    }
    setConfirmSave(true)
  }

  const save = async (): Promise<void> => {
    let parsed: unknown
    try {
      parsed = JSON.parse(json)
    } catch {
      pushToast('err', 'The document is not valid JSON.')
      return
    }
    setBusy(true)
    try {
      await saveDocument(conn.id, hit._index, hit._id, parsed)
      pushToast('ok', `Saved ${hit._id}`)
      setConfirmSave(false)
      onSaved(parsed as Record<string, unknown>)
    } catch (err) {
      pushToast('err', (err as Error).message)
      setConfirmSave(false)
    } finally {
      setBusy(false)
    }
  }

  const remove = async (): Promise<void> => {
    try {
      await deleteDocument(conn.id, hit._index, hit._id)
      pushToast('ok', `Deleted ${hit._id}`)
      setConfirmDelete(false)
      onDeleted()
    } catch (err) {
      pushToast('err', (err as Error).message)
      setConfirmDelete(false)
    }
  }

  return (
    <>
      <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
        <Dialog.Portal>
          <Dialog.Overlay className="dlg-overlay" />
          <Dialog.Content
            className="dlg-content"
            aria-describedby={undefined}
            style={{ width: 640 }}
          >
            <Dialog.Title className="dlg-title mono">
              {hit._index} / {hit._id}
              {dirty && <span className="chip" style={{ marginLeft: 8 }}>unsaved</span>}
            </Dialog.Title>
            <div className="dlg-form">
              <div className="doc-meta">
                <span className="doc-meta-item">
                  <span className="doc-meta-k">_index</span>
                  <span className="doc-meta-v mono">{hit._index}</span>
                </span>
                <span className="doc-meta-item">
                  <span className="doc-meta-k">_id</span>
                  <span className="doc-meta-v mono">{hit._id}</span>
                </span>
                {hit._score != null && (
                  <span className="doc-meta-item">
                    <span className="doc-meta-k">_score</span>
                    <span className="doc-meta-v mono">{hit._score}</span>
                  </span>
                )}
              </div>
              <span className="hint" style={{ fontSize: 11, color: 'var(--ink-3)' }}>
                Editing <span className="mono">_source</span> — saving replaces the whole document.
              </span>
              <CodeEditor value={json} onChange={setJson} height={340} />
              <div className="dlg-foot">
                <button className="btn danger" onClick={() => setConfirmDelete(true)}>
                  Delete…
                </button>
                <div className="spacer" />
                <button className="btn ghost" onClick={onClose}>
                  Close
                </button>
                <button className="btn primary" disabled={busy || !dirty} onClick={requestSave}>
                  {busy ? 'Saving…' : 'Save document'}
                </button>
              </div>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <ConfirmDialog
        open={confirmSave}
        title={`Update document ${hit._id}?`}
        body={
          <>
            Overwrites this document in <span className="mono">{hit._index}</span> on{' '}
            <strong>{conn.name}</strong> with the edited <span className="mono">_source</span>.
          </>
        }
        confirmLabel="Update document"
        onConfirm={save}
        onClose={() => setConfirmSave(false)}
      />

      <ConfirmDialog
        open={confirmDelete}
        title={`Delete document ${hit._id}?`}
        body={
          <>
            Removes this document from <span className="mono">{hit._index}</span> on{' '}
            <strong>{conn.name}</strong>. There is no undo.
          </>
        }
        confirmLabel="Delete document"
        onConfirm={remove}
        onClose={() => setConfirmDelete(false)}
      />
    </>
  )
}
