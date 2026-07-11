import { useMemo, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { Database, Info, Loader2 } from 'lucide-react'
import type { ClusterConnection } from '@shared/types'
import { useApp } from '../store'
import { bulkLoad } from '../lib/api'
import { generateFixtures } from '../lib/fixtureGen'
import type { MappingRoot } from '../lib/codegen'
import { CodeEditor } from './CodeEditor'

export function FixtureGeneratorDialog({
  conn,
  index,
  mappings,
  open,
  onClose,
  onLoaded
}: {
  conn: ClusterConnection
  index: string
  mappings: unknown
  open: boolean
  onClose: () => void
  onLoaded: () => void
}): React.JSX.Element {
  const pushToast = useApp((s) => s.pushToast)
  const [count, setCount] = useState(1000)
  const [seed, setSeed] = useState(42)
  const [loading, setLoading] = useState(false)
  const [confirmText, setConfirmText] = useState('')

  const mapping = mappings as MappingRoot

  const result = useMemo(() => {
    if (!mapping?.properties) return null
    return generateFixtures(mapping, { count, seed })
  }, [mapping, count, seed])

  const preview = useMemo(() => {
    if (!result) return ''
    return JSON.stringify(result.samples, null, 2)
  }, [result])

  const doLoad = async (): Promise<void> => {
    if (!result) return
    setLoading(true)
    try {
      const res = await bulkLoad(conn.id, index, result.ndjson)
      if (res.errors) {
        pushToast('err', `Bulk loaded with errors — check response. Took ${res.took}ms`)
      } else {
        pushToast('ok', `Loaded ${count.toLocaleString()} documents into ${index} (${res.took}ms)`)
      }
      setConfirmText('')
      onLoaded()
      onClose()
    } catch (err) {
      pushToast('err', (err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  const armed = confirmText === index

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="dlg-overlay" />
        <Dialog.Content className="dlg-content" aria-describedby={undefined} style={{ width: 640 }}>
          <Dialog.Title className="dlg-title">
            <Database size={15} style={{ marginRight: 6, verticalAlign: 'middle' }} />
            Generate fixture data — <span className="mono">{index}</span>
          </Dialog.Title>

          <div className="dlg-form">
            <span className="hint" style={{ fontSize: 12, color: 'var(--ink-2)' }}>
              Generate plausible test documents inferred from the field types and names in this index's
              mapping, then bulk-load them. Useful for populating a dev cluster without touching shared
              staging data.
            </span>

            {!mapping?.properties && (
              <div className="form-error">
                This index has no mapping properties — cannot generate fixtures.
              </div>
            )}

            {mapping?.properties && (
              <>
                <div className="fixture-controls">
                  <div className="field">
                    <label htmlFor="fx-count">Document count</label>
                    <input
                      id="fx-count"
                      className="input mono"
                      type="number"
                      min={1}
                      max={100000}
                      value={count}
                      onChange={(e) => setCount(Math.max(1, Math.min(100000, Number(e.target.value) || 1)))}
                      placeholder="e.g. 1000"
                    />
                    <span className="hint" style={{ fontSize: 10.5, color: 'var(--ink-3)' }}>
                      Quick picks: 
                      {[100, 500, 1000, 5000, 10000, 50000].map((n, i) => (
                        <button key={n} className="quick-pick-btn" onClick={() => setCount(n)}>
                          {n.toLocaleString()}{i < 5 ? ' ·' : ''}
                        </button>
                      ))}
                    </span>
                  </div>
                  <div className="field">
                    <label htmlFor="fx-seed" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      Random seed
                      <span className="seed-info-icon" title="The seed determines which set of fake data you get. Same seed = same data every time. Change it to get different data.">
                        <Info size={12} />
                      </span>
                    </label>
                    <input
                      id="fx-seed"
                      className="input mono"
                      type="number"
                      value={seed}
                      onChange={(e) => setSeed(Number(e.target.value))}
                    />
                  </div>
                </div>

                <div className="fixture-preview-label">
                  Preview (first {result?.samples.length ?? 0} documents)
                </div>
                <CodeEditor value={preview} readOnly height={200} />

                <div className="fixture-confirm-zone">
                  <div className="fixture-warning">
                    You are about to bulk-load <strong>{count.toLocaleString()}</strong> documents into{' '}
                    <strong className="mono">{index}</strong> on cluster{' '}
                    <strong>{conn.name}</strong>. This action cannot be undone.
                  </div>
                  <div className="field">
                    <label>
                      Type <span className="mono" style={{ color: 'var(--danger)' }}>{index}</span> to confirm
                    </label>
                    <input
                      className="input mono"
                      value={confirmText}
                      onChange={(e) => setConfirmText(e.target.value)}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder={index}
                    />
                  </div>
                </div>
              </>
            )}

            <div className="dlg-foot">
              <div className="spacer" />
              <button className="btn ghost" onClick={onClose}>
                Cancel
              </button>
              <button
                className="btn primary"
                disabled={!armed || loading || !result}
                onClick={() => void doLoad()}
              >
                {loading ? (
                  <><Loader2 size={13} className="spin" /> Loading…</>
                ) : (
                  <>Bulk load {count.toLocaleString()} docs</>
                )}
              </button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
