import { useEffect, useMemo, useState } from 'react'
import { Play, Plus, X } from 'lucide-react'
import type { ClusterConnection } from '@shared/types'
import {
  esJson,
  fetchCatAliases,
  fetchCatIndices,
  fetchFields,
  type MappedField
} from '../lib/api'
import { buildQuery, hasActiveFilter, newRow, type FilterRow } from '../lib/filterQuery'
import { FilterRows } from './FilterRows'
import { IndexPicker } from './SearchTab'
import { JsonView } from './JsonView'

/* ------------------------------------------------------------------ *
 * Aggregation model — each aggregation is a nesting chain of bucket
 * levels (outer → inner) with metrics computed at the innermost level.
 * ------------------------------------------------------------------ */

type BucketType =
  | 'terms'
  | 'date_histogram'
  | 'histogram'
  | 'range'
  | 'significant_terms'
  | 'missing'

const BUCKET_OPTIONS: { value: BucketType; label: string }[] = [
  { value: 'terms', label: 'Terms (group by value)' },
  { value: 'date_histogram', label: 'Date histogram' },
  { value: 'histogram', label: 'Numeric histogram' },
  { value: 'range', label: 'Numeric ranges' },
  { value: 'significant_terms', label: 'Significant terms' },
  { value: 'missing', label: 'Missing (field absent)' }
]

type MetricType =
  | 'avg'
  | 'sum'
  | 'min'
  | 'max'
  | 'cardinality'
  | 'value_count'
  | 'stats'
  | 'percentiles'

const METRIC_OPTIONS: { value: MetricType; label: string; numeric: boolean }[] = [
  { value: 'avg', label: 'Average', numeric: true },
  { value: 'sum', label: 'Sum', numeric: true },
  { value: 'min', label: 'Min', numeric: true },
  { value: 'max', label: 'Max', numeric: true },
  { value: 'cardinality', label: 'Unique count', numeric: false },
  { value: 'value_count', label: 'Value count', numeric: false },
  { value: 'stats', label: 'Stats (min/avg/max/sum)', numeric: true },
  { value: 'percentiles', label: 'Percentiles', numeric: true }
]

const CALENDAR_INTERVALS = ['minute', 'hour', 'day', 'week', 'month', 'quarter', 'year']

const NUMERIC_TYPES = new Set([
  'long', 'integer', 'short', 'byte', 'double', 'float',
  'half_float', 'scaled_float', 'unsigned_long'
])
const DATE_TYPES = new Set(['date', 'date_nanos'])

interface MetricRow {
  id: number
  type: MetricType
  field: string
}

/** One nesting level (bucket aggregation). */
interface BucketLevel {
  id: number
  bucketType: BucketType
  bucketField: string
  termsSize: number
  interval: string
  calendarInterval: string
  edges: string
}

/** One aggregation: an ordered chain of bucket levels + leaf metrics. Empty
 *  `levels` means metrics computed over all matching docs (no grouping). */
interface AggDef {
  id: number
  levels: BucketLevel[]
  metrics: MetricRow[]
}

let seq = 0
const newLevel = (): BucketLevel => ({
  id: ++seq,
  bucketType: 'terms',
  bucketField: '',
  termsSize: 10,
  interval: '100',
  calendarInterval: 'day',
  edges: '0,100,1000'
})
const newAggDef = (): AggDef => ({ id: ++seq, levels: [newLevel()], metrics: [] })

interface AggResponse {
  took?: number
  aggregations?: Record<string, unknown>
}

interface Bucket {
  key: unknown
  key_as_string?: string
  doc_count: number
  [k: string]: unknown
}

/* ------------------------------------------------------------------ *
 * Component
 * ------------------------------------------------------------------ */

