import { useState } from 'react'
import { ChevronDown, ChevronRight, Search } from 'lucide-react'
import { ExplainTree } from './ExplainTree'
import { useApp } from '../store'
import { esJson } from '../lib/api'
import type { ClusterConnection } from '@shared/types'

/* ------------------------------------------------------------------ *
 * Types — mirrors the relevant subset of the ES _search response
 * ------------------------------------------------------------------ */

interface SearchHit {
  _index?: string
  _id?: string
  _score?: number
  _source?: Record<string, unknown>
  highlight?: Record<string, string[]>
}

interface SearchBody {
  hits?: {
    total?: { value?: number; relation?: string }
    hits?: SearchHit[]
  }
  took?: number
  timed_out?: boolean
  profile?: unknown
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function scoreColor(score: number | undefined): string {
  if (score === undefined || score === 0) return 'var(--ink-3)'
  if (score < 0.5) return 'var(--warn)'
  if (score < 1) return 'var(--accent)'
  return 'var(--ok)'
}

function sourcePreview(source: Record<string, unknown> | undefined, maxKeys = 5): string {
  if (!source) return ''
  const entries = Object.entries(source).slice(0, maxKeys)
  return entries
    .map(([k, v]) => {
      const val = typeof v === 'string' ? (v.length > 60 ? v.slice(0, 57) + '…' : v) : JSON.stringify(v)
      return `${k}: ${val}`
    })
    .join('  ·  ')
}

/* ------------------------------------------------------------------ *
 * Single hit row with expandable source + explain
 * ------------------------------------------------------------------ */

function HitRow({
  hit,
  rank,
  conn,
  indexName,
  queryBody
}: {
  hit: SearchHit
  rank: number
  conn: ClusterConnection
  indexName: string | null
  queryBody: string
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [explaining, setExplaining] = useState(false)
  const [explainBody, setExplainBody] = useState<unknown>(null)
  const [explainError, setExplainError] = useState<string | null>(null)
  const pushToast = useApp((s) => s.pushToast)

  const explain = async (): Promise<void> => {
    if (explainBody) {
      setExpanded(!expanded)
      return
    }
    setExplaining(true)
    setExplainError(null)
    try {
      const path = indexName
        ? `/${indexName}/_explain/${encodeURIComponent(hit._id ?? '')}`
        : `/_explain/${encodeURIComponent(hit._id ?? '')}`
      const query = (() => {
        try {
          const parsed = JSON.parse(queryBody) as { query?: unknown }
          return parsed.query ?? { match_all: {} }
        } catch {
          return { match_all: {} }
        }
      })()
      const result = await esJson<{ matched?: boolean; explanation?: unknown }>(conn.id, {
        method: 'GET',
        path,
        body: query
      })
      setExplainBody({ explained: [{ _id: hit._id, _score: hit._score, matched: result.matched, explanation: result.explanation }] })
      setExpanded(true)
    } catch (err) {
      setExplainError(err instanceof Error ? err.message : 'Explain request failed')
      pushToast('err', 'Explain request failed')
    } finally {
      setExplaining(false)
    }
  }

  return (
    <div className="hit-row">
      <div className="hit-header" onClick={() => setExpanded(!expanded)}>
        <span className="hit-chevron">
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </span>
        <span className="hit-rank mono">#{rank}</span>
        <span className="hit-score mono" style={{ color: scoreColor(hit._score) }}>
          {hit._score !== undefined ? hit._score.toFixed(4) : '—'}
        </span>
        <span className="hit-id mono">{hit._id ?? ''}</span>
        <span className="hit-source-preview">{sourcePreview(hit._source)}</span>
        <button
          className="btn small explain-btn"
          disabled={explaining}
          onClick={(e) => {
            e.stopPropagation()
            void explain()
          }}
          title="Run _explain for this document"
        >
          <Search size={11} /> {explaining ? '…' : 'Explain'}
        </button>
      </div>
      {expanded && (
        <div className="hit-detail">
          {explainError ? (
            <div className="res-error">{explainError}</div>
          ) : explainBody ? (
            <ExplainTree body={explainBody} />
          ) : (
            <pre className="hit-source-json mono">
              {JSON.stringify(hit._source, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Main component — renders the hits list
 * ------------------------------------------------------------------ */

export function SearchResults({
  body,
  conn,
  indexName,
  queryBody
}: {
  body: unknown
  conn: ClusterConnection
  indexName: string | null
  queryBody: string
}): React.JSX.Element {
  const parsed = body as SearchBody
  const hits = parsed?.hits?.hits ?? []
  const total = parsed?.hits?.total

  if (hits.length === 0) {
    return (
      <div className="res-empty">
        No hits returned.
      </div>
    )
  }

  return (
    <div className="search-results">
      {total && (
        <div className="results-summary">
          <span className="mono">
            {total.value ?? hits.length} {total.relation === 'gte' ? '+' : ''} hits
          </span>
          {parsed.took !== undefined && (
            <span className="mono">·  {parsed.took} ms</span>
          )}
          {parsed.timed_out && (
            <span className="results-timed-out">timed out</span>
          )}
        </div>
      )}
      {hits.map((hit, i) => (
        <HitRow
          key={hit._id ?? i}
          hit={hit}
          rank={i + 1}
          conn={conn}
          indexName={indexName}
          queryBody={queryBody}
        />
      ))}
    </div>
  )
}
