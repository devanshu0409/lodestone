import { useEffect, useMemo, useRef, useState } from 'react'
import { BookOpen, Clock, Copy, ExternalLink, Play, Save, Star, Trash2 } from 'lucide-react'
import type { ClusterConnection, ClusterOverview, EsResponse, HttpMethod } from '@shared/types'
import { useApp } from '../store'
import { ApiError, esRequest, fetchCatIndices, fetchFields } from '../lib/api'
import { API_CATALOG, docUrl, searchCatalog, type ApiEntry } from '../lib/apiCatalog'
import {
  clearHistory,
  deleteSaved,
  loadHistory,
  loadSaved,
  pushHistory,
  saveRequest,
  type HistoryEntry,
  type SavedRequest
} from '../lib/consoleStore'
import {
  requestToJavaRestClient,
  requestToSpringDataSearch,
  requestToJavaApiClient
} from '../lib/codegen'
import { CodeEditor } from './CodeEditor'
import { JsonView } from './JsonView'
import { ProfileTree } from './ProfileTree'
import { SearchResults } from './SearchResults'
import { ExplainTree } from './ExplainTree'
import { TabStrip } from './TabStrip'
import { Menu, MenuItem, PromptDialog } from './ui'

const METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'DELETE', 'HEAD']

type Panel = 'catalog' | 'history' | 'saved'

interface RunResult {
  response?: EsResponse
  error?: string
}

/** One console request tab — its own method/path/body/response run independently. */
interface ReqTab {
  id: string
  method: HttpMethod
  path: string
  body: string
  result: RunResult | null
  running: boolean
}

const makeReqTab = (init?: Partial<ReqTab>): ReqTab => ({
  id: crypto.randomUUID(),
  method: 'GET',
  path: '/_search',
  body: '',
  result: null,
  running: false,
  ...init
})

const shortPath = (p: string): string => {
  const s = p.trim() || '/'
  return s.length > 28 ? `${s.slice(0, 27)}…` : s
}

