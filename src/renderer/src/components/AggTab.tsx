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
 * Aggregation model
 * ------------------------------------------------------------------ */

type BucketType =
  | 'none'
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
  { value: 'missing', label: 'Missing (field absent)' },
  { value: 'none', label: 'No buckets — metrics only' }
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

/** One independent aggregation: a bucket definition plus per-bucket metrics. */
interface AggDef {
  id: number
  bucketType: BucketType
  bucketField: string
  termsSize: number
  interval: string
  calendarInterval: string
  edges: string
  metrics: MetricRow[]
}

let seq = 0
const newAggDef = (): AggDef => ({
  id: ++seq,
  bucketType: 'terms',
  bucketField: '',
  termsSize: 10,
  interval: '100',
  calendarInterval: 'day',
  edges: '0,100,1000',
  metrics: []
})

interface AggResponse {
  took?: number
  aggregations?: Record<string, unknown>
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
      case 'none':
        return []
      default:
        return keywordish
    }
  }

  const metricFieldChoices = (type: MetricType): MappedField[] =>
    METRIC_OPTIONS.find((m) => m.value === type)?.numeric ? numeric : keywordish

  const patchDef = (id: number, p: Partial<AggDef>): void =>
    setAggDefs((ds) =>
      ds.map((d) => {
        if (d.id !== id) return d
        const next = { ...d, ...p }
        // Keep the bucket field compatible with the (possibly new) bucket type.
        const choices = bucketChoices(next.bucketType)
        if (next.bucketType !== 'none' && !choices.some((f) => f.path === next.bucketField)) {
          next.bucketField = choices[0]?.path ?? ''
        }
        return next
      })
    )

  // When the index (and so the field list) changes, re-anchor every def.
  useEffect(() => {
    setAggDefs((ds) =>
      ds.map((d) => {
        const choices = bucketChoices(d.bucketType)
        const bucketField = choices.some((f) => f.path === d.bucketField)
          ? d.bucketField
          : (choices[0]?.path ?? '')
        const metrics = d.metrics.map((m) =>
          metricFieldChoices(m.type).some((f) => f.path === m.field)
            ? m
            : { ...m, field: metricFieldChoices(m.type)[0]?.path ?? '' }
        )
        return { ...d, bucketField, metrics }
      })
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fields])

  const esField = (path: string): string => fieldMap.get(path)?.sortPath ?? path

  const metricKey = (m: MetricRow): string => `${m.type}_${m.field.replace(/[^\w]/g, '_')}`

  const buildBucketParams = (d: AggDef): Record<string, unknown> | null => {
    switch (d.bucketType) {
      case 'terms':
      case 'significant_terms':
        return { field: esField(d.bucketField), size: d.termsSize }
      case 'date_histogram':
        return { field: d.bucketField, calendar_interval: d.calendarInterval }
      case 'histogram':
        return { field: d.bucketField, interval: Number(d.interval) || 1 }
      case 'range': {
        const bounds = d.edges
          .split(',')
          .map((e) => Number(e.trim()))
          .filter((n) => Number.isFinite(n))
          .sort((a, b) => a - b)
        if (bounds.length === 0) return null
        const ranges: { from?: number; to?: number }[] = [{ to: bounds[0] }]
        for (let i = 0; i < bounds.length - 1; i++) ranges.push({ from: bounds[i], to: bounds[i + 1] })
        ranges.push({ from: bounds[bounds.length - 1] })
        return { field: d.bucketField, ranges }
      }
      case 'missing':
        return { field: esField(d.bucketField) }
      default:
        return null
    }
  }

  /** All aggregation defs → one sibling `aggs` map. Bucket defs nest their
   *  metrics; metrics-only defs contribute top-level metric aggs. */
  const buildAggs = (): Record<string, unknown> | null => {
    const out: Record<string, unknown> = {}
    for (const d of aggDefs) {
      const metricAggs: Record<string, unknown> = {}
      for (const m of d.metrics) {
        if (!m.field) continue
        metricAggs[metricKey(m)] = { [m.type]: { field: esField(m.field) } }
      }
      if (d.bucketType === 'none') {
        for (const [k, v] of Object.entries(metricAggs)) out[`agg${d.id}_${k}`] = v
        continue
      }
      if (!d.bucketField) continue
      const params = buildBucketParams(d)
      if (!params) continue
      out[`agg${d.id}`] = {
        [d.bucketType]: params,
        ...(Object.keys(metricAggs).length ? { aggs: metricAggs } : {})
      }
    }
    return Object.keys(out).length ? out : null
  }

  const run = async (): Promise<void> => {
    const aggs = buildAggs()
    if (!aggs) {
      setError('Configure at least one aggregation (a bucket field, or a metric for metrics-only).')
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

  const defSummary = (d: AggDef): string => {
    const opt = BUCKET_OPTIONS.find((b) => b.value === d.bucketType)?.label ?? d.bucketType
    return d.bucketType === 'none' ? 'Metrics only' : `${opt} — ${d.bucketField}`
  }

  return (
    <div className="shards-view">
      <div className="grid-toolbar">
        <IndexPicker targets={targets} value={index} onChange={setIndex} />
        <div className="spacer" />
        <button
          className="btn ghost"
          onClick={() => setAggDefs((ds) => [...ds, newAggDef()])}
        >
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
            <div className="filter-row" style={{ flexWrap: 'wrap' }}>
              <select
                className="input mono"
                value={d.bucketType}
                onChange={(e) => patchDef(d.id, { bucketType: e.target.value as BucketType })}
                title="Bucket aggregation"
              >
                {BUCKET_OPTIONS.map((b) => (
                  <option key={b.value} value={b.value}>
                    {b.label}
                  </option>
                ))}
              </select>
              {d.bucketType !== 'none' && (
                <select
                  className="input mono"
                  style={{ flex: 1, minWidth: 160 }}
                  value={d.bucketField}
                  onChange={(e) => patchDef(d.id, { bucketField: e.target.value })}
                  title="Bucket field"
                >
                  {bucketChoices(d.bucketType).length === 0 && (
                    <option value="">— no compatible field —</option>
                  )}
                  {bucketChoices(d.bucketType).map((f) => (
                    <option key={f.path} value={f.path}>
                      {f.path} ({f.type})
                    </option>
                  ))}
                </select>
              )}
              {(d.bucketType === 'terms' || d.bucketType === 'significant_terms') && (
                <input
                  className="input mono"
                  style={{ width: 70 }}
                  type="number"
                  min={1}
                  max={1000}
                  value={d.termsSize}
                  onChange={(e) => patchDef(d.id, { termsSize: Number(e.target.value) || 10 })}
                  title="Number of buckets"
                />
              )}
              {d.bucketType === 'date_histogram' && (
                <select
                  className="input mono"
                  value={d.calendarInterval}
                  onChange={(e) => patchDef(d.id, { calendarInterval: e.target.value })}
                  title="Calendar interval"
                >
                  {CALENDAR_INTERVALS.map((c) => (
                    <option key={c} value={c}>
                      per {c}
                    </option>
                  ))}
                </select>
              )}
              {d.bucketType === 'histogram' && (
                <input
                  className="input mono"
                  style={{ width: 90 }}
                  value={d.interval}
                  onChange={(e) => patchDef(d.id, { interval: e.target.value })}
                  title="Interval"
                  placeholder="interval"
                />
              )}
              {d.bucketType === 'range' && (
                <input
                  className="input mono"
                  style={{ width: 160 }}
                  value={d.edges}
                  onChange={(e) => patchDef(d.id, { edges: e.target.value })}
                  title="Range boundaries, comma-separated"
                  placeholder="0,100,1000"
                />
              )}
            </div>

            {d.metrics.map((m) => (
              <div key={m.id} className="filter-row" style={{ maxWidth: 620 }}>
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
                  onClick={() =>
                    patchDef(d.id, { metrics: d.metrics.filter((x) => x.id !== m.id) })
                  }
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
              <Plus size={12} /> Add metric{d.bucketType !== 'none' ? ' (per bucket)' : ''}
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
              if (d.bucketType === 'none') {
                if (d.metrics.length === 0) return null
                return (
                  <div key={d.id} className="agg-result">
                    <div className="agg-section-title mono">
                      #{di + 1} · {defSummary(d)}
                    </div>
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
              const buckets = (response.aggregations?.[`agg${d.id}`] as
                | { buckets?: Record<string, unknown>[] }
                | undefined)?.buckets
              if (!buckets) return null
              return (
                <div key={d.id} className="agg-result">
                  <div className="agg-section-title mono">
                    #{di + 1} · {defSummary(d)} · {buckets.length} buckets
                  </div>
                  <div className="shard-grid-wrap" style={{ marginBottom: 14 }}>
                    <table className="data-table" style={{ border: 'none' }}>
                      <thead>
                        <tr>
                          <th>{d.bucketField || 'Key'}</th>
                          <th>Docs</th>
                          {d.metrics.map((m) => (
                            <th key={m.id}>{metricLabel(m)}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {buckets.map((b, i) => (
                          <tr key={i}>
                            <td className="mono">{String(b.key_as_string ?? b.key)}</td>
                            <td className="mono">{formatNum(b.doc_count)}</td>
                            {d.metrics.map((m) => (
                              <td key={m.id} className="mono">
                                {renderMetricValue(b[metricKey(m)])}
                              </td>
                            ))}
                          </tr>
                        ))}
                        {buckets.length === 0 && (
                          <tr>
                            <td colSpan={2 + d.metrics.length} className="sg-empty">
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
          Add one or more aggregations, optionally scope them with a filter, then Run. Each
          aggregation renders its own table; switch to JSON for the raw response.
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
