import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'

/* ------------------------------------------------------------------ *
 * Types — mirrors the ES _explain response structure
 * ------------------------------------------------------------------ */

interface ExplainDetail {
  value?: number
  description?: string
  details?: ExplainDetail[]
}

interface ExplainHit {
  _index?: string
  _id?: string
  _score?: number
  matched?: boolean
  explanation?: ExplainDetail
}

interface ExplainBody {
  explained?: ExplainHit[]
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function scoreColor(value: number | undefined): string {
  if (value === undefined) return 'var(--ink-3)'
  if (value === 0) return 'var(--ink-3)'
  if (value < 0.5) return 'var(--warn)'
  if (value < 1) return 'var(--accent)'
  return 'var(--ok)'
}

/* ------------------------------------------------------------------ *
 * Explain node — recursive collapsible tree
 * ------------------------------------------------------------------ */

function ExplainNode({ detail, depth }: { detail: ExplainDetail; depth: number }): React.JSX.Element {
  const [open, setOpen] = useState(depth < 2)
  const hasChildren = detail.details && detail.details.length > 0
  const value = detail.value
  const valueStr = value !== undefined ? value.toFixed(4) : ''

  return (
    <div className="explain-node">
      <div
        className={`explain-row ${hasChildren ? 'clickable' : ''}`}
        onClick={() => hasChildren && setOpen(!open)}
        style={{ paddingLeft: depth * 18 }}
      >
        {hasChildren ? (
          <span className="explain-chevron">
            {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </span>
        ) : (
          <span className="explain-chevron" />
        )}
        {valueStr && (
          <span className="explain-value mono" style={{ color: scoreColor(value) }}>
            {valueStr}
          </span>
        )}
        {detail.description && (
          <span className="explain-desc">{detail.description}</span>
        )}
      </div>
      {hasChildren && open && (
        <div className="explain-children">
          {detail.details!.map((child, i) => (
            <ExplainNode key={i} detail={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Main component
 * ------------------------------------------------------------------ */

export function ExplainTree({ body }: { body: unknown }): React.JSX.Element {
  const parsed = body as ExplainBody
  const hits = parsed?.explained ?? []

  if (hits.length === 0) {
    return (
      <div className="res-empty">
        No explain data. Use the <span className="mono">_explain</span> endpoint or click "Explain" on a hit.
      </div>
    )
  }

  return (
    <div className="explain-tree">
      {hits.map((hit, i) => (
        <div key={i} className="explain-hit">
          <div className="explain-hit-header">
            <span className="mono explain-hit-id">{hit._id ?? `#${i}`}</span>
            {hit._score !== undefined && (
              <span className="mono explain-hit-score" style={{ color: scoreColor(hit._score) }}>
                score: {hit._score.toFixed(4)}
              </span>
            )}
            {hit.matched === false && (
              <span className="explain-hit-matched">not matched</span>
            )}
          </div>
          {hit.explanation && (
            <ExplainNode detail={hit.explanation} depth={0} />
          )}
        </div>
      ))}
    </div>
  )
}