export function Console({
  conn,
  overview
}: {
  conn: ClusterConnection
  overview: ClusterOverview
}): React.JSX.Element {
  const pushToast = useApp((s) => s.pushToast)
  const distribution = overview.info.distribution

  const [splitPct, setSplitPct] = useState(50)
  const splitRef = useRef<HTMLDivElement>(null)
  const draggingRef = useRef(false)

  const onDividerMouseDown = (e: React.MouseEvent): void => {
    e.preventDefault()
    draggingRef.current = true
    const onMove = (ev: MouseEvent): void => {
      if (!draggingRef.current || !splitRef.current) return
      const rect = splitRef.current.getBoundingClientRect()
      const pct = ((ev.clientY - rect.top) / rect.height) * 100
      setSplitPct(Math.min(90, Math.max(10, pct)))
    }
    const onUp = (): void => {
      draggingRef.current = false
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'
  }

  const [panel, setPanel] = useState<Panel>('catalog')
  const [catalogQuery, setCatalogQuery] = useState('')
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [saved, setSaved] = useState<SavedRequest[]>([])
  const [indexNames, setIndexNames] = useState<string[]>([])
  const [bodyFields, setBodyFields] = useState<string[]>([])

  const [tabs, setTabs] = useState<ReqTab[]>(() => [makeReqTab()])
  const [activeId, setActiveId] = useState<string>(() => tabs[0].id)
  const active = tabs.find((t) => t.id === activeId) ?? tabs[0]

  const patchTab = (id: string, patch: Partial<ReqTab>): void =>
    setTabs((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t)))
  const patchActive = (patch: Partial<ReqTab>): void => patchTab(active.id, patch)

  const addTab = (init?: Partial<ReqTab>): void => {
    const t = makeReqTab(init)
    setTabs((ts) => [...ts, t])
    setActiveId(t.id)
  }
  const closeTab = (id: string): void => {
    if (tabs.length === 1) return
    const idx = tabs.findIndex((t) => t.id === id)
    const remaining = tabs.filter((t) => t.id !== id)
    setTabs(remaining)
    if (id === activeId) setActiveId(remaining[Math.max(0, idx - 1)].id)
  }

  useEffect(() => {
    setHistory(loadHistory(conn.id))
    setSaved(loadSaved(conn.id))
    fetchCatIndices(conn.id)
      .then((list) => setIndexNames(list.map((i) => i.index)))
      .catch(() => setIndexNames([]))
  }, [conn.id])

  // Field autocomplete follows the index named in the active tab's path.
  const pathIndex = useMemo(() => indexFromPath(active.path), [active.path])
  useEffect(() => {
    if (!pathIndex) {
      setBodyFields([])
      return
    }
    let alive = true
    fetchFields(conn.id, pathIndex)
      .then((fs) => alive && setBodyFields(fs.map((f) => f.path)))
      .catch(() => alive && setBodyFields([]))
    return () => {
      alive = false
    }
  }, [conn.id, pathIndex])

  const catalogResults = useMemo(
    () => searchCatalog(catalogQuery, distribution),
    [catalogQuery, distribution]
  )

  const loadEntry = (entry: ApiEntry): void => {
    patchActive({ method: entry.method, path: entry.path, body: entry.body ?? '', result: null })
  }

  const run = async (): Promise<void> => {
    const tab = active
    const trimmedPath = tab.path.trim()
    if (!trimmedPath) return
    patchTab(tab.id, { running: true, result: null })
    const sendBody = tab.method !== 'HEAD' && tab.body.trim().length > 0
    let parsedBody: unknown
    if (sendBody) {
      if (trimmedPath.includes('_bulk')) {
        parsedBody = tab.body // NDJSON — transport sends the raw string as-is
      } else {
        try {
          parsedBody = JSON.parse(tab.body)
        } catch {
          patchTab(tab.id, { running: false, result: { error: 'Request body is not valid JSON.' } })
          return
        }
      }
    }
    try {
      const response = await esRequest(conn.id, {
        method: tab.method,
        path: trimmedPath.startsWith('/') ? trimmedPath : `/${trimmedPath}`,
        body: sendBody ? parsedBody : undefined
      })
      patchTab(tab.id, { running: false, result: { response } })
      setHistory(
        pushHistory(conn.id, {
          method: tab.method,
          path: trimmedPath,
          body: tab.body,
          status: response.status
        })
      )
    } catch (err) {
      patchTab(tab.id, {
        running: false,
        result: { error: err instanceof ApiError ? err.message : (err as Error).message }
      })
    }
  }

  const copyCurl = (): void => {
    const base = active.result?.response?.nodeUrl ?? conn.seeds[0] ?? 'http://localhost:9200'
    const p = active.path.startsWith('/') ? active.path : `/${active.path}`
    const parts = [`curl -X${active.method} '${base}${p}'`]
    if (conn.tls.insecure) parts.push('-k')
    if (conn.auth.type === 'basic') parts.push(`-u ${conn.auth.username ?? ''}:$ES_PASSWORD`)
    if (active.method !== 'HEAD' && active.body.trim()) {
      parts.push(`-H 'Content-Type: application/json'`)
      parts.push(`-d '${active.body.replace(/'/g, `'\\''`)}'`)
    }
    navigator.clipboard.writeText(parts.join(' \\\n  '))
    pushToast('ok', 'Copied as cURL')
  }

  const copyText = (text: string, what: string): void => {
    navigator.clipboard.writeText(text)
    pushToast('ok', `Copied as ${what}`)
  }

  const copyJava = (): void =>
    copyText(requestToJavaRestClient(active.method, active.path, active.body), 'Java (RestClient)')

  const copySpring = (): void => {
    const snippet = requestToSpringDataSearch(active.path, active.body)
    if (snippet) copyText(snippet, 'Java (Spring Data)')
    else pushToast('err', 'Spring Data snippet is only available for _search requests.')
  }

  const copyJavaApi = (): void => {
    const snippet = requestToJavaApiClient(active.path, active.body)
    if (snippet) copyText(snippet, 'Java (API Client)')
    else pushToast('err', 'Java API Client snippet is only available for _search requests.')
  }

  const isSearch = /_search/.test(active.path)

  type ViewMode = 'json' | 'profile' | 'hits' | 'explain'
  const [viewMode, setViewMode] = useState<ViewMode>('json')

  // Auto-switch view mode based on response content
  const resBody = active.result?.response?.body as Record<string, unknown> | undefined
  const hasProfile = !!(resBody && typeof resBody === 'object' && 'profile' in resBody)
  const hasHits = !!(resBody && typeof resBody === 'object' && 'hits' in resBody && Array.isArray((resBody as { hits?: { hits?: unknown[] } }).hits?.hits))
  const hasExplained = !!(resBody && typeof resBody === 'object' && 'explained' in resBody)

  const availableModes: ViewMode[] = ['json']
  if (hasProfile) availableModes.push('profile')
  if (hasHits) availableModes.push('hits')
  if (hasExplained) availableModes.push('explain')

  // Reset to json if current mode isn't available
  useEffect(() => {
    if (!availableModes.includes(viewMode)) setViewMode('json')
  }, [availableModes.join(','), viewMode])

  const activeIndex = indexFromPath(active.path)

  const [saveOpen, setSaveOpen] = useState(false)
  const commitSave = (name: string): void => {
    setSaved(saveRequest(conn.id, name, { method: active.method, path: active.path, body: active.body }))
    pushToast('ok', `Saved "${name}"`)
    setPanel('saved')
  }

  return (
    <div className="console">
      <aside className="console-catalog">
        <div className="cat-switch">
          <button className={panel === 'catalog' ? 'on' : ''} onClick={() => setPanel('catalog')} title="API catalog">
            <BookOpen size={13} /> Catalog
          </button>
          <button className={panel === 'history' ? 'on' : ''} onClick={() => setPanel('history')} title="History">
            <Clock size={13} /> History
          </button>
          <button className={panel === 'saved' ? 'on' : ''} onClick={() => setPanel('saved')} title="Saved">
            <Star size={13} /> Saved
          </button>
        </div>

        {panel === 'catalog' && (
          <>
            <input
              className="input"
              placeholder="Search by intent — “update by query”…"
              value={catalogQuery}
              onChange={(e) => setCatalogQuery(e.target.value)}
              autoFocus
            />
            <div className="cat-list">
              {catalogResults.map((entry) => {
                const href = docUrl(entry, distribution)
                return (
                  <div key={entry.id} className="cat-card">
                    <button className="cat-card-open" onClick={() => loadEntry(entry)}>
                      <span className="cat-card-top">
                        <span className={`verb ${entry.method}`}>{entry.method}</span>
                        <span className="cat-card-name">{entry.name}</span>
                      </span>
                      <span className="cat-card-path mono">{entry.path}</span>
                      <span className="cat-card-summary">{entry.summary}</span>
                    </button>
                    {href && (
                      <a
                        className="cat-doc-link"
                        href={href}
                        target="_blank"
                        rel="noreferrer"
                        title="Open official documentation"
                      >
                        <ExternalLink size={12} />
                      </a>
                    )}
                  </div>
                )
              })}
              {catalogResults.length === 0 && (
                <p className="cat-empty">No API matches “{catalogQuery}”.</p>
              )}
            </div>
          </>
        )}

        {panel === 'history' && (
          <div className="cat-list">
            {history.length > 0 && (
              <button
                className="btn ghost"
                style={{ alignSelf: 'flex-start', margin: '0 0 4px' }}
                onClick={() => {
                  clearHistory(conn.id)
                  setHistory([])
                }}
              >
                Clear history
              </button>
            )}
            {history.map((h) => (
              <button
                key={h.id}
                className="cat-card"
                onClick={() => patchActive({ method: h.method, path: h.path, body: h.body })}
              >
                <span className="cat-card-top">
                  <span className={`verb ${h.method}`}>{h.method}</span>
                  <span className="cat-card-path mono" style={{ flex: 1 }}>
                    {h.path}
                  </span>
                  {h.status !== undefined && (
                    <span className={`status-dot ${h.status < 400 ? 'ok' : 'err'}`}>{h.status}</span>
                  )}
                </span>
              </button>
            ))}
            {history.length === 0 && <p className="cat-empty">No requests yet.</p>}
          </div>
        )}

        {panel === 'saved' && (
          <div className="cat-list">
            {saved.map((s) => (
              <div key={s.id} className="cat-card saved-card">
                <button
                  className="saved-open"
                  onClick={() => patchActive({ method: s.method, path: s.path, body: s.body })}
                >
                  <span className="cat-card-top">
                    <span className={`verb ${s.method}`}>{s.method}</span>
                    <span className="cat-card-name">{s.name}</span>
                  </span>
                  <span className="cat-card-path mono">{s.path}</span>
                </button>
                <button
                  className="icon-btn"
                  title="Delete saved request"
                  onClick={() => setSaved(deleteSaved(conn.id, s.id))}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
            {saved.length === 0 && <p className="cat-empty">No saved requests yet.</p>}
          </div>
        )}
      </aside>

      <section className="console-main">
        <TabStrip
          tabs={tabs.map((t) => ({
            id: t.id,
            label: shortPath(t.path),
            lead: t.method,
            leadClass: `verb ${t.method}`
          }))}
          activeId={active.id}
          onSelect={setActiveId}
          onAdd={() => addTab()}
          onClone={() => addTab({ method: active.method, path: active.path, body: active.body })}
          onClose={closeTab}
          addTitle="New request"
        />

        <div className="req-bar">
          <select
            className={`input mono verb-select ${active.method}`}
            value={active.method}
            onChange={(e) => patchActive({ method: e.target.value as HttpMethod })}
          >
            {METHODS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <PathInput
            value={active.path}
            onChange={(v) => patchActive({ path: v })}
            indexNames={indexNames}
            onEnter={() => void run()}
          />
          <Menu
            trigger={
              <button className="btn" title="Copy as…">
                <Copy size={13} />
              </button>
            }
          >
            <MenuItem onSelect={copyCurl}>Copy as cURL</MenuItem>
            <MenuItem onSelect={copyJava}>Copy as Java — RestClient</MenuItem>
            {isSearch && <MenuItem onSelect={copySpring}>Copy as Java — Spring Data</MenuItem>}
            {isSearch && <MenuItem onSelect={copyJavaApi}>Copy as Java — API Client</MenuItem>}
          </Menu>
          <button className="btn" title="Save request" onClick={() => setSaveOpen(true)}>
            <Save size={13} />
          </button>
          <button className="btn primary" disabled={active.running} onClick={() => void run()}>
            <Play size={12} />
            {active.running ? 'Running…' : 'Run'}
          </button>
        </div>

        <div className="console-split" ref={splitRef}>
          <div className="req-body" style={{ flexBasis: `${splitPct}%` }}>
            <div className="pane-label">
              Request body
              {pathIndex && bodyFields.length > 0 && (
                <span className="res-meta" style={{ color: 'var(--ink-3)' }}>
                  <span className="mono">⌃Space · {bodyFields.length} fields from {pathIndex}</span>
                </span>
              )}
            </div>
            <CodeEditor
              value={active.body}
              onChange={(v) => patchActive({ body: v })}
              height="100%"
              suggestFields={bodyFields}
            />
          </div>
          <div className="console-divider" onMouseDown={onDividerMouseDown} />
          <div className="res-pane" style={{ flexBasis: `${100 - splitPct}%` }}>
            <div className="pane-label">
              Response
              {active.result?.response && (
                <span className="res-meta">
                  <span className={`status-dot ${active.result.response.ok ? 'ok' : 'err'}`}>
                    {active.result.response.status}
                  </span>
                  <span className="mono">{active.result.response.tookMs} ms</span>
                  <span className="mono res-node" title="Served by">
                    {hostOnly(active.result.response.nodeUrl)}
                  </span>
                </span>
              )}
            </div>
            {active.result?.error ? (
              <div className="res-error">{active.result.error}</div>
            ) : active.result?.response ? (
              <>
                {availableModes.length > 1 && (
                  <div className="view-mode-bar">
                    {availableModes.map((mode) => (
                      <button
                        key={mode}
                        className={`view-mode-btn ${viewMode === mode ? 'on' : ''}`}
                        onClick={() => setViewMode(mode)}
                      >
                        {mode === 'json' ? 'JSON' :
                         mode === 'profile' ? 'Profile' :
                         mode === 'hits' ? 'Hits' : 'Explain'}
                      </button>
                    ))}
                  </div>
                )}
                {viewMode === 'json' && <JsonView value={active.result.response.body} />}
                {viewMode === 'profile' && <ProfileTree body={active.result.response.body} />}
                {viewMode === 'hits' && (
                  <SearchResults
                    body={active.result.response.body}
                    conn={conn}
                    indexName={activeIndex}
                    queryBody={active.body}
                  />
                )}
                {viewMode === 'explain' && <ExplainTree body={active.result.response.body} />}
              </>
            ) : (
              <div className="res-empty">
                Pick an API from the catalog or type a request, then Run.
              </div>
            )}
          </div>
        </div>
      </section>

      <PromptDialog
        open={saveOpen}
        title="Save request"
        label="Name"
        placeholder="e.g. Top errors last hour"
        initialValue={`${active.method} ${active.path}`}
        hint="Stored for this cluster. Find it under the Saved panel."
        onSubmit={commitSave}
        onClose={() => setSaveOpen(false)}
      />
    </div>
  )
}

/* ---------- path input with autocomplete ---------- */

function PathInput({
  value,
  onChange,
  indexNames,
  onEnter
}: {
  value: string
  onChange: (v: string) => void
  indexNames: string[]
  onEnter: () => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const wrapRef = useRef<HTMLDivElement>(null)

  const suggestions = useMemo(() => buildSuggestions(value, indexNames), [value, indexNames])

  useEffect(() => {
    const onDocClick = (e: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [])

  useEffect(() => setActive(0), [value])

  const choose = (s: string): void => {
    onChange(s)
    setOpen(false)
  }

  return (
    <div className="path-wrap" ref={wrapRef}>
      <input
        className="input mono path-input"
        value={value}
        spellCheck={false}
        placeholder="/index/_search"
        onChange={(e) => {
          onChange(e.target.value)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (!open || suggestions.length === 0) {
            if (e.key === 'Enter') onEnter()
            return
          }
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setActive((a) => (a + 1) % suggestions.length)
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setActive((a) => (a - 1 + suggestions.length) % suggestions.length)
          } else if (e.key === 'Enter') {
            e.preventDefault()
            choose(suggestions[active])
          } else if (e.key === 'Escape') {
            setOpen(false)
          }
        }}
      />
      {open && suggestions.length > 0 && (
        <div className="path-suggest">
          {suggestions.map((s, i) => (
            <button
              key={s}
              className={`path-opt mono ${i === active ? 'active' : ''}`}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => {
                e.preventDefault()
                choose(s)
              }}
            >
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** Suggest catalog path templates and, where an index segment is being typed, live index names. */
function buildSuggestions(value: string, indexNames: string[]): string[] {
  const v = value.trim()
  const out = new Set<string>()

  const lower = v.toLowerCase()
  for (const entry of API_CATALOG) {
    if (v === '' || entry.path.toLowerCase().includes(lower)) out.add(entry.path)
    if (out.size >= 8) break
  }

  if (v.startsWith('/') && !v.slice(1).includes('/')) {
    const frag = v.slice(1).toLowerCase()
    for (const name of indexNames) {
      if (name.toLowerCase().includes(frag)) {
        out.add(`/${name}/_search`)
        out.add(`/${name}/_mapping`)
      }
      if (out.size >= 12) break
    }
  }

  return [...out].slice(0, 10)
}

/** The index named at the start of a console path, or null for cluster-level paths. */
function indexFromPath(path: string): string | null {
  const p = path.trim().replace(/^\//, '')
  if (!p) return null
  const first = p.split(/[/?]/)[0]
  if (!first || first.startsWith('_') || first.includes('{') || first.includes('*')) return null
  return first.split(',')[0]
}

function hostOnly(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}
