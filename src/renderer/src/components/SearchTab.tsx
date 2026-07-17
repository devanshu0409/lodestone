import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  Maximize2,
  Play,
  Star,
  Trash2
} from 'lucide-react'
import * as Dialog from '@radix-ui/react-dialog'
import type { ClusterConnection } from '@shared/types'
import { useApp } from '../store'
import {
  fetchCatAliases,
  fetchCatIndices,
  fetchFields,
  runSearch,
  updateDocument,
  type MappedField,
  type SearchHit,
  type SearchResult
} from '../lib/api'
import { formatCompact } from '../lib/format'
import { buildQuery, coerce, newRow, type FilterRow } from '../lib/filterQuery'
import { deleteSaved, listSaved, saveSearch, type SavedSearch } from '../lib/savedSearches'
import { CodeEditor } from './CodeEditor'
import { FilterRows } from './FilterRows'
import { JsonView } from './JsonView'
import { Menu, MenuItem, MenuSep } from './ui'
import { DocDrawer } from './DocDrawer'

/* ---------- inline editing ---------- */

const EDITABLE_TYPES = new Set([
  'text',
  'keyword',
  'long',
  'integer',
  'short',
  'byte',
  'double',
  'float',
  'half_float',
  'scaled_float',
  'unsigned_long',
  'boolean',
  'date',
  'date_nanos',
  'ip'
])

const docKeyOf = (hit: SearchHit): string => `${hit._index}\u0000${hit._id}`

/** A cell is inline-editable only for scalar fields — objects/arrays go through the drawer. */
function isEditableCell(field: string, value: unknown, fields: Map<string, MappedField>): boolean {
  const t = fields.get(field)?.type
  if (t) return EDITABLE_TYPES.has(t)
  return value === null || ['string', 'number', 'boolean'].includes(typeof value)
}

function toEditString(value: unknown): string {
  if (value === null || value === undefined) return ''
  return typeof value === 'object' ? JSON.stringify(value) : String(value)
}

/* ---------- component ---------- */

const PAGE_SIZES = [25, 50, 100]

