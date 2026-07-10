import { useEffect, useState } from 'react'
import { Crown } from 'lucide-react'
import type { ClusterConnection, ClusterOverview } from '@shared/types'
import { useApp } from '../store'
import { fetchCatNodes, type CatNode } from '../lib/api'
import { formatBytes, formatCompact } from '../lib/format'

export function Overview({
  conn,
  overview
}: {
  conn: ClusterConnection
  overview: ClusterOverview
}): React.JSX.Element {
  const { info, health, stats } = overview
  const refreshNonce = useApp((s) => s.refreshNonce)
  const [catNodes, setCatNodes] = useState<CatNode[] | null>(null)

  useEffect(() => {
    let alive = true
    fetchCatNodes(conn.id, info.distribution)
      .then((nodes) => alive && setCatNodes(nodes))
      .catch(() => alive && setCatNodes(null)) // metrics are optional; the basic table still renders
    return () => {
      alive = false
    }
  }, [conn.id, info.distribution, refreshNonce])

  const urlByName = new Map(info.nodes.map((n) => [n.name, n.url]))

  return (
    <div className="overview">
      <section>
        <div className="metric-grid">
          <Metric label="Health">
            <span className={`m-value health-text ${health.status}`}>{health.status}</span>
          </Metric>
          <Metric
            label="Nodes"
            value={String(health.numberOfNodes)}
            sub={`${health.numberOfDataNodes} data`}
          />
          <Metric label="Indices" value={formatCompact(stats.indices)} />
          <Metric label="Documents" value={formatCompact(stats.docs)} />
          <Metric label="Store" value={formatBytes(stats.storeBytes)} />
          <Metric
            label="Shards"
            value={String(health.activeShards)}
            sub={`${health.activeShardsPercent.toFixed(0)}% active · ${health.activePrimaryShards} primary`}
          />
          <Metric label="Unassigned">
            <span className={`m-value ${health.unassignedShards > 0 ? 'health-text red' : ''}`}>
              {health.unassignedShards}
            </span>
          </Metric>
          <Metric label="Pending tasks" value={String(health.pendingTasks)} />
        </div>
      </section>

      <section>
        <div className="section-title">Nodes · {catNodes?.length ?? info.nodes.length}</div>
        {catNodes ? (
          <table className="data-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Address</th>
                <th>Roles</th>
                <th>Heap</th>
                <th>RAM</th>
                <th>CPU</th>
                <th>Disk</th>
                <th>Version</th>
              </tr>
            </thead>
            <tbody>
              {catNodes.map((n) => (
                <tr key={n.name}>
                  <td>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      {n.name}
                      {n.master && (
                        <span title="Elected master" style={{ color: 'var(--warn)', display: 'inline-flex' }}>
                          <Crown size={11} />
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="mono">{urlByName.get(n.name) ?? n.ip ?? '—'}</td>
                  <td className="mono">{n.roles}</td>
                  <td>
                    <Meter percent={n.heapPercent} />
                  </td>
                  <td>
                    <Meter percent={n.ramPercent} />
                  </td>
                  <td className="mono">{n.cpu !== undefined ? `${n.cpu}%` : '—'}</td>
                  <td>
                    <Meter percent={n.diskUsedPercent} />
                  </td>
                  <td className="mono">{n.version ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Address</th>
                <th>Roles</th>
                <th>Version</th>
              </tr>
            </thead>
            <tbody>
              {info.nodes.map((n) => (
                <tr key={n.id}>
                  <td>{n.name}</td>
                  <td className="mono">{n.url}</td>
                  <td className="mono">{n.roles.join(', ')}</td>
                  <td className="mono">{n.version}</td>
                </tr>
              ))}
              {info.nodes.length === 0 && (
                <tr>
                  <td colSpan={4} style={{ color: 'var(--ink-3)' }}>
                    Topology not available — the connected user may lack the monitor privilege.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </section>
    </div>
  )
}

function Meter({ percent }: { percent: number | undefined }): React.JSX.Element {
  if (percent === undefined) return <span className="mono">—</span>
  const level = percent >= 90 ? 'danger' : percent >= 75 ? 'warn' : 'ok'
  return (
    <span className="meter-cell">
      <span className="meter">
        <i className={level} style={{ width: `${Math.min(percent, 100)}%` }} />
      </span>
      <span className="mono meter-num">{percent}%</span>
    </span>
  )
}

function Metric(props: {
  label: string
  value?: string
  sub?: string
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="metric">
      <div className="m-label">{props.label}</div>
      {props.children ?? <div className="m-value">{props.value}</div>}
      {props.sub && <div className="m-sub">{props.sub}</div>}
    </div>
  )
}
