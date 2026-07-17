import { useEffect, useMemo, useRef, useState } from 'react'
import { Braces, Copy, Pencil, Play, Plus, Square, X } from 'lucide-react'
import type { ClusterConnection, ClusterOverview } from '@shared/types'
import { fetchCatAliases, fetchCatIndices, fetchFields, type MappedField } from '../lib/api'
import { newRow } from '../lib/filterQuery'
import {
  LEFT_CAPS,
  colLabel,
  compileSearchBody,
  runRawSql,
  runStructured,
  toSql,
  type SelectCol,
  type SqlFunc,
  type SqlResult,
  type SqlState
} from '../lib/sqlEngine'
import { useApp } from '../store'
import { CodeEditor } from './CodeEditor'
import { FilterRows } from './FilterRows'
import { IndexPicker } from './SearchTab'
import { JsonView } from './JsonView'

const FUNCS: SqlFunc[] = ['COUNT', 'AVG', 'SUM', 'MIN', 'MAX']
const NUMERIC_TYPES = new Set([
  'long', 'integer', 'short', 'byte', 'double', 'float',
  'half_float', 'scaled_float', 'unsigned_long'
])

let seq = 0

export function SqlTab({
  conn,
  overview,
  initialIndex,
  onIndexChange
}: {
  conn: ClusterConnection
  overview: ClusterOverview
  initialIndex?: string
  /** Reports the selected index so a hosting workspace can label the tab. */
  onIndexChange?: (index: string) => void
}): React.JSX.Element {
  const pushToast = useApp((s) => s.pushToast)
  const [targets, setTargets] = useState<{ label: string; kind: 'index' | 'alias' }[]>([])
  const [fields, setFields] = useState<MappedField[]>([])
  const [rightFields, setRightFields] = useState<MappedField[]>([])
  const [rawMode, setRawMode] = useState(false)
  const [rawSql, setRawSql] = useState('')
  const [showDsl, setShowDsl] = useState(false)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<SqlResult | null>(null)
  const [view, setView] = useState<'table' | 'json'>('table')
  const [layout, setLayout] = useState<'split' | 'builder' | 'result'>('split')
  const abortRef = useRef<AbortController | null>(null)

  const [state, setState] = useState<SqlState>(() => ({
    index: initialIndex ?? '',
    columns: [],
    where: [newRow()],
    join: {
      enabled: false,
      type: 'inner',
      rightIndex: '',
      leftKey: '',
      rightKey: '',
      rightWhere: [newRow()]
    },
    groupBy: '',
    orderBy: null,
    limit: 100,
    leftCap: 1000
  }))

  const patch = (p: Partial<SqlState>): void => setState((s) => ({ ...s, ...p }))
  const patchJoin = (p: Partial<SqlState['join']>): void =>
    setState((s) => ({ ...s, join: { ...s.join, ...p } }))

  useEffect(() => {
    Promise.all([fetchCatIndices(conn.id), fetchCatAliases(conn.id)])
      .then(([indices, aliases]) => {
        const t = [
          ...aliases.map((a) => ({ label: a.alias, kind: 'alias' as const })),
          ...indices.filter((i) => !i.index.startsWith('.')).map((i) => ({ label: i.index, kind: 'index' as const }))
        ]
        setTargets(t)
        setState((s) => (s.index ? s : { ...s, index: t[0]?.label ?? '' }))
      })
      .catch((err: Error) => setError(err.message))
  }, [conn.id])

  useEffect(() => {
    if (!state.index) return
    fetchFields(conn.id, state.index)
      .then(setFields)
      .catch(() => setFields([]))
    setResult(null)
  }, [conn.id, state.index])

  useEffect(() => {
    if (!state.join.enabled || !state.join.rightIndex) return
    fetchFields(conn.id, state.join.rightIndex)
      .then(setRightFields)
      .catch(() => setRightFields([]))
  }, [conn.id, state.join.enabled, state.join.rightIndex])

  const onIndexChangeRef = useRef(onIndexChange)
  onIndexChangeRef.current = onIndexChange
  useEffect(() => {
    if (state.index) onIndexChangeRef.current?.(state.index)
  }, [state.index])

  const fieldMap = useMemo(() => new Map(fields.map((f) => [f.path, f])), [fields])
  const rightFieldMap = useMemo(() => new Map(rightFields.map((f) => [f.path, f])), [rightFields])
  const numericFields = useMemo(() => fields.filter((f) => NUMERIC_TYPES.has(f.type)), [fields])
  const rightNumericFields = useMemo(
    () => rightFields.filter((f) => NUMERIC_TYPES.has(f.type)),
    [rightFields]
  )
  const keyFields = (fs: MappedField[]): MappedField[] => fs.filter((f) => f.sortPath)

  /** Field choices for a SELECT column, respecting side and function. */
  const listFor = (c: SelectCol): MappedField[] =>
    c.func && c.func !== 'COUNT'
      ? c.side === 'r' ? rightNumericFields : numericFields
      : c.side === 'r' ? rightFields : fields

  const sqlText = useMemo(() => toSql(state), [state])

  // ORDER BY choices = output column labels of the current shape.
  const orderChoices = useMemo(() => {
    const joined = state.join.enabled
    const funcs = state.columns.filter((c) => c.func)
    // Aggregated output = [group key?, ...function columns] — plain columns disappear.
    if (funcs.length > 0 || state.groupBy) {
      return [...(state.groupBy ? [state.groupBy] : []), ...funcs.map((c) => colLabel(c, joined))]
    }
    if (state.columns.length > 0) return state.columns.map((c) => colLabel(c, joined))
    const l = fields.map((f) => (joined ? `l.${f.path}` : f.path))
    return joined ? [...l, ...rightFields.map((f) => `r.${f.path}`)] : l
  }, [state.columns, state.join.enabled, state.groupBy, fields, rightFields])

  const run = async (): Promise<void> => {
    abortRef.current?.abort()
    const ctl = new AbortController()
    abortRef.current = ctl
    setRunning(true)
    setError(null)
    try {
      const res = rawMode
        ? await runRawSql(conn.id, overview.info.distribution, rawSql, ctl.signal)
        : await runStructured(conn.id, state, fields, fieldMap, rightFields, rightFieldMap, ctl.signal)
      setResult(res)
    } catch (err) {
      // A stop is a user action, not a failure — leave the previous result alone.
      if (ctl.signal.aborted) return
      setError((err as Error).message)
      setResult(null)
    } finally {
      // A newer run may already own the spinner; only the current one clears it.
      if (abortRef.current === ctl) {
        abortRef.current = null
        setRunning(false)
      }
    }
  }

  const stop = (): void => {
    abortRef.current?.abort()
    abortRef.current = null
    setRunning(false)
  }

  // Stop in-flight work if the tab unmounts (closed tab, cluster switch).
  useEffect(() => () => abortRef.current?.abort(), [])

  const copySql = (): void => {
    navigator.clipboard.writeText(rawMode ? rawSql : sqlText)
    pushToast('ok', 'Copied SQL')
  }

  const addColumn = (func?: SqlFunc): void => {
    const col: SelectCol = {
      id: ++seq,
      side: 'l',
      func,
      field: func && func !== 'COUNT' ? (numericFields[0]?.path ?? '') : func === 'COUNT' ? '' : (fields[0]?.path ?? '')
    }
    setState((s) => ({ ...s, columns: [...s.columns, col] }))
  }

  const patchCol = (id: number, p: Partial<SelectCol>): void =>
    setState((s) => ({ ...s, columns: s.columns.map((c) => (c.id === id ? { ...c, ...p } : c)) }))

  const compiledDsl = useMemo(
    () => (showDsl ? compileSearchBody(state, fields, fieldMap) : null),
    [showDsl, state, fields, fieldMap]
  )

  return (
    <div className={`shards-view sql-tab${result ? ' has-result' : ''} layout-${layout}`}>
      <div className="grid-toolbar">
        <IndexPicker targets={targets} value={state.index} onChange={(v) => patch({ index: v })} />
        <button className={`btn ${rawMode ? '' : 'ghost'}`} onClick={() => setRawMode((m) => !m)}>
          {rawMode ? 'Builder' : 'Raw SQL'}
        </button>
        <div className="spacer" />
        {!rawMode && (
          <button className="btn ghost" title="Show the compiled _search request" onClick={() => setShowDsl((v) => !v)}>
            <Braces size={13} /> DSL
          </button>
        )}
        {result && !rawMode && (
          <div className="view-toggle" style={{ marginRight: 4 }}>
            <button
              className={layout === 'builder' ? 'on' : ''}
              onClick={() => setLayout('builder')}
              title="Builder only — hide result"
            >
              Builder
            </button>
            <button className={layout === 'split' ? 'on' : ''} onClick={() => setLayout('split')} title="Split">
              Split
            </button>
            <button
              className={layout === 'result' ? 'on' : ''}
              onClick={() => setLayout('result')}
              title="Result only — hide builder"
            >
              Result
            </button>
          </div>
        )}
        <button className="btn" title="Copy SQL" onClick={copySql}>
          <Copy size={13} />
        </button>
        {running ? (
          <button className="btn" title="Stop — Lodestone issues no further requests" onClick={stop}>
            <Square size={11} /> Stop
          </button>
        ) : (
          <button className="btn primary" disabled={!rawMode && !state.index} onClick={() => void run()}>
            <Play size={12} /> Run
          </button>
        )}
      </div>

      <div className="sql-builder">
      {rawMode ? (
        <div className="agg-card" style={{ marginBottom: 12 }}>
          <span className="pane-label">
            Raw SQL — sent to {overview.info.distribution === 'opensearch' ? '/_plugins/_sql' : '/_sql'} as-is
            (JOINs here run on the cluster, if the server supports them at all)
          </span>
          <CodeEditor value={rawSql} onChange={setRawSql} language="sql" height={120} />
        </div>
      ) : (
        <>
          {/* SELECT */}
          <div className="agg-card" style={{ marginBottom: 10 }}>
            <span className="pane-label">Select — empty list = all columns (*)</span>
            {state.columns.map((c) => (
              <div key={c.id} className="filter-row" style={{ maxWidth: 680 }}>
                <span className="conj-lead mono">{c.func ? 'function' : 'column'}</span>
                {state.join.enabled && (
                  <select
                    className="input mono"
                    style={{ flex: 'none', width: 'auto' }}
                    value={c.side}
                    onChange={(e) => {
                      const side = e.target.value as 'l' | 'r'
                      const list = listFor({ ...c, side })
                      // COUNT(*) keeps its empty field; everything else re-picks
                      // from the new side's list.
                      patchCol(c.id, {
                        side,
                        field: c.func === 'COUNT' && c.field === '' ? '' : (list[0]?.path ?? '')
                      })
                    }}
                  >
                    <option value="l">left</option>
                    <option value="r">right</option>
                  </select>
                )}
                {c.func && (
                  <select
                    className="input mono"
                    style={{ flex: 'none', width: 'auto' }}
                    value={c.func}
                    onChange={(e) => {
                      const func = e.target.value as SqlFunc
                      patchCol(c.id, {
                        func,
                        field: func === 'COUNT' ? '' : (numericFields[0]?.path ?? '')
                      })
                    }}
                  >
                    {FUNCS.map((f) => (
                      <option key={f} value={f}>
                        {f}
                      </option>
                    ))}
                  </select>
                )}
                <select
                  className="input mono"
                  style={{ flex: 1, minWidth: 150 }}
                  value={c.field}
                  onChange={(e) => patchCol(c.id, { field: e.target.value })}
                >
                  {c.func === 'COUNT' && <option value="">* (all docs)</option>}
                  {listFor(c).map((f) => (
                    <option key={f.path} value={f.path}>
                      {f.path} ({f.type})
                    </option>
                  ))}
                </select>
                <button
                  className="icon-btn"
                  title="Remove"
                  onClick={() => setState((s) => ({ ...s, columns: s.columns.filter((x) => x.id !== c.id) }))}
                >
                  <X size={13} />
                </button>
              </div>
            ))}
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn ghost" onClick={() => addColumn()}>
                <Plus size={12} /> Add column
              </button>
              <button className="btn ghost" onClick={() => addColumn('COUNT')}>
                <Plus size={12} /> Add function
              </button>
            </div>
          </div>

          {/* WHERE */}
          <div className="agg-filter">
            <span className="pane-label">Where</span>
            <FilterRows rows={state.where} onChange={(rows) => patch({ where: rows })} fields={fields} onEnter={() => void run()} />
          </div>

          {/* JOIN */}
          <div className="agg-card" style={{ marginBottom: 10 }}>
            <div className="agg-card-head">
              <label className="check" style={{ alignItems: 'center', gap: 6 }}>
                <input
                  type="checkbox"
                  checked={state.join.enabled}
                  onChange={(e) =>
                    // Group/order labels are side-qualified only when joined —
                    // reset both so a stale format can't leak across the toggle.
                    setState((s) => ({
                      ...s,
                      groupBy: '',
                      orderBy: null,
                      join: { ...s.join, enabled: e.target.checked }
                    }))
                  }
                />
                <span className="pane-label" style={{ padding: 0 }}>Join another index</span>
              </label>
              {state.join.enabled && (
                <span className="hint" style={{ fontSize: 11, color: 'var(--ink-3)' }}>
                  Runs inside Lodestone as bounded searches — the cluster never executes a join.
                </span>
              )}
            </div>
            {state.join.enabled && (
              <>
                <div className="filter-row" style={{ flexWrap: 'wrap' }}>
                  <select
                    className="input mono"
                    style={{ flex: 'none', width: 'auto' }}
                    value={state.join.type}
                    onChange={(e) => patchJoin({ type: e.target.value as 'inner' | 'left' })}
                  >
                    <option value="inner">INNER JOIN</option>
                    <option value="left">LEFT JOIN</option>
                  </select>
                  <IndexPicker
                    targets={targets.filter((t) => t.label !== state.index)}
                    value={state.join.rightIndex}
                    onChange={(v) => patchJoin({ rightIndex: v })}
                  />
                  <span className="conj-lead mono" style={{ width: 'auto' }}>on</span>
                  <select
                    className="input mono"
                    style={{ flex: 1, minWidth: 140 }}
                    value={state.join.leftKey}
                    onChange={(e) => patchJoin({ leftKey: e.target.value })}
                    title="Left join key"
                  >
                    <option value="">— left key —</option>
                    {keyFields(fields).map((f) => (
                      <option key={f.path} value={f.path}>
                        l.{f.path}
                      </option>
                    ))}
                  </select>
                  <span className="mono" style={{ color: 'var(--ink-3)' }}>=</span>
                  <select
                    className="input mono"
                    style={{ flex: 1, minWidth: 140 }}
                    value={state.join.rightKey}
                    onChange={(e) => patchJoin({ rightKey: e.target.value })}
                    title="Right join key"
                  >
                    <option value="">— right key —</option>
                    {keyFields(rightFields).map((f) => (
                      <option key={f.path} value={f.path}>
                        r.{f.path}
                      </option>
                    ))}
                  </select>
                  <select
                    className="input mono"
                    style={{ flex: 'none', width: 'auto' }}
                    value={state.leftCap}
                    onChange={(e) => patch({ leftCap: Number(e.target.value) })}
                    title="Safety cap: max left-side rows fetched for the join"
                  >
                    {LEFT_CAPS.map((c) => (
                      <option key={c} value={c}>
                        cap {c.toLocaleString()}
                      </option>
                    ))}
                  </select>
                </div>
                <span className="pane-label">Where (right index)</span>
                <FilterRows
                  rows={state.join.rightWhere}
                  onChange={(rows) => patchJoin({ rightWhere: rows })}
                  fields={rightFields}
                />
              </>
            )}
          </div>

          {/* GROUP BY / ORDER BY / LIMIT */}
          <div className="filter-row" style={{ flexWrap: 'wrap', marginBottom: 10 }}>
            <span className="conj-lead mono">group by</span>
            <select
              className="input mono"
              style={{ flex: 'none', width: 'auto', minWidth: 130 }}
              value={state.groupBy}
              onChange={(e) => patch({ groupBy: e.target.value })}
            >
              <option value="">— none —</option>
              {(state.join.enabled
                ? [
                    ...keyFields(fields).map((f) => `l.${f.path}`),
                    ...keyFields(rightFields).map((f) => `r.${f.path}`)
                  ]
                : keyFields(fields).map((f) => f.path)
              ).map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
            <span className="conj-lead mono">order by</span>
            <select
              className="input mono"
              style={{ flex: 'none', width: 'auto', minWidth: 130 }}
              value={state.orderBy?.column ?? ''}
              onChange={(e) =>
                patch({ orderBy: e.target.value ? { column: e.target.value, dir: state.orderBy?.dir ?? 'desc' } : null })
              }
            >
              <option value="">— none —</option>
              {orderChoices.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            {state.orderBy && (
              <select
                className="input mono"
                style={{ flex: 'none', width: 'auto' }}
                value={state.orderBy.dir}
                onChange={(e) => patch({ orderBy: { ...state.orderBy!, dir: e.target.value as 'asc' | 'desc' } })}
              >
                <option value="desc">DESC</option>
                <option value="asc">ASC</option>
              </select>
            )}
            <span className="conj-lead mono">limit</span>
            <input
              className="input mono"
              style={{ width: 90 }}
              type="number"
              min={1}
              max={10000}
              value={state.limit}
              onChange={(e) => patch({ limit: Math.max(1, Number(e.target.value) || 100) })}
            />
          </div>

          {/* generated SQL */}
          <div className="agg-card" style={{ marginBottom: 10 }}>
            <div className="agg-card-head">
              <span className="pane-label">SQL</span>
              <button
                className="btn ghost"
                title="Edit this SQL by hand — hands off to Raw SQL, which the cluster executes"
                onClick={() => {
                  setRawSql(sqlText)
                  setRawMode(true)
                }}
              >
                <Pencil size={12} /> Edit
              </button>
            </div>
            <CodeEditor value={sqlText} readOnly language="sql" height={Math.min(180, 40 + sqlText.split('\n').length * 18)} />
          </div>

          {showDsl && compiledDsl && (
            <div className="agg-card" style={{ marginBottom: 10 }}>
              <span className="pane-label">
                Compiled _search request{state.join.enabled ? ' (left side — the join adds batched terms queries on the right index)' : ''}
              </span>
              <div style={{ height: 200, display: 'flex' }}>
                <JsonView value={compiledDsl} height="100%" />
              </div>
            </div>
          )}
        </>
      )}
      </div>

      {error && <div className="res-error" style={{ marginBottom: 10 }}>{error}</div>}

      {result && (
        <>
          <div className="result-meta" style={{ marginBottom: 8 }}>
            <span className="chip">
              {result.rows.length.toLocaleString()} rows · {result.tookMs} ms
            </span>
            {result.truncated && (
              <span className="chip" style={{ color: 'var(--warn)', borderColor: 'var(--warn)' }}>
                ⚠ {result.truncated}
              </span>
            )}
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
              <JsonView
                value={result.rows.map((r) =>
                  Object.fromEntries(result.columns.map((c, i) => [c, r[i]]))
                )}
                height="100%"
              />
            </div>
          ) : (
            <div className="shard-grid-wrap" style={{ marginBottom: 14 }}>
              <table className="data-table" style={{ border: 'none' }}>
                <thead>
                  <tr>
                    {result.columns.map((c) => (
                      <th key={c}>{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((r, i) => (
                    <tr key={i}>
                      {r.map((v, vi) => (
                        <td key={vi} className="mono">
                          {v === null || v === undefined ? '—' : String(v)}
                        </td>
                      ))}
                    </tr>
                  ))}
                  {result.rows.length === 0 && (
                    <tr>
                      <td colSpan={Math.max(1, result.columns.length)} className="sg-empty">
                        No rows returned.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {!result && !error && (
        <p className="cat-empty" style={{ marginTop: 12 }}>
          Build a query with the selectors (SELECT / WHERE / JOIN / GROUP BY), or switch to Raw SQL.
          Structured queries — including joins — execute as bounded native searches.
        </p>
      )}
    </div>
  )
}
