import { useEffect, useMemo, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { Crown } from 'lucide-react'
import type { ClusterConnection, ClusterOverview } from '@shared/types'
import { useApp } from '../store'
import {
  fetchAllocationExplain,
  fetchCatIndices,
  fetchCatNodes,
  fetchCatShards,
  REFRESH_MS,
  type AllocationExplanation,
  type CatIndex,
  type CatNode,
  type CatShard
} from '../lib/api'
import { formatBytes, formatCompact } from '../lib/format'

interface GridData {
  nodes: CatNode[]
  indices: CatIndex[]
  shards: CatShard[]
}

interface ExplainTarget {
  index: string
  shard: number
  primary: boolean
}

export function ShardGrid({
  conn,
  overview
}: {
  conn: ClusterConnection
  overview: ClusterOverview
}): React.JSX.Element {
  const refreshNonce = useApp((s) => s.refreshNonce)
  const [data, setData] = useState<GridData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [showSystem, setShowSystem] = useState(false)
  const [explainTarget, setExplainTarget] = useState<ExplainTarget | null>(null)

  useEffect(() => {
    let alive = true
    const load = (): void => {
      Promise.all([
        fetchCatNodes(conn.id, overview.info.distribution),
        fetchCatIndices(conn.id),
        fetchCatShards(conn.id)
      ])
        .then(([nodes, indices, shards]) => {
          if (!alive) return
          setData({ nodes, indices, shards })
          setError(null)
        })
        .catch((err: Error) => alive && setError(err.message))
    }
    load()
    const t = setInterval(load, REFRESH_MS)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [conn.id, overview.info.distribution, refreshNonce])

  const visibleIndices = useMemo(() => {
    if (!data) return []
    const needle = filter.trim().toLowerCase()
    return data.indices.filter((i) => {
      if (!showSystem && i.index.startsWith('.')) return false
      return needle === '' || i.index.toLowerCase().includes(needle)
    })
  }, [data, filter, showSystem])

  /** index → node → shards, plus per-index unassigned bucket. */
  const cells = useMemo(() => {
    const byIndex = new Map<string, { byNode: Map<string, CatShard[]>; unassigned: CatShard[] }>()
    for (const s of data?.shards ?? []) {
      let entry = byIndex.get(s.index)
      if (!entry) {
        entry = { byNode: new Map(), unassigned: [] }
        byIndex.set(s.index, entry)
      }
      if (s.state === 'UNASSIGNED' || !s.node) {
        entry.unassigned.push(s)
      } else {
        const list = entry.byNode.get(s.node) ?? []
        list.push(s)
        entry.byNode.set(s.node, list)
      }
    }
    for (const entry of byIndex.values()) {
      for (const list of entry.byNode.values()) list.sort(shardOrder)
      entry.unassigned.sort(shardOrder)
    }
    return byIndex
  }, [data])

  if (error && !data) {
    return (
      <div className="state-screen">
        <h2>Can’t load shards</h2>
        <div className="err">{error}</div>
      </div>
    )
  }

  if (!data) {
    return (
      <div className="state-screen">
        <div className="spinner" />
      </div>
    )
  }

  const systemCount = data.indices.filter((i) => i.index.startsWith('.')).length
  const hasUnassigned = data.shards.some((s) => s.state === 'UNASSIGNED')

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
        <span className="chip">
          {visibleIndices.length} indices · {data.shards.length} shards
        </span>
      </div>

      <div className="shard-grid-wrap">
        <table className="shard-grid">
          <thead>
            <tr>
              <th className="sg-corner">index</th>
              {data.nodes.map((n) => (
                <th key={n.name} className="sg-node">
                  <span className="sg-node-name">
                    {n.name}
                    {n.master && (
                      <span title="Elected master" style={{ color: 'var(--warn)', display: 'inline-flex' }}>
                        <Crown size={10} />
                      </span>
                    )}
                  </span>
                  <span className="sg-node-sub">
                    {n.roles}
                    {n.heapPercent !== undefined && ` · heap ${n.heapPercent}%`}
                    {n.diskUsedPercent !== undefined && ` · disk ${n.diskUsedPercent}%`}
                  </span>
                </th>
              ))}
              {hasUnassigned && <th className="sg-node sg-unassigned-h">unassigned</th>}
            </tr>
          </thead>
          <tbody>
            {visibleIndices.map((idx) => {
              const entry = cells.get(idx.index)
              return (
                <tr key={idx.index}>
                  <th className="sg-index">
                    <span className="sg-index-row">
                      <span className={`health-led ${idx.health}`} />
                      <span className="sg-index-name" title={idx.index}>
                        {idx.index}
                      </span>
                    </span>
                    <span className="sg-index-sub">
                      {idx.primaries}×{idx.replicas + 1} · {formatCompact(idx.docs)} docs ·{' '}
                      {formatBytes(idx.storeBytes)}
                    </span>
                  </th>
                  {data.nodes.map((n) => (
                    <td key={n.name} className="sg-cell">
                      {(entry?.byNode.get(n.name) ?? []).map((s, i) => (
                        <ShardChip key={`${s.shard}-${s.primary}-${i}`} shard={s} />
                      ))}
                    </td>
                  ))}
                  {hasUnassigned && (
                    <td className="sg-cell sg-unassigned">
                      {(entry?.unassigned ?? []).map((s, i) => (
                        <ShardChip
                          key={`${s.shard}-${i}`}
                          shard={s}
                          onClick={() =>
                            setExplainTarget({ index: s.index, shard: s.shard, primary: s.primary })
                          }
                        />
                      ))}
                    </td>
                  )}
                </tr>
              )
            })}
            {visibleIndices.length === 0 && (
              <tr>
                <td className="sg-empty" colSpan={data.nodes.length + 2}>
                  {data.indices.length === 0
                    ? 'This cluster has no indices yet.'
                    : 'No indices match the filter.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="sg-legend">
        <span className="sg-legend-item">
          <span className="shard-chip primary">0</span> primary
        </span>
        <span className="sg-legend-item">
          <span className="shard-chip">0</span> replica
        </span>
        <span className="sg-legend-item">
          <span className="shard-chip initializing">0</span> initializing
        </span>
        <span className="sg-legend-item">
          <span className="shard-chip relocating">0</span> relocating
        </span>
        <span className="sg-legend-item">
          <span className="shard-chip unassigned">0</span> unassigned — click for the reason
        </span>
      </div>

      <ExplainDialog
        connId={conn.id}
        target={explainTarget}
        onClose={() => setExplainTarget(null)}
      />
    </div>
  )
}

function shardOrder(a: CatShard, b: CatShard): number {
  return a.shard - b.shard || Number(b.primary) - Number(a.primary)
}

function ShardChip({ shard, onClick }: { shard: CatShard; onClick?: () => void }): React.JSX.Element {
  const cls = [
    'shard-chip',
    shard.primary ? 'primary' : '',
    shard.state === 'INITIALIZING' ? 'initializing' : '',
    shard.state === 'RELOCATING' ? 'relocating' : '',
    shard.state === 'UNASSIGNED' ? 'unassigned' : ''
  ]
    .filter(Boolean)
    .join(' ')

  const title = [
    `${shard.index} [${shard.shard}] ${shard.primary ? 'primary' : 'replica'}`,
    shard.state,
    shard.docs !== undefined ? `${formatCompact(shard.docs)} docs` : null,
    shard.storeBytes !== undefined ? formatBytes(shard.storeBytes) : null,
    shard.relocatingTo ? `→ ${shard.relocatingTo}` : null,
    onClick ? 'Click to see why it is unassigned' : null
  ]
    .filter(Boolean)
    .join(' · ')

  return onClick ? (
    <button className={cls} title={title} onClick={onClick}>
      {shard.shard}
    </button>
  ) : (
    <span className={cls} title={title}>
      {shard.shard}
    </span>
  )
}

function ExplainDialog({
  connId,
  target,
  onClose
}: {
  connId: string
  target: ExplainTarget | null
  onClose: () => void
}): React.JSX.Element {
  const [result, setResult] = useState<AllocationExplanation | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!target) return
    let alive = true
    setResult(null)
    setError(null)
    fetchAllocationExplain(connId, target)
      .then((r) => alive && setResult(r))
      .catch((err: Error) => alive && setError(err.message))
    return () => {
      alive = false
    }
  }, [connId, target])

  return (
    <Dialog.Root open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="dlg-overlay" />
        <Dialog.Content className="dlg-content" aria-describedby={undefined} style={{ width: 560 }}>
          <Dialog.Title className="dlg-title">
            Why is {target?.index} [{target?.shard}] {target?.primary ? 'primary' : 'replica'}{' '}
            unassigned?
          </Dialog.Title>

          {!result && !error && (
            <div style={{ display: 'flex', justifyContent: 'center', padding: 24 }}>
              <div className="spinner" />
            </div>
          )}
          {error && <div className="test-result fail">{error}</div>}

          {result && (
            <div className="explain">
              {result.unassigned_info?.reason && (
                <div className="explain-row">
                  <span className="explain-key">Reason</span>
                  <span className="mono">{result.unassigned_info.reason}</span>
                </div>
              )}
              {result.unassigned_info?.details && (
                <div className="explain-row">
                  <span className="explain-key">Details</span>
                  <span>{result.unassigned_info.details}</span>
                </div>
              )}
              {result.can_allocate && (
                <div className="explain-row">
                  <span className="explain-key">Can allocate</span>
                  <span className="mono">{result.can_allocate}</span>
                </div>
              )}
              {result.allocate_explanation && (
                <p className="explain-summary">{result.allocate_explanation}</p>
              )}

              {(result.node_allocation_decisions?.length ?? 0) > 0 && (
                <table className="data-table" style={{ marginTop: 10 }}>
                  <thead>
                    <tr>
                      <th>Node</th>
                      <th>Decision</th>
                      <th>Why</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.node_allocation_decisions!.map((d, i) => (
                      <tr key={i}>
                        <td>{d.node_name}</td>
                        <td className="mono">{d.node_decision}</td>
                        <td style={{ color: 'var(--ink-2)' }}>
                          {d.deciders?.map((x) => x.explanation).filter(Boolean).join(' ') || '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              <details style={{ marginTop: 10 }}>
                <summary className="explain-raw-toggle">Raw response</summary>
                <pre className="explain-raw">{JSON.stringify(result, null, 2)}</pre>
              </details>
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
