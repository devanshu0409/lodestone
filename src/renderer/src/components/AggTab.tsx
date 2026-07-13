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

let metricSeq = 0

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
  const [bucketType, setBucketType] = useState<BucketType>('terms')
  const [bucketField, setBucketField] = useState('')
  const [termsSize, setTermsSize] = useState(10)
  const [interval, setIntervalValue] = useState('100')
  const [calendarInterval, setCalendarInterval] = useState('day')
  const [edges, setEdges] = useState('0,100,1000')
  const [metrics, setMetrics] = useState<MetricRow[]>([])
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

  // Field choices per role. Aggregations run on exact values, so text fields
  // participate via their .keyword sub-field (sortPath).
  const keywordish = useMemo(() => fields.filter((f) => f.sortPath), [fields])
  const numeric = useMemo(() => fields.filter((f) => NUMERIC_TYPES.has(f.type)), [fields])
  const dates = useMemo(() => fields.filter((f) => DATE_TYPES.has(f.type)), [fields])

  const bucketChoices = useMemo(() => {
    switch (bucketType) {
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
  }, [bucketType, keywordish, numeric, dates])

  // Keep the bucket field valid for the chosen bucket type.
  useEffect(() => {
    if (bucketType === 'none') return
    if (!bucketChoices.some((f) => f.path === bucketField)) {
      setBucketField(bucketChoices[0]?.path ?? '')
    }
  }, [bucketType, bucketChoices, bucketField])

  const metricFieldChoices = (type: MetricType): MappedField[] =>
    METRIC_OPTIONS.find((m) => m.value === type)?.numeric ? numeric : keywordish

  const addMetric = (): void => {
    const type: MetricType = 'avg'
    setMetrics((ms) => [
      ...ms,
      { id: ++metricSeq, type, field: numeric[0]?.path ?? '' }
    ])
  }

  const esField = (path: string): string =>
    fields.find((f) => f.path === path)?.sortPath ?? path

  const buildAggs = (): Record<string, unknown> | null => {
    const metricAggs: Record<string, unknown> = {}
    for (const m of metrics) {
      if (!m.field) continue
      metricAggs[`${m.type}_${m.field.replace(/[^\w]/g, '_')}`] = { [m.type]: { field: esField(m.field) } }
    }
    if (bucketType === 'none') {
      return Object.keys(metricAggs).length ? metricAggs : null
    }
    if (!bucketField) return null
    let params: Record<string, unknown>
    switch (bucketType) {
      case 'terms':
      case 'significant_terms':
        params = { field: esField(bucketField), size: termsSize }
        break
      case 'date_histogram':
        params = { field: bucketField, calendar_interval: calendarInterval }
        break
      case 'histogram':
        params = { field: bucketField, interval: Number(interval) || 1 }
        break
      case 'range': {
        const bounds = edges
          .split(',')
          .map((e) => Number(e.trim()))
          .filter((n) => Number.isFinite(n))
          .sort((a, b) => a - b)
        const ranges: { from?: number; to?: number }[] = []
        if (bounds.length === 0) return null
        ranges.push({ to: bounds[0] })
        for (let i = 0; i < bounds.length - 1; i++) ranges.push({ from: bounds[i], to: bounds[i + 1] })
        ranges.push({ from: bounds[bounds.length - 1] })
        params = { field: bucketField, ranges }
        break
      }
      case 'missing':
        params = { field: esField(bucketField) }
        break
      default:
        return null
    }
    return {
      buckets: {
        [bucketType]: params,
        ...(Object.keys(metricAggs).length ? { aggs: metricAggs } : {})
      }
    }
  }

  const run = async (): Promise<void> => {
    const aggs = buildAggs()
    if (!aggs) {
      setError(
        bucketType === 'none'
          ? 'Add at least one metric to run a metrics-only aggregation.'
          : 'Pick a field for the bucket aggregation.'
      )
      return
    }
    setRunning(true)
    setError(null)
    try {
      const res = await esJson<AggResponse>(conn.id, {
        method: 'POST',
        path: `/${encodeURIComponent(index)}/_search`,
        body: { size: 0, aggs }
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

  const metricKey = (m: MetricRow): string => `${m.type}_${m.field.replace(/[^\w]/g, '_')}`

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

  const buckets = (response?.aggregations?.buckets as
    | { buckets?: Record<string, unknown>[] }
    | undefined)?.buckets

  return (
    <div className="shards-view">
      <div className="grid-toolbar" style={{ flexWrap: 'wrap', rowGap: 8 }}>
        <IndexPicker targets={targets} value={index} onChange={setIndex} />
        <select
          className="input mono"
          value={bucketType}
          onChange={(e) => setBucketType(e.target.value as BucketType)}
          title="Bucket aggregation"
        >
          {BUCKET_OPTIONS.map((b) => (
            <option key={b.value} value={b.value}>
              {b.label}
            </option>
          ))}
        </select>
        {bucketType !== 'none' && (
          <select
            className="input mono"
            value={bucketField}
            onChange={(e) => setBucketField(e.target.value)}
            title="Bucket field"
          >
            {bucketChoices.length === 0 && <option value="">— no compatible field —</option>}
            {bucketChoices.map((f) => (
              <option key={f.path} value={f.path}>
                {f.path} ({f.type})
              </option>
            ))}
          </select>
        )}
        {(bucketType === 'terms' || bucketType === 'significant_terms') && (
          <input
            className="input mono"
            style={{ width: 70 }}
            type="number"
            min={1}
            max={1000}
            value={termsSize}
            onChange={(e) => setTermsSize(Number(e.target.value) || 10)}
            title="Number of buckets"
          />
        )}
        {bucketType === 'date_histogram' && (
          <select
            className="input mono"
            value={calendarInterval}
            onChange={(e) => setCalendarInterval(e.target.value)}
            title="Calendar interval"
          >
            {CALENDAR_INTERVALS.map((c) => (
              <option key={c} value={c}>
                per {c}
              </option>
            ))}
          </select>
        )}
        {bucketType === 'histogram' && (
          <input
            className="input mono"
            style={{ width: 90 }}
            value={interval}
            onChange={(e) => setIntervalValue(e.target.value)}
            title="Interval"
            placeholder="interval"
          />
        )}
        {bucketType === 'range' && (
          <input
            className="input mono"
            style={{ width: 160 }}
            value={edges}
            onChange={(e) => setEdges(e.target.value)}
            title="Range boundaries, comma-separated"
            placeholder="0,100,1000"
          />
        )}
        <div className="spacer" />
        <button className="btn primary" disabled={running || !index} onClick={() => void run()}>
          <Play size={12} />
          {running ? 'Running…' : 'Run'}
        </button>
      </div>

      <div className="agg-metrics">
        <span className="pane-label" style={{ paddingTop: 6 }}>
          Metrics{bucketType !== 'none' ? ' (per bucket)' : ''}
        </span>
        {metrics.map((m) => (
          <div key={m.id} className="filter-row" style={{ maxWidth: 620 }}>
            <select
              className="input mono"
              value={m.type}
              onChange={(e) => {
                const type = e.target.value as MetricType
                setMetrics((ms) =>
                  ms.map((x) =>
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
                )
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
                setMetrics((ms) => ms.map((x) => (x.id === m.id ? { ...x, field: e.target.value } : x)))
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
              onClick={() => setMetrics((ms) => ms.filter((x) => x.id !== m.id))}
            >
              <X size={13} />
            </button>
          </div>
        ))}
        <button className="btn ghost" style={{ alignSelf: 'flex-start' }} onClick={addMetric}>
          <Plus size={12} /> Add metric
        </button>
      </div>

      {error && <div className="res-error" style={{ marginBottom: 10 }}>{error}</div>}

      {response && (
        <>
          <div className="result-meta" style={{ marginBottom: 8 }}>
            <span className="chip">{response.took ?? 0} ms</span>
            {buckets && <span className="chip">{buckets.length} buckets</span>}
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
          ) : buckets ? (
            <div className="shard-grid-wrap" style={{ marginBottom: 14 }}>
              <table className="data-table" style={{ border: 'none' }}>
                <thead>
                  <tr>
                    <th>{bucketField || 'Key'}</th>
                    <th>Docs</th>
                    {metrics.map((m) => (
                      <th key={m.id}>{metricLabel(m)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {buckets.map((b, i) => (
                    <tr key={i}>
                      <td className="mono">{String(b.key_as_string ?? b.key)}</td>
                      <td className="mono">{formatNum(b.doc_count)}</td>
                      {metrics.map((m) => (
                        <td key={m.id} className="mono">
                          {renderMetricValue(b[metricKey(m)])}
                        </td>
                      ))}
                    </tr>
                  ))}
                  {buckets.length === 0 && (
                    <tr>
                      <td colSpan={2 + metrics.length} className="sg-empty">
                        No buckets returned.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="shard-grid-wrap" style={{ marginBottom: 14 }}>
              <table className="data-table" style={{ border: 'none' }}>
                <thead>
                  <tr>
                    <th>Metric</th>
                    <th>Value</th>
                  </tr>
                </thead>
                <tbody>
                  {metrics.map((m) => (
                    <tr key={m.id}>
                      <td>{metricLabel(m)}</td>
                      <td className="mono">
                        {renderMetricValue(response.aggregations?.[metricKey(m)])}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {!response && !error && (
        <p className="cat-empty" style={{ marginTop: 12 }}>
          Pick a bucket aggregation and (optionally) metrics, then Run. Results show as a table or
          raw JSON.
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
