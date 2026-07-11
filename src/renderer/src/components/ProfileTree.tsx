import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'

/* ------------------------------------------------------------------ *
 * Types — mirrors the relevant subset of the ES profile response
 * ------------------------------------------------------------------ */

interface ProfileCollector {
  name: string
  reason?: string
  time_in_nanos?: number
  children?: ProfileCollector[]
}

interface ProfileQuery {
  type: string
  description?: string
  time_in_nanos?: number
  breakdown?: Record<string, number>
  children?: ProfileQuery[]
}

interface ProfileShard {
  id?: string
  searches?: ProfileQuery[]
  aggregations?: unknown[]
  collector?: ProfileCollector[]
}

interface ProfileBody {
  profile?: {
    shards?: ProfileShard[]
  }
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function fmtTime(nanos: number | undefined): string {
  if (nanos === undefined) return ''
  if (nanos < 1_000) return `${nanos} ns`
  if (nanos < 1_000_000) return `${(nanos / 1_000).toFixed(1)} µs`
  if (nanos < 1_000_000_000) return `${(nanos / 1_000_000).toFixed(2)} ms`
  return `${(nanos / 1_000_000_000).toFixed(2)} s`
}

function pct(part: number, total: number): string {
  if (total <= 0) return ''
  const v = (part / total) * 100
  if (v < 0.1) return ''
  return `${v.toFixed(1)}%`
}

/* ------------------------------------------------------------------ *
 * Query tree node
 * ------------------------------------------------------------------ */

function QueryNode({ node, totalNanos, depth }: { node: ProfileQuery; totalNanos: number; depth: number }): React.JSX.Element {
  const [open, setOpen] = useState(depth < 2)
  const hasChildren = node.children && node.children.length > 0
  const time = node.time_in_nanos ?? 0
  const timeStr = fmtTime(node.time_in_nanos)
  const pctStr = pct(time, totalNanos)

  return (
    <div className="profile-node">
      <div
        className={`profile-row ${hasChildren ? 'clickable' : ''}`}
        onClick={() => hasChildren && setOpen(!open)}
        style={{ paddingLeft: depth * 16 }}
      >
        {hasChildren ? (
          <span className="profile-chevron">
            {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </span>
        ) : (
          <span className="profile-chevron" />
        )}
        <span className="profile-type mono">{node.type}</span>
        {node.description && (
          <span className="profile-desc mono">{node.description}</span>
        )}
        {timeStr && (
          <span className="profile-time mono">{timeStr}</span>
        )}
        {pctStr && (
          <span className="profile-pct mono">{pctStr}</span>
        )}
      </div>
      {hasChildren && open && (
        <div className="profile-children">
          {node.children!.map((child, i) => (
            <QueryNode key={i} node={child} totalNanos={totalNanos} depth={depth + 1} />
          ))}
        </div>
      )}
      {open && node.breakdown && Object.keys(node.breakdown).length > 0 && (
        <div className="profile-breakdown" style={{ paddingLeft: depth * 16 + 24 }}>
          <div className="profile-breakdown-title">Breakdown</div>
          {Object.entries(node.breakdown)
            .sort(([, a], [, b]) => b - a)
            .map(([k, v]) => (
              <div key={k} className="profile-breakdown-row">
                <span className="mono">{k}</span>
                <span className="mono">{fmtTime(v)}</span>
              </div>
            ))}
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Collector tree node
 * ------------------------------------------------------------------ */

function CollectorNode({ node, depth }: { node: ProfileCollector; depth: number }): React.JSX.Element {
  const [open, setOpen] = useState(depth < 1)
  const hasChildren = node.children && node.children.length > 0
  const timeStr = fmtTime(node.time_in_nanos)

  return (
    <div className="profile-node">
      <div
        className={`profile-row ${hasChildren ? 'clickable' : ''}`}
        onClick={() => hasChildren && setOpen(!open)}
        style={{ paddingLeft: depth * 16 }}
      >
        {hasChildren ? (
          <span className="profile-chevron">
            {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </span>
        ) : (
          <span className="profile-chevron" />
        )}
        <span className="profile-type mono">{node.name}</span>
        {node.reason && (
          <span className="profile-desc mono">{node.reason}</span>
        )}
        {timeStr && (
          <span className="profile-time mono">{timeStr}</span>
        )}
      </div>
      {hasChildren && open && (
        <div className="profile-children">
          {node.children!.map((child, i) => (
            <CollectorNode key={i} node={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Main component
 * ------------------------------------------------------------------ */

export function ProfileTree({ body }: { body: unknown }): React.JSX.Element {
  const parsed = body as ProfileBody
  const shards = parsed?.profile?.shards ?? []

  if (shards.length === 0) {
    return (
      <div className="res-empty">
        No profile data. Add <span className="mono">"profile": true</span> to your search request body.
      </div>
    )
  }

  return (
    <div className="profile-tree">
      {shards.map((shard, si) => {
        const searches = shard.searches ?? []
        const collectors = shard.collector ?? []
        const totalNanos = searches.reduce(
          (sum, q) => sum + (q.time_in_nanos ?? 0),
          0
        )

        return (
          <div key={si} className="profile-shard">
            <div className="profile-shard-header">
              Shard {shard.id ?? si}
              <span className="mono profile-shard-time">{fmtTime(totalNanos)}</span>
            </div>

            {searches.length > 0 && (
              <div className="profile-section">
                <div className="profile-section-title">Query</div>
                {searches.map((q, qi) => (
                  <QueryNode key={qi} node={q} totalNanos={totalNanos} depth={0} />
                ))}
              </div>
            )}

            {collectors.length > 0 && (
              <div className="profile-section">
                <div className="profile-section-title">Collectors</div>
                {collectors.map((c, ci) => (
                  <CollectorNode key={ci} node={c} depth={0} />
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