export function SearchTab({
  conn,
  initialIndex,
  onIndexChange
}: {
  conn: ClusterConnection
  initialIndex?: string
  /** Reports the selected index so a hosting workspace can label the tab. */
  onIndexChange?: (index: string) => void
}): React.JSX.Element {
  const pushToast = useApp((s) => s.pushToast)
  const [targets, setTargets] = useState<{ label: string; kind: 'index' | 'alias' }[]>([])
  const [index, setIndex] = useState(initialIndex ?? '')
  const [fields, setFields] = useState<MappedField[]>([])
  const [rows, setRows] = useState<FilterRow[]>([newRow()])
  const [rawMode, setRawMode] = useState(false)
  const [rawJson, setRawJson] = useState('')
  const [sort, setSort] = useState<{ field: string; dir: 'asc' | 'desc' } | null>(null)
  const [page, setPage] = useState(0)
  const [size, setSize] = useState(25)
  const [result, setResult] = useState<SearchResult | null>(null)
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [openDoc, setOpenDoc] = useState<SearchHit | null>(null)
  const [viewMode, setViewMode] = useState<'table' | 'json'>('table')
  // Pending inline edits: docKey -> field -> new string value (only differing ones).
  const [edits, setEdits] = useState<Record<string, Record<string, string>>>({})
  const [editingCell, setEditingCell] = useState<{ key: string; field: string } | null>(null)
  const [savingEdits, setSavingEdits] = useState(false)
  const [saved, setSaved] = useState<SavedSearch[]>([])
  const [saveName, setSaveName] = useState<string | null>(null)

  const fieldMap = useMemo(() => new Map(fields.map((f) => [f.path, f])), [fields])
  const restoringRef = useRef(false)

  // Report the current index up to a hosting workspace (for tab labels).
  const onIndexChangeRef = useRef(onIndexChange)
  onIndexChangeRef.current = onIndexChange
  useEffect(() => {
    if (index) onIndexChangeRef.current?.(index)
  }, [index])

  const editCount = useMemo(
    () => Object.values(edits).reduce((n, fieldMapObj) => n + Object.keys(fieldMapObj).length, 0),
    [edits]
  )

  const clearEdits = useCallback(() => {
    setEdits({})
    setEditingCell(null)
  }, [])

  // A fresh result set invalidates any pending edits (row identities changed).
  useEffect(() => {
    clearEdits()
  }, [result, clearEdits])

  /** Record (or revert) an edit, dropping it from the buffer when it equals the original. */
  const commitEdit = (hit: SearchHit, field: string, next: string): void => {
    const key = docKeyOf(hit)
    const original = toEditString(hit._source[field])
    setEdits((prev) => {
      const forDoc = { ...(prev[key] ?? {}) }
      if (next === original) delete forDoc[field]
      else forDoc[field] = next
      const copy = { ...prev }
      if (Object.keys(forDoc).length === 0) delete copy[key]
      else copy[key] = forDoc
      return copy
    })
  }

  const saveEdits = async (): Promise<void> => {
    if (!result) return
    setSavingEdits(true)
    try {
      await Promise.all(
        Object.entries(edits).map(([key, fieldVals]) => {
          const sep = key.indexOf(' ')
          const idx = key.slice(0, sep)
          const docId = key.slice(sep + 1)
          const partial: Record<string, unknown> = {}
          for (const [field, str] of Object.entries(fieldVals)) {
            partial[field] = coerce(str, fieldMap.get(field)?.type)
          }
          return updateDocument(conn.id, idx, docId, partial)
        })
      )
      // Reflect the saved values locally without a full re-search.
      setResult((prev) =>
        prev
          ? {
              ...prev,
              hits: prev.hits.map((h) => {
                const fieldVals = edits[docKeyOf(h)]
                if (!fieldVals) return h
                const source = { ...h._source }
                for (const [field, str] of Object.entries(fieldVals)) {
                  source[field] = coerce(str, fieldMap.get(field)?.type)
                }
                return { ...h, _source: source }
              })
            }
          : prev
      )
      const n = editCount
      clearEdits()
      pushToast('ok', `Saved ${n} change${n === 1 ? '' : 's'}`)
    } catch (err) {
      pushToast('err', `Save failed: ${(err as Error).message}`)
    } finally {
      setSavingEdits(false)
    }
  }

  useEffect(() => setSaved(listSaved(conn.id)), [conn.id])

  const applySaved = (s: SavedSearch): void => {
    // Changing the index fires an effect that resets sort — which would wipe the
    // sort restored here. Flag the restore so that effect leaves it alone once.
    // Only arm it when the index actually changes, or the effect never runs to
    // clear the flag and it would swallow the next legitimate sort reset.
    restoringRef.current = s.index !== index
    setRawMode(s.rawMode)
    setRawJson(s.rawJson)
    setRows(s.rows.length ? s.rows : [newRow()])
    setSort(s.sort)
    setSize(s.size)
    setIndex(s.index)
  }

  const commitSave = (): void => {
    const name = (saveName ?? '').trim()
    if (!name) return
    setSaved(saveSearch(conn.id, { name, index, rawMode, rawJson, rows, sort, size, savedAt: Date.now() }))
    setSaveName(null)
    pushToast('ok', `Saved “${name}”`)
  }

  // Load index + alias targets for the picker.
  useEffect(() => {
    Promise.all([fetchCatIndices(conn.id), fetchCatAliases(conn.id)])
      .then(([indices, aliases]) => {
        const t: { label: string; kind: 'index' | 'alias' }[] = [
          ...aliases.map((a) => ({ label: a.alias, kind: 'alias' as const })),
          ...indices.filter((i) => !i.index.startsWith('.')).map((i) => ({ label: i.index, kind: 'index' as const }))
        ]
        setTargets(t)
        setIndex((cur) => cur || t[0]?.label || '')
      })
      .catch((err: Error) => setError(err.message))
  }, [conn.id])

  // Load the field list whenever the target changes.
  useEffect(() => {
    if (!index) return
    fetchFields(conn.id, index)
      .then(setFields)
      .catch(() => setFields([]))
    // A saved search restores its own sort — don't clobber it on the index change
    // that restoring it caused.
    if (restoringRef.current) restoringRef.current = false
    else setSort(null)
    setPage(0)
    setResult(null)
  }, [conn.id, index])

  const currentBody = useCallback(
    (forPage: number): unknown => {
      if (rawMode) {
        try {
          const parsed = JSON.parse(rawJson) as Record<string, unknown>
          return { ...parsed, from: forPage * size, size, track_total_hits: true }
        } catch {
          throw new Error('The query is not valid JSON.')
        }
      }
      return {
        query: buildQuery(rows, fieldMap),
        from: forPage * size,
        size,
        track_total_hits: true,
        ...(sort ? { sort: [{ [sort.field]: sort.dir }] } : {})
      }
    },
    [rawMode, rawJson, rows, fieldMap, size, sort]
  )

  const search = useCallback(
    async (forPage: number): Promise<void> => {
      if (!index) return
      setSearching(true)
      setError(null)
      try {
        const body = currentBody(forPage)
        const res = await runSearch(conn.id, index, body)
        setResult(res)
        setPage(forPage)
      } catch (err) {
        setError((err as Error).message)
      } finally {
        setSearching(false)
      }
    },
    [conn.id, index, currentBody]
  )

  // Auto-run the first search once a target is known.
  useEffect(() => {
    if (index) void search(0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index])

  const toggleRaw = (): void => {
    if (!rawMode) {
      setRawJson(JSON.stringify({ query: buildQuery(rows, fieldMap) }, null, 2))
    }
    setRawMode(!rawMode)
  }

  const toggleSort = (path: string): void => {
    const meta = fieldMap.get(path)
    if (!meta?.sortPath) return
    const target = meta.sortPath
    setSort((cur) =>
      cur?.field === target ? (cur.dir === 'asc' ? { field: target, dir: 'desc' } : null) : { field: target, dir: 'asc' }
    )
  }

  // Re-run when sort/size changes after an initial result exists.
  useEffect(() => {
    if (result) void search(0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sort, size])

  const columns = useMemo(() => {
    const seen: string[] = []
    for (const hit of result?.hits ?? []) {
      for (const key of Object.keys(hit._source)) {
        if (!seen.includes(key)) seen.push(key)
      }
    }
    return seen.slice(0, 8)
  }, [result])

  const totalPages = result ? Math.max(1, Math.ceil(Math.min(result.total, 10_000) / size)) : 1

  const exportAs = (format: 'json' | 'ndjson' | 'csv'): void => {
    if (!result || result.hits.length === 0) {
      pushToast('err', 'Nothing to export — run a search first.')
      return
    }
    const docs = result.hits.map((h) => ({ _id: h._id, ...h._source }))
    let text: string
    if (format === 'json') text = JSON.stringify(docs, null, 2)
    else if (format === 'ndjson') text = docs.map((d) => JSON.stringify(d)).join('\n')
    else {
      const cols = ['_id', ...columns]
      const esc = (v: unknown): string => {
        const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
      }
      text = [cols.join(','), ...docs.map((d) => cols.map((c) => esc((d as Record<string, unknown>)[c])).join(','))].join('\n')
    }
    const blob = new Blob([text], { type: 'text/plain' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${index}-page${page + 1}.${format === 'ndjson' ? 'ndjson' : format}`
    a.click()
    URL.revokeObjectURL(a.href)
    pushToast('ok', `Exported ${docs.length} documents (${format.toUpperCase()})`)
  }

  return (
    <div className="shards-view">
      <div className="search-controls">
        <div className="search-row">
          <IndexPicker targets={targets} value={index} onChange={setIndex} />
          <button className="btn ghost" onClick={toggleRaw}>
            {rawMode ? 'Filter builder' : 'Raw query'}
          </button>
          <div className="spacer" />
          <Menu
            trigger={
              <button className="btn ghost" title="Saved searches">
                <Star size={13} />
                Saved
                {saved.length > 0 && <span className="chip saved-count">{saved.length}</span>}
                <ChevronDown size={12} />
              </button>
            }
          >
            <MenuItem onSelect={() => setSaveName(index ? `${index} search` : 'search')}>
              Save current search…
            </MenuItem>
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
                      // Deleting must not also apply the search behind it.
                      e.stopPropagation()
                      setSaved(deleteSaved(conn.id, s.name))
                    }}
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter' && e.key !== ' ') return
                      e.stopPropagation()
                      e.preventDefault()
                      setSaved(deleteSaved(conn.id, s.name))
                    }}
                  >
                    <Trash2 size={12} />
                  </span>
                </span>
              </MenuItem>
            ))}
          </Menu>
          <Menu
            trigger={
              <button className="btn ghost" title="Export current page">
                <Download size={13} />
                Export
                <ChevronDown size={12} />
              </button>
            }
          >
            <MenuItem onSelect={() => exportAs('json')}>JSON</MenuItem>
            <MenuItem onSelect={() => exportAs('ndjson')}>NDJSON</MenuItem>
            <MenuItem onSelect={() => exportAs('csv')}>CSV</MenuItem>
          </Menu>
          <button className="btn primary" disabled={searching || !index} onClick={() => void search(0)}>
            <Play size={12} />
            {searching ? 'Searching…' : 'Search'}
          </button>
        </div>

        {!rawMode && (
          <FilterRows rows={rows} onChange={setRows} fields={fields} onEnter={() => void search(0)} />
        )}

        {rawMode && (
          <CodeEditor
            value={rawJson}
            onChange={setRawJson}
            height={160}
            suggestFields={fields.map((f) => f.path)}
          />
        )}

        {error && <div className="test-result fail">{error}</div>}
      </div>

      {result && (
        <>
          <div className="result-meta">
            <span className="chip">
              {formatCompact(result.total)}
              {result.totalRelation === 'gte' ? '+' : ''} hits · {result.tookMs} ms
            </span>
            <div className="view-toggle">
              <button className={viewMode === 'table' ? 'on' : ''} onClick={() => setViewMode('table')}>
                Table
              </button>
              <button className={viewMode === 'json' ? 'on' : ''} onClick={() => setViewMode('json')}>
                JSON
              </button>
            </div>
            {editCount > 0 && (
              <span className="edit-bar">
                <span className="edit-count">
                  {editCount} unsaved change{editCount === 1 ? '' : 's'}
                </span>
                <button className="btn ghost" onClick={clearEdits} disabled={savingEdits}>
                  Discard
                </button>
                <button className="btn primary" onClick={() => void saveEdits()} disabled={savingEdits}>
                  <Check size={12} />
                  {savingEdits ? 'Saving…' : 'Save changes'}
                </button>
              </span>
            )}
            <div className="spacer" />
            <select className="input mono" style={{ width: 70 }} value={size} onChange={(e) => setSize(Number(e.target.value))}>
              {PAGE_SIZES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <button className="icon-btn" disabled={page === 0 || searching} title="Previous page" onClick={() => void search(page - 1)}>
              <ChevronLeft size={14} />
            </button>
            <span className="mono" style={{ fontSize: 11, color: 'var(--ink-2)' }}>
              {page + 1} / {totalPages}
            </span>
            <button
              className="icon-btn"
              disabled={page + 1 >= totalPages || searching}
              title="Next page"
              onClick={() => void search(page + 1)}
            >
              <ChevronRight size={14} />
            </button>
          </div>

          {viewMode === 'json' ? (
            <div className="search-json">
              <JsonView value={result.hits} height="100%" />
            </div>
          ) : (
          <div className="shard-grid-wrap" style={{ marginBottom: 14 }}>
            <table className="data-table" style={{ border: 'none' }}>
              <thead>
                <tr>
                  <th>_id</th>
                  {columns.map((c) => {
                    const sortable = !!fieldMap.get(c)?.sortPath
                    const active = sort && fieldMap.get(c)?.sortPath === sort.field
                    return (
                      <th
                        key={c}
                        className={sortable ? 'sortable' : ''}
                        onClick={() => toggleSort(c)}
                        title={sortable ? 'Sort by this field' : undefined}
                      >
                        {c}
                        {active ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''}
                      </th>
                    )
                  })}
                </tr>
              </thead>
              <tbody>
                {result.hits.map((hit) => {
                  const key = docKeyOf(hit)
                  const docEdits = edits[key]
                  return (
                    <tr key={`${hit._index}/${hit._id}`}>
                      <td className="mono id-cell" style={{ whiteSpace: 'nowrap' }}>
                        <button
                          className="link-btn"
                          title="Open document"
                          onClick={() => setOpenDoc(hit)}
                        >
                          <Maximize2 size={11} />
                          {hit._id}
                        </button>
                      </td>
                      {columns.map((c) => {
                        const original = hit._source[c]
                        const editable = !conn.readOnly && isEditableCell(c, original, fieldMap)
                        const pending = docEdits?.[c]
                        const isEditing = editingCell?.key === key && editingCell.field === c
                        const shown = pending !== undefined ? pending : cellText(original)
                        if (isEditing) {
                          return (
                            <td key={c} className="cell-val mono">
                              <input
                                className="cell-input mono"
                                autoFocus
                                defaultValue={pending !== undefined ? pending : toEditString(original)}
                                onBlur={(e) => {
                                  commitEdit(hit, c, e.target.value)
                                  setEditingCell(null)
                                }}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') {
                                    commitEdit(hit, c, (e.target as HTMLInputElement).value)
                                    setEditingCell(null)
                                  } else if (e.key === 'Escape') {
                                    setEditingCell(null)
                                  }
                                }}
                              />
                            </td>
                          )
                        }
                        return (
                          <td
                            key={c}
                            className={`cell-val mono ${editable ? 'editable' : ''} ${pending !== undefined ? 'modified' : ''}`}
                            title={editable ? 'Click to edit' : undefined}
                            onClick={editable ? () => setEditingCell({ key, field: c }) : undefined}
                          >
                            {shown}
                          </td>
                        )
                      })}
                    </tr>
                  )
                })}
                {result.hits.length === 0 && (
                  <tr>
                    <td colSpan={columns.length + 1} className="sg-empty">
                      No documents match this query.
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
        <div className="state-screen">
          <div className="spinner" />
        </div>
      )}

      {openDoc && (
        <DocDrawer
          conn={conn}
          hit={openDoc}
          onClose={() => setOpenDoc(null)}
          onSaved={(source) => {
            const key = docKeyOf(openDoc)
            // Reflect the edit locally — ES is near-real-time, so re-searching
            // immediately can still return the old version.
            setResult((prev) =>
              prev
                ? {
                    ...prev,
                    hits: prev.hits.map((h) => (docKeyOf(h) === key ? { ...h, _source: source } : h))
                  }
                : prev
            )
            setOpenDoc(null)
          }}
          onDeleted={() => {
            const key = docKeyOf(openDoc)
            setResult((prev) =>
              prev
                ? {
                    ...prev,
                    hits: prev.hits.filter((h) => docKeyOf(h) !== key),
                    total: Math.max(0, prev.total - 1)
                  }
                : prev
            )
            setOpenDoc(null)
          }}
        />
      )}

      <Dialog.Root open={saveName !== null} onOpenChange={(o) => !o && setSaveName(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="dlg-overlay" />
          <Dialog.Content className="dlg-content" aria-describedby={undefined} style={{ width: 380 }}>
            <Dialog.Title className="dlg-title">Save search</Dialog.Title>
            <div className="dlg-form">
              <div className="field">
                <label>Name</label>
                <input
                  className="input"
                  autoFocus
                  value={saveName ?? ''}
                  spellCheck={false}
                  onChange={(e) => setSaveName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && commitSave()}
                />
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--ink-3)' }}>
                Saves the index, filters, sort and page size for this cluster. An existing
                search with the same name is replaced.
              </div>
              <div className="dlg-foot">
                <div className="spacer" />
                <button className="btn ghost" onClick={() => setSaveName(null)}>
                  Cancel
                </button>
                <button className="btn primary" disabled={!(saveName ?? '').trim()} onClick={commitSave}>
                  Save
                </button>
              </div>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  )
}

/* ---------- searchable index / alias picker (shared with AggTab) ---------- */

export function IndexPicker({
  targets,
  value,
  onChange
}: {
  targets: { label: string; kind: 'index' | 'alias' }[]
  value: string
  onChange: (v: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onDoc = (e: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  const needle = filter.trim().toLowerCase()
  const filtered = needle
    ? targets.filter((t) => t.label.toLowerCase().includes(needle))
    : targets

  return (
    <div className="idx-picker" ref={wrapRef}>
      <button
        className="input mono idx-trigger"
        onClick={() => {
          setOpen((o) => !o)
          setFilter('')
        }}
      >
        <span className="idx-current">{value || 'Select index…'}</span>
        <ChevronDown size={12} />
      </button>
      {open && (
        <div className="idx-panel">
          <input
            className="input mono"
            autoFocus
            placeholder="Filter indices & aliases…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <div className="idx-list">
            {filtered.map((t) => (
              <button
                key={`${t.kind}:${t.label}`}
                className={`idx-opt ${t.label === value ? 'sel' : ''}`}
                onClick={() => {
                  onChange(t.label)
                  setOpen(false)
                  setFilter('')
                }}
              >
                <span className="idx-opt-label">{t.label}</span>
                {t.kind === 'alias' && <span className="idx-tag">alias</span>}
              </button>
            ))}
            {filtered.length === 0 && <div className="idx-empty">No match</div>}
          </div>
        </div>
      )}
    </div>
  )
}

function cellText(v: unknown): string {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'object') {
    const s = JSON.stringify(v)
    return s.length > 80 ? `${s.slice(0, 77)}…` : s
  }
  const s = String(v)
  return s.length > 120 ? `${s.slice(0, 117)}…` : s
}