export function AggTab({ conn }: { conn: ClusterConnection }): React.JSX.Element {
  const [targets, setTargets] = useState<{ label: string; kind: 'index' | 'alias' }[]>([])
  const [index, setIndex] = useState('')
  const [fields, setFields] = useState<MappedField[]>([])
  const [filterRows, setFilterRows] = useState<FilterRow[]>([newRow()])
  const [aggDefs, setAggDefs] = useState<AggDef[]>([newAggDef()])
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [response, setResponse] = useState<AggResponse | null>(null)
  const [view, setView] = useState<'table' | 'json'>('table')

  useEffect(() => {
    Promise.all([fetchCatIndices(conn.id), fetchCatAliases(conn.id)])
      .then(([indices, aliases]) => {
        const t = [
          ...aliases.map((a) => ({ label: a.alias, kind: 'alias' as const })),
          ...indices.filter((i) => !i.index.startsWith('.')).map((i) => ({ label: i.index, kind: 'index' as const }))
        ]
        setTargets(t)
        setIndex((cur) => cur || t[0]?.label || '')
      })
      .catch((err: Error) => setError(err.message))
  }, [conn.id])

  useEffect(() => {
    if (!index) return
    fetchFields(conn.id, index)
      .then(setFields)
      .catch(() => setFields([]))
    setResponse(null)
  }, [conn.id, index])

  const fieldMap = useMemo(() => new Map(fields.map((f) => [f.path, f])), [fields])

  // Field choices per role. Aggregations run on exact values, so text fields
  // participate via their .keyword sub-field (sortPath).
  const keywordish = useMemo(() => fields.filter((f) => f.sortPath), [fields])
  const numeric = useMemo(() => fields.filter((f) => NUMERIC_TYPES.has(f.type)), [fields])
  const dates = useMemo(() => fields.filter((f) => DATE_TYPES.has(f.type)), [fields])

  const bucketChoices = (type: BucketType): MappedField[] => {
    switch (type) {
      case 'date_histogram':
        return dates
      case 'histogram':
      case 'range':
        return numeric
      default:
        return keywordish
    }
  }

  const metricFieldChoices = (type: MetricType): MappedField[] =>
    METRIC_OPTIONS.find((m) => m.value === type)?.numeric ? numeric : keywordish

  const patchDef = (id: number, p: Partial<AggDef>): void =>
    setAggDefs((ds) => ds.map((d) => (d.id === id ? { ...d, ...p } : d)))

  const patchLevel = (defId: number, levelId: number, p: Partial<BucketLevel>): void =>
    setAggDefs((ds) =>
      ds.map((d) =>
        d.id !== defId
          ? d
          : {
              ...d,
              levels: d.levels.map((l) => {
                if (l.id !== levelId) return l
                const next = { ...l, ...p }
                // Keep the field valid for the (possibly new) bucket type.
                const choices = bucketChoices(next.bucketType)
                if (!choices.some((f) => f.path === next.bucketField)) {
                  next.bucketField = choices[0]?.path ?? ''
                }
                return next
              })
            }
      )
    )

  // Re-anchor every field to the current index's mapping when it changes.
  useEffect(() => {
    setAggDefs((ds) =>
      ds.map((d) => ({
        ...d,
        levels: d.levels.map((l) => {
          const choices = bucketChoices(l.bucketType)
          return choices.some((f) => f.path === l.bucketField)
            ? l
            : { ...l, bucketField: choices[0]?.path ?? '' }
        }),
        metrics: d.metrics.map((m) =>
          metricFieldChoices(m.type).some((f) => f.path === m.field)
            ? m
            : { ...m, field: metricFieldChoices(m.type)[0]?.path ?? '' }
        )
      }))
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fields])

  const esField = (path: string): string => fieldMap.get(path)?.sortPath ?? path
  const metricKey = (m: MetricRow): string => `${m.type}_${m.field.replace(/[^\w]/g, '_')}`

  const bucketParams = (l: BucketLevel): Record<string, unknown> | null => {
    switch (l.bucketType) {
      case 'terms':
      case 'significant_terms':
        return { field: esField(l.bucketField), size: l.termsSize }
      case 'date_histogram':
        return { field: l.bucketField, calendar_interval: l.calendarInterval }
      case 'histogram':
        return { field: l.bucketField, interval: Number(l.interval) || 1 }
      case 'range': {
        const bounds = l.edges
          .split(',')
          .map((e) => Number(e.trim()))
          .filter((n) => Number.isFinite(n))
          .sort((a, b) => a - b)
        if (bounds.length === 0) return null
        const ranges: { from?: number; to?: number }[] = [{ to: bounds[0] }]
        for (let i = 0; i < bounds.length - 1; i++) ranges.push({ from: bounds[i], to: bounds[i + 1] })
        ranges.push({ from: bounds[bounds.length - 1] })
        return { field: l.bucketField, ranges }
      }
      case 'missing':
        return { field: esField(l.bucketField) }
      default:
        return null
    }
  }

  const buildAggs = (): Record<string, unknown> | null => {
    const out: Record<string, unknown> = {}
    for (const d of aggDefs) {
      const metricAggs: Record<string, unknown> = {}
      for (const m of d.metrics) {
        if (m.field) metricAggs[metricKey(m)] = { [m.type]: { field: esField(m.field) } }
      }
      // No grouping → metrics over all matching docs.
      if (d.levels.length === 0) {
        for (const [k, v] of Object.entries(metricAggs)) out[`agg${d.id}_${k}`] = v
        continue
      }
      if (d.levels.some((l) => !l.bucketField)) continue
      // Recursively nest: level i's sub-aggs are keyed `l{i+1}`; the leaf holds metrics.
      const buildLevel = (i: number): Record<string, unknown> | null => {
        const params = bucketParams(d.levels[i])
        if (!params) return null
        const node: Record<string, unknown> = { [d.levels[i].bucketType]: params }
        const child: Record<string, unknown> = {}
        if (i < d.levels.length - 1) {
          const c = buildLevel(i + 1)
          if (c) child[`l${i + 1}`] = c
        } else {
          Object.assign(child, metricAggs)
        }
        if (Object.keys(child).length) node.aggs = child
        return node
      }
      const top = buildLevel(0)
      if (top) out[`agg${d.id}`] = top
    }
    return Object.keys(out).length ? out : null
  }

  const run = async (): Promise<void> => {
    const aggs = buildAggs()
    if (!aggs) {
      setError('Configure at least one aggregation (a group-by field, or a metric).')
      return
    }
    setRunning(true)
    setError(null)
    try {
      const res = await esJson<AggResponse>(conn.id, {
        method: 'POST',
        path: `/${encodeURIComponent(index)}/_search`,
        body: {
          size: 0,
          ...(hasActiveFilter(filterRows) ? { query: buildQuery(filterRows, fieldMap) } : {}),
          aggs
        }
      })
      setResponse(res)
    } catch (err) {
      setError((err as Error).message)
      setResponse(null)
    } finally {
      setRunning(false)
    }
  }

  /* ---------- result shaping ---------- */

  const metricLabel = (m: MetricRow): string =>
    `${METRIC_OPTIONS.find((o) => o.value === m.type)?.label ?? m.type} · ${m.field}`

  const renderMetricValue = (v: unknown): string => {
    if (v === null || v === undefined) return '—'
    if (typeof v === 'object') {
      const o = v as { value?: unknown; values?: Record<string, unknown>; avg?: unknown }
      if ('value' in o) return formatNum(o.value)
      if (o.values) {
        return Object.entries(o.values)
          .filter(([k]) => ['50.0', '95.0', '99.0'].includes(k))
          .map(([k, val]) => `p${parseFloat(k)}=${formatNum(val)}`)
          .join('  ')
      }
      if ('avg' in o) {
        const s = v as { min?: unknown; avg?: unknown; max?: unknown; sum?: unknown }
        return `min=${formatNum(s.min)} avg=${formatNum(s.avg)} max=${formatNum(s.max)} sum=${formatNum(s.sum)}`
      }
      return JSON.stringify(v)
    }
    return formatNum(v)
  }

  /** Flatten a nested-bucket response into one row per leaf bucket. */
  const flatten = (d: AggDef): { keys: unknown[]; doc_count: number; bucket: Bucket }[] => {
    const rows: { keys: unknown[]; doc_count: number; bucket: Bucket }[] = []
    const walk = (node: unknown, i: number, keyPath: unknown[]): void => {
      const buckets = (node as { buckets?: Bucket[] } | undefined)?.buckets ?? []
      for (const b of buckets) {
        const path = [...keyPath, b.key_as_string ?? b.key]
        if (i === d.levels.length - 1) rows.push({ keys: path, doc_count: b.doc_count, bucket: b })
        else walk(b[`l${i + 1}`], i + 1, path)
      }
    }
    walk(response?.aggregations?.[`agg${d.id}`], 0, [])
    return rows
  }

  const chainSummary = (d: AggDef): string =>
    d.levels.length === 0 ? 'Metrics only' : d.levels.map((l) => l.bucketField || '?').join(' → ')

  return (
    <div className="shards-view">
      <div className="grid-toolbar">
        <IndexPicker targets={targets} value={index} onChange={setIndex} />
        <div className="spacer" />
        <button className="btn ghost" onClick={() => setAggDefs((ds) => [...ds, newAggDef()])}>
          <Plus size={12} /> Add aggregation
        </button>
        <button className="btn primary" disabled={running || !index} onClick={() => void run()}>
          <Play size={12} />
          {running ? 'Running…' : 'Run'}
        </button>
      </div>

      <div className="agg-filter">
        <span className="pane-label">Filter (optional) — scopes every aggregation below</span>
        <FilterRows rows={filterRows} onChange={setFilterRows} fields={fields} onEnter={() => void run()} />
      </div>

      <div className="agg-cards">
        {aggDefs.map((d, di) => (
          <div key={d.id} className="agg-card">
            <div className="agg-card-head">
              <span className="pane-label">Aggregation {di + 1}</span>
              {aggDefs.length > 1 && (
                <button
                  className="icon-btn"
                  title="Remove aggregation"
                  onClick={() => setAggDefs((ds) => ds.filter((x) => x.id !== d.id))}
                >
                  <X size={13} />
                </button>
              )}
            </div>

            {/* nesting chain of bucket levels */}
            {d.levels.map((lvl, li) => (
              <div key={lvl.id} className="filter-row" style={{ flexWrap: 'wrap' }}>
                <span className="conj-lead mono">{li === 0 ? 'group by' : 'then by'}</span>
                <select
                  className="input mono"
                  value={lvl.bucketType}
                  onChange={(e) => patchLevel(d.id, lvl.id, { bucketType: e.target.value as BucketType })}
                  title="Bucket aggregation"
                >
                  {BUCKET_OPTIONS.map((b) => (
                    <option key={b.value} value={b.value}>
                      {b.label}
                    </option>
                  ))}
                </select>
                <select
                  className="input mono"
                  style={{ flex: 1, minWidth: 150 }}
                  value={lvl.bucketField}
                  onChange={(e) => patchLevel(d.id, lvl.id, { bucketField: e.target.value })}
                  title="Bucket field"
                >
                  {bucketChoices(lvl.bucketType).length === 0 && (
                    <option value="">— no compatible field —</option>
                  )}
                  {bucketChoices(lvl.bucketType).map((f) => (
                    <option key={f.path} value={f.path}>
                      {f.path} ({f.type})
                    </option>
                  ))}
                </select>
                {(lvl.bucketType === 'terms' || lvl.bucketType === 'significant_terms') && (
                  <input
                    className="input mono"
                    style={{ width: 66 }}
                    type="number"
                    min={1}
                    max={1000}
                    value={lvl.termsSize}
                    onChange={(e) => patchLevel(d.id, lvl.id, { termsSize: Number(e.target.value) || 10 })}
                    title="Top N buckets"
                  />
                )}
                {lvl.bucketType === 'date_histogram' && (
                  <select
                    className="input mono"
                    value={lvl.calendarInterval}
                    onChange={(e) => patchLevel(d.id, lvl.id, { calendarInterval: e.target.value })}
                    title="Calendar interval"
                  >
                    {CALENDAR_INTERVALS.map((c) => (
                      <option key={c} value={c}>
                        per {c}
                      </option>
                    ))}
                  </select>
                )}
                {lvl.bucketType === 'histogram' && (
                  <input
                    className="input mono"
                    style={{ width: 90 }}
                    value={lvl.interval}
                    onChange={(e) => patchLevel(d.id, lvl.id, { interval: e.target.value })}
                    placeholder="interval"
                    title="Interval"
                  />
                )}
                {lvl.bucketType === 'range' && (
                  <input
                    className="input mono"
                    style={{ width: 150 }}
                    value={lvl.edges}
                    onChange={(e) => patchLevel(d.id, lvl.id, { edges: e.target.value })}
                    placeholder="0,100,1000"
                    title="Range boundaries, comma-separated"
                  />
                )}
                <button
                  className="icon-btn"
                  title="Remove this level"
                  onClick={() => patchDef(d.id, { levels: d.levels.filter((x) => x.id !== lvl.id) })}
                >
                  <X size={13} />
                </button>
              </div>
            ))}
            {d.levels.length === 0 && (
              <span className="hint" style={{ fontSize: 11, color: 'var(--ink-3)' }}>
                No grouping — metrics computed over all matching documents.
              </span>
            )}
            <button
              className="btn ghost"
              style={{ alignSelf: 'flex-start' }}
              onClick={() => patchDef(d.id, { levels: [...d.levels, newLevel()] })}
            >
              <Plus size={12} /> {d.levels.length === 0 ? 'Add group-by' : 'Add sub-bucket (nest deeper)'}
            </button>

            {/* metrics computed at the innermost bucket */}
            {d.metrics.map((m) => (
              <div key={m.id} className="filter-row" style={{ maxWidth: 640 }}>
                <span className="conj-lead mono">metric</span>
                <select
                  className="input mono"
                  value={m.type}
                  onChange={(e) => {
                    const type = e.target.value as MetricType
                    patchDef(d.id, {
                      metrics: d.metrics.map((x) =>
                        x.id === m.id
                          ? {
                              ...x,
                              type,
                              field: metricFieldChoices(type).some((f) => f.path === x.field)
                                ? x.field
                                : (metricFieldChoices(type)[0]?.path ?? '')
                            }
                          : x
                      )
                    })
                  }}
                >
                  {METRIC_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
                <select
                  className="input mono"
                  style={{ flex: 1 }}
                  value={m.field}
                  onChange={(e) =>
                    patchDef(d.id, {
                      metrics: d.metrics.map((x) => (x.id === m.id ? { ...x, field: e.target.value } : x))
                    })
                  }
                >
                  {metricFieldChoices(m.type).length === 0 && <option value="">— no compatible field —</option>}
                  {metricFieldChoices(m.type).map((f) => (
                    <option key={f.path} value={f.path}>
                      {f.path} ({f.type})
                    </option>
                  ))}
                </select>
                <button
                  className="icon-btn"
                  title="Remove metric"
                  onClick={() => patchDef(d.id, { metrics: d.metrics.filter((x) => x.id !== m.id) })}
                >
                  <X size={13} />
                </button>
              </div>
            ))}
            <button
              className="btn ghost"
              style={{ alignSelf: 'flex-start' }}
              onClick={() =>
                patchDef(d.id, {
                  metrics: [...d.metrics, { id: ++seq, type: 'avg', field: numeric[0]?.path ?? '' }]
                })
              }
            >
              <Plus size={12} /> Add metric{d.levels.length > 0 ? ' (per innermost bucket)' : ''}
            </button>
          </div>
        ))}
      </div>

      {error && <div className="res-error" style={{ marginBottom: 10 }}>{error}</div>}

      {response && (
        <>
          <div className="result-meta" style={{ marginBottom: 8 }}>
            <span className="chip">{response.took ?? 0} ms</span>
            {hasActiveFilter(filterRows) && <span className="chip">filtered</span>}
            <div className="view-toggle">
              <button className={view === 'table' ? 'on' : ''} onClick={() => setView('table')}>
                Table
              </button>
              <button className={view === 'json' ? 'on' : ''} onClick={() => setView('json')}>
                JSON
              </button>
            </div>
          </div>

          {view === 'json' ? (
            <div className="search-json">
              <JsonView value={response.aggregations ?? {}} height="100%" />
            </div>
          ) : (
            aggDefs.map((d, di) => {
              if (d.levels.length === 0) {
                if (d.metrics.length === 0) return null
                return (
                  <div key={d.id} className="agg-result">
                    <div className="agg-section-title mono">#{di + 1} · Metrics only</div>
                    <div className="shard-grid-wrap" style={{ marginBottom: 14 }}>
                      <table className="data-table" style={{ border: 'none' }}>
                        <thead>
                          <tr>
                            <th>Metric</th>
                            <th>Value</th>
                          </tr>
                        </thead>
                        <tbody>
                          {d.metrics.map((m) => (
                            <tr key={m.id}>
                              <td>{metricLabel(m)}</td>
                              <td className="mono">
                                {renderMetricValue(response.aggregations?.[`agg${d.id}_${metricKey(m)}`])}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )
              }
              const rows = flatten(d)
              return (
                <div key={d.id} className="agg-result">
                  <div className="agg-section-title mono">
                    #{di + 1} · {chainSummary(d)} · {rows.length} rows
                  </div>
                  <div className="shard-grid-wrap" style={{ marginBottom: 14 }}>
                    <table className="data-table" style={{ border: 'none' }}>
                      <thead>
                        <tr>
                          {d.levels.map((l) => (
                            <th key={l.id}>{l.bucketField || 'key'}</th>
                          ))}
                          <th>Docs</th>
                          {d.metrics.map((m) => (
                            <th key={m.id}>{metricLabel(m)}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((r, i) => (
                          <tr key={i}>
                            {r.keys.map((k, ki) => (
                              <td key={ki} className="mono">
                                {String(k)}
                              </td>
                            ))}
                            <td className="mono">{formatNum(r.doc_count)}</td>
                            {d.metrics.map((m) => (
                              <td key={m.id} className="mono">
                                {renderMetricValue(r.bucket[metricKey(m)])}
                              </td>
                            ))}
                          </tr>
                        ))}
                        {rows.length === 0 && (
                          <tr>
                            <td colSpan={d.levels.length + 1 + d.metrics.length} className="sg-empty">
                              No buckets returned.
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              )
            })
          )}
        </>
      )}

      {!response && !error && (
        <p className="cat-empty" style={{ marginTop: 12 }}>
          Group by one or more fields (nest with “Add sub-bucket”), add metrics, optionally scope
          with a filter, then Run. Nested groupings flatten into one row per innermost bucket.
        </p>
      )}
    </div>
  )
}

function formatNum(v: unknown): string {
  if (v === null || v === undefined) return '—'
  const n = Number(v)
  if (!Number.isFinite(n)) return String(v)
  if (Number.isInteger(n)) return n.toLocaleString()
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 })
}
