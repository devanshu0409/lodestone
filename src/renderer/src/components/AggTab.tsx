import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, Play, Plus, Star, Trash2, X } from 'lucide-react'
import type { ClusterConnection } from '@shared/types'
import {
  esJson,
  fetchCatAliases,
  fetchCatIndices,
  fetchFields,
  type MappedField
} from '../lib/api'
import { buildQuery, hasActiveFilter, newRow, type FilterRow } from '../lib/filterQuery'
import { deleteSavedAgg, listSavedAggs, saveAgg, type SavedAgg } from '../lib/savedAggs'
import { useApp } from '../store'
import { FilterRows } from './FilterRows'
import { IndexPicker } from './SearchTab'
import { JsonView } from './JsonView'
import { Menu, MenuItem, MenuSep, PromptDialog } from './ui'

/* ------------------------------------------------------------------ *
 * A single aggregation = a nesting chain of bucket levels (outer → inner)
 * with metrics computed at the innermost level. Parallel aggregations live
 * in separate workspace tabs (see AggWorkspace).
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

// Synthetic key for the `nested` agg wrapper we inject around nested-field
// aggregations; the response is unwrapped here before shaping.
const NESTED_KEY = 'nested_agg'

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

export function AggTab({
  conn,
  initialIndex,
  onIndexChange
}: {
  conn: ClusterConnection
  initialIndex?: string
  /** Reports the selected index so a hosting workspace can label the tab. */
  onIndexChange?: (index: string) => void
}): React.JSX.Element {
  const [targets, setTargets] = useState<{ label: string; kind: 'index' | 'alias' }[]>([])
  const [index, setIndex] = useState(initialIndex ?? '')
  const [fields, setFields] = useState<MappedField[]>([])
  const [filterRows, setFilterRows] = useState<FilterRow[]>([newRow()])
  const [levels, setLevels] = useState<BucketLevel[]>(() => [newLevel()])
  const [metrics, setMetrics] = useState<MetricRow[]>([])
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [response, setResponse] = useState<AggResponse | null>(null)
  const [view, setView] = useState<'table' | 'json'>('table')
  const [saved, setSaved] = useState<SavedAgg[]>([])
  const [saveOpen, setSaveOpen] = useState(false)
  const pushToast = useApp((s) => s.pushToast)

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

  // Report the current index up for tab labeling.
  const onIndexChangeRef = useRef(onIndexChange)
  onIndexChangeRef.current = onIndexChange
  useEffect(() => {
    if (index) onIndexChangeRef.current?.(index)
  }, [index])

  const fieldMap = useMemo(() => new Map(fields.map((f) => [f.path, f])), [fields])
  const pendingRestoreRef = useRef<SavedAgg | null>(null)

  useEffect(() => setSaved(listSavedAggs(conn.id)), [conn.id])

  const applySaved = (s: SavedAgg): void => {
    if (s.index === index) {
      // Same index — mapping already loaded, apply straight away.
      setLevels(s.levels as BucketLevel[])
      setMetrics(s.metrics as MetricRow[])
      setFilterRows(s.filterRows.length ? s.filterRows : [newRow()])
    } else {
      // Defer to the re-anchor effect once the new index's fields have loaded.
      pendingRestoreRef.current = s
      setIndex(s.index)
    }
  }

  const commitSave = (name: string): void => {
    setSaved(saveAgg(conn.id, { name, index, filterRows, levels, metrics, savedAt: Date.now() }))
    pushToast('ok', `Saved “${name}”`)
  }

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

  const patchLevel = (id: number, p: Partial<BucketLevel>): void =>
    setLevels((ls) =>
      ls.map((l) => {
        if (l.id !== id) return l
        const next = { ...l, ...p }
        const choices = bucketChoices(next.bucketType)
        if (!choices.some((f) => f.path === next.bucketField)) {
          next.bucketField = choices[0]?.path ?? ''
        }
        return next
      })
    )

  const patchMetric = (id: number, p: Partial<MetricRow>): void =>
    setMetrics((ms) => ms.map((m) => (m.id === id ? { ...m, ...p } : m)))

  // Re-anchor fields to the current index's mapping when it changes. A saved
  // agg being restored across an index switch lands its levels/metrics here
  // instead — once the new mapping has loaded — so the re-anchor validates the
  // restored fields against the right mapping rather than the outgoing one.
  useEffect(() => {
    const pending = pendingRestoreRef.current
    if (pending) {
      pendingRestoreRef.current = null
      setLevels(pending.levels as BucketLevel[])
      setMetrics(pending.metrics as MetricRow[])
      setFilterRows(pending.filterRows.length ? pending.filterRows : [newRow()])
      return
    }
    setLevels((ls) =>
      ls.map((l) => {
        const choices = bucketChoices(l.bucketType)
        return choices.some((f) => f.path === l.bucketField)
          ? l
          : { ...l, bucketField: choices[0]?.path ?? '' }
      })
    )
    setMetrics((ms) =>
      ms.map((m) =>
        metricFieldChoices(m.type).some((f) => f.path === m.field)
          ? m
          : { ...m, field: metricFieldChoices(m.type)[0]?.path ?? '' }
      )
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

  /**
   * The `nested` path shared by every bucket + metric field, if any.
   * Returns undefined when nothing is nested. Throws when fields mix root and
   * nested (or span two nested paths): that needs `reverse_nested` to climb
   * back out, which this builder doesn't emit — better to refuse than report
   * silently wrong doc counts.
   * ponytail: single nested path only; reverse_nested for mixed if it comes up.
   */
  const sharedNestedPath = (): string | undefined => {
    const paths = new Set<string | undefined>()
    for (const l of levels) if (l.bucketField) paths.add(fieldMap.get(l.bucketField)?.nestedPath)
    for (const m of metrics) if (m.field) paths.add(fieldMap.get(m.field)?.nestedPath)
    const nested = [...paths].filter((p): p is string => !!p)
    if (nested.length === 0) return undefined
    if (nested.length > 1 || paths.has(undefined)) {
      throw new Error(
        'This aggregation mixes a nested field with a root or a different nested field. ' +
          'Keep every bucket and metric field under the same nested field.'
      )
    }
    return nested[0]
  }

  const buildAggs = (): Record<string, unknown> | null => {
    const metricAggs: Record<string, unknown> = {}
    for (const m of metrics) {
      if (m.field) metricAggs[metricKey(m)] = { [m.type]: { field: esField(m.field) } }
    }
    // Nested subfields need a `nested` agg wrapper or the cluster returns nothing.
    const nestedPath = sharedNestedPath()
    const wrap = (tree: Record<string, unknown>): Record<string, unknown> =>
      nestedPath ? { [NESTED_KEY]: { nested: { path: nestedPath }, aggs: tree } } : tree

    // No grouping → metrics over all matching docs.
    if (levels.length === 0) return Object.keys(metricAggs).length ? wrap(metricAggs) : null
    if (levels.some((l) => !l.bucketField)) return null
    // Recursively nest: level i's sub-aggs are keyed `l{i+1}`; the leaf holds metrics.
    const buildLevel = (i: number): Record<string, unknown> | null => {
      const params = bucketParams(levels[i])
      if (!params) return null
      const node: Record<string, unknown> = { [levels[i].bucketType]: params }
      const child: Record<string, unknown> = {}
      if (i < levels.length - 1) {
        const c = buildLevel(i + 1)
        if (c) child[`l${i + 1}`] = c
      } else {
        Object.assign(child, metricAggs)
      }
      if (Object.keys(child).length) node.aggs = child
      return node
    }
    const top = buildLevel(0)
    return top ? wrap({ agg: top }) : null
  }

  const run = async (): Promise<void> => {
    let aggs: Record<string, unknown> | null
    try {
      aggs = buildAggs()
    } catch (err) {
      // sharedNestedPath throws on an unsupported nested/root mix.
      setError((err as Error).message)
      setResponse(null)
      return
    }
    if (!aggs) {
      setError('Configure a group-by field, or add a metric.')
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

  // A nested-field aggregation is wrapped in a `nested` agg; the real buckets/
  // metrics sit one level in. Descend through it so shaping is wrapper-agnostic.
  const aggRoot = ((): Record<string, unknown> | undefined => {
    const a = response?.aggregations
    const wrapped = a?.[NESTED_KEY] as Record<string, unknown> | undefined
    return wrapped ?? a
  })()

  /** Flatten the nested-bucket response into one row per leaf bucket. */
  const flatten = (): { keys: unknown[]; doc_count: number; bucket: Bucket }[] => {
    const rows: { keys: unknown[]; doc_count: number; bucket: Bucket }[] = []
    const walk = (node: unknown, i: number, keyPath: unknown[]): void => {
      const buckets = (node as { buckets?: Bucket[] } | undefined)?.buckets ?? []
      for (const b of buckets) {
        const path = [...keyPath, b.key_as_string ?? b.key]
        if (i === levels.length - 1) rows.push({ keys: path, doc_count: b.doc_count, bucket: b })
        else walk(b[`l${i + 1}`], i + 1, path)
      }
    }
    walk(aggRoot?.agg, 0, [])
    return rows
  }

  const chainSummary = levels.length === 0 ? 'Metrics only' : levels.map((l) => l.bucketField || '?').join(' → ')
  const rows = response && levels.length > 0 ? flatten() : []

  return (
    <div className="shards-view">
      <div className="grid-toolbar">
        <IndexPicker targets={targets} value={index} onChange={setIndex} />
        <div className="spacer" />
        <Menu
          trigger={
            <button className="btn ghost" title="Saved aggregations">
              <Star size={13} /> Saved
              {saved.length > 0 && <span className="chip saved-count">{saved.length}</span>}
              <ChevronDown size={12} />
            </button>
          }
        >
          <MenuItem onSelect={() => setSaveOpen(true)}>Save current aggregation…</MenuItem>
          {saved.length > 0 && <MenuSep />}
          {saved.map((s) => (
            <MenuItem key={s.name} onSelect={() => applySaved(s)}>
              <span className="saved-item">
                <span className="saved-name">{s.name}</span>
                <span className="saved-index mono">{s.index}</span>
                <span
                  role="button"
                  tabIndex={0}
                  className="saved-del"
                  title={`Delete “${s.name}”`}
                  onClick={(e) => {
                    e.stopPropagation()
                    setSaved(deleteSavedAgg(conn.id, s.name))
                  }}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter' && e.key !== ' ') return
                    e.stopPropagation()
                    e.preventDefault()
                    setSaved(deleteSavedAgg(conn.id, s.name))
                  }}
                >
                  <Trash2 size={12} />
                </span>
              </span>
            </MenuItem>
          ))}
        </Menu>
        <button className="btn primary" disabled={running || !index} onClick={() => void run()}>
          <Play size={12} />
          {running ? 'Running…' : 'Run'}
        </button>
      </div>

      <div className="agg-filter">
        <span className="pane-label">Filter (optional) — scopes the aggregation</span>
        <FilterRows rows={filterRows} onChange={setFilterRows} fields={fields} onEnter={() => void run()} />
      </div>

      <div className="agg-card">
        {/* nesting chain of bucket levels */}
        {levels.map((lvl, li) => (
          <div key={lvl.id} className="filter-row" style={{ flexWrap: 'wrap' }}>
            <span className="conj-lead mono">{li === 0 ? 'group by' : 'then by'}</span>
            <select
              className="input mono"
              style={{ flex: 'none', width: 'auto' }}
              value={lvl.bucketType}
              onChange={(e) => patchLevel(lvl.id, { bucketType: e.target.value as BucketType })}
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
              onChange={(e) => patchLevel(lvl.id, { bucketField: e.target.value })}
              title="Bucket field"
            >
              {bucketChoices(lvl.bucketType).length === 0 && <option value="">— no compatible field —</option>}
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
                onChange={(e) => patchLevel(lvl.id, { termsSize: Number(e.target.value) || 10 })}
                title="Top N buckets"
              />
            )}
            {lvl.bucketType === 'date_histogram' && (
              <select
                className="input mono"
                value={lvl.calendarInterval}
                onChange={(e) => patchLevel(lvl.id, { calendarInterval: e.target.value })}
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
                onChange={(e) => patchLevel(lvl.id, { interval: e.target.value })}
                placeholder="interval"
                title="Interval"
              />
            )}
            {lvl.bucketType === 'range' && (
              <input
                className="input mono"
                style={{ width: 150 }}
                value={lvl.edges}
                onChange={(e) => patchLevel(lvl.id, { edges: e.target.value })}
                placeholder="0,100,1000"
                title="Range boundaries, comma-separated"
              />
            )}
            <button
              className="icon-btn"
              title="Remove this level"
              onClick={() => setLevels((ls) => ls.filter((x) => x.id !== lvl.id))}
            >
              <X size={13} />
            </button>
          </div>
        ))}
        {levels.length === 0 && (
          <span className="hint" style={{ fontSize: 11, color: 'var(--ink-3)' }}>
            No grouping — metrics computed over all matching documents.
          </span>
        )}
        <button
          className="btn ghost"
          style={{ alignSelf: 'flex-start' }}
          onClick={() => setLevels((ls) => [...ls, newLevel()])}
        >
          <Plus size={12} /> {levels.length === 0 ? 'Add group-by' : 'Add sub-bucket (nest deeper)'}
        </button>

        {/* metrics computed at the innermost bucket */}
        {metrics.map((m) => (
          <div key={m.id} className="filter-row" style={{ maxWidth: 640 }}>
            <span className="conj-lead mono">metric</span>
            <select
              className="input mono"
              style={{ flex: 'none', width: 'auto' }}
              value={m.type}
              onChange={(e) => {
                const type = e.target.value as MetricType
                patchMetric(m.id, {
                  type,
                  field: metricFieldChoices(type).some((f) => f.path === m.field)
                    ? m.field
                    : (metricFieldChoices(type)[0]?.path ?? '')
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
              style={{ flex: 1, minWidth: 150 }}
              value={m.field}
              onChange={(e) => patchMetric(m.id, { field: e.target.value })}
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
        <button
          className="btn ghost"
          style={{ alignSelf: 'flex-start' }}
          onClick={() => setMetrics((ms) => [...ms, { id: ++seq, type: 'avg', field: numeric[0]?.path ?? '' }])}
        >
          <Plus size={12} /> Add metric{levels.length > 0 ? ' (per innermost bucket)' : ''}
        </button>
      </div>

      {error && <div className="res-error" style={{ marginBottom: 10 }}>{error}</div>}

      {response && (
        <>
          <div className="result-meta" style={{ marginBottom: 8 }}>
            <span className="chip">{response.took ?? 0} ms</span>
            {hasActiveFilter(filterRows) && <span className="chip">filtered</span>}
            {levels.length > 0 && <span className="chip">{rows.length} rows</span>}
            <span className="agg-section-title mono" style={{ margin: 0 }}>
              {chainSummary}
            </span>
            <div className="view-toggle" style={{ marginLeft: 'auto' }}>
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
          ) : levels.length === 0 ? (
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
                      <td className="mono">{renderMetricValue(aggRoot?.[metricKey(m)])}</td>
                    </tr>
                  ))}
                  {metrics.length === 0 && (
                    <tr>
                      <td colSpan={2} className="sg-empty">
                        No metrics configured.
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
                    {levels.map((l) => (
                      <th key={l.id}>{l.bucketField || 'key'}</th>
                    ))}
                    <th>Docs</th>
                    {metrics.map((m) => (
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
                      {metrics.map((m) => (
                        <td key={m.id} className="mono">
                          {renderMetricValue(r.bucket[metricKey(m)])}
                        </td>
                      ))}
                    </tr>
                  ))}
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={levels.length + 1 + metrics.length} className="sg-empty">
                        No buckets returned.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {!response && !error && (
        <p className="cat-empty" style={{ marginTop: 12 }}>
          Group by one or more fields (nest with “Add sub-bucket”), add metrics, optionally scope
          with a filter, then Run. Use the + tab above to run another aggregation side by side.
        </p>
      )}

      <PromptDialog
        open={saveOpen}
        title="Save aggregation"
        label="Name"
        placeholder="e.g. Errors by service"
        initialValue={index ? `${index} aggregation` : 'aggregation'}
        hint="Saves the index, filter, bucket levels and metrics for this cluster."
        onSubmit={commitSave}
        onClose={() => setSaveOpen(false)}
      />
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
