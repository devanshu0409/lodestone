import { useCallback, useEffect, useState } from 'react'
import { Loader2, Search } from 'lucide-react'
import type { ClusterConnection } from '@shared/types'
import { useApp } from '../store'
import { analyzeText, fetchCatIndices, fetchFields, type AnalyzeToken, type MappedField } from '../lib/api'

const BUILTIN_ANALYZERS = [
  'standard', 'simple', 'whitespace', 'keyword', 'stop', 'lowercase', 'fingerprint',
  'pattern', 'english', 'german', 'french', 'spanish', 'italian', 'portuguese',
  'russian', 'arabic', 'cjk', 'classic', 'ngram', 'edge_ngram'
]

type Mode = 'analyzer' | 'field'

interface PanelState {
  mode: Mode
  analyzer: string
  field: string
  tokens: AnalyzeToken[] | null
  loading: boolean
  error: string | null
}

const EMPTY_PANEL: PanelState = {
  mode: 'analyzer',
  analyzer: 'standard',
  field: '',
  tokens: null,
  loading: false,
  error: null
}

export function AnalyzerPlayground({ conn }: { conn: ClusterConnection }): React.JSX.Element {
  const pushToast = useApp((s) => s.pushToast)
  const [indices, setIndices] = useState<string[]>([])
  const [index, setIndex] = useState('')
  const [fields, setFields] = useState<MappedField[]>([])
  const [text, setText] = useState('The quick brown fox jumps over the lazy dog')
  const [left, setLeft] = useState<PanelState>({ ...EMPTY_PANEL })
  const [right, setRight] = useState<PanelState>({ ...EMPTY_PANEL, analyzer: 'english' })

  // Load index list
  useEffect(() => {
    fetchCatIndices(conn.id)
      .then((list) => {
        setIndices(list.map((i) => i.index))
      })
      .catch((err: Error) => pushToast('err', err.message))
  }, [conn.id, pushToast])

  // Load fields when index changes
  useEffect(() => {
    if (!index) {
      setFields([])
      return
    }
    fetchFields(conn.id, index)
      .then(setFields)
      .catch((err: Error) => pushToast('err', err.message))
  }, [conn.id, index, pushToast])

  const runAnalyze = useCallback(
    async (panel: PanelState, setPanel: (p: PanelState) => void): Promise<void> => {
      if (!text.trim()) return
      setPanel({ ...panel, loading: true, error: null })
      try {
        const body: { analyzer?: string; field?: string; text: string } = { text }
        if (panel.mode === 'analyzer') body.analyzer = panel.analyzer
        else body.field = panel.field
        const tokens = await analyzeText(conn.id, index || undefined, body)
        setPanel({ ...panel, tokens, loading: false })
      } catch (err) {
        setPanel({ ...panel, error: (err as Error).message, loading: false, tokens: null })
      }
    },
    [conn.id, index, text]
  )

  // Auto-run when text or settings change (debounced)
  useEffect(() => {
    const t = setTimeout(() => void runAnalyze(left, setLeft), 350)
    return () => clearTimeout(t)
  }, [text, left.mode, left.analyzer, left.field, index, runAnalyze])

  useEffect(() => {
    const t = setTimeout(() => void runAnalyze(right, setRight), 350)
    return () => clearTimeout(t)
  }, [text, right.mode, right.analyzer, right.field, index, runAnalyze])

  return (
    <div className="analyzer-playground">
      <div className="analyzer-top">
        <div className="analyzer-index-bar">
          <label className="field">
            <span className="analyzer-label">Index (optional)</span>
            <select
              className="input mono"
              value={index}
              onChange={(e) => setIndex(e.target.value)}
            >
              <option value="">— cluster-level —</option>
              {indices.map((i) => (
                <option key={i} value={i}>{i}</option>
              ))}
            </select>
          </label>
          <div className="analyzer-text-field">
            <label className="field" style={{ flex: 1 }}>
              <span className="analyzer-label">Text to analyze</span>
              <div style={{ position: 'relative' }}>
                <Search size={13} className="analyzer-text-icon" />
                <input
                  className="input mono analyzer-text-input"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder="Type text to tokenize…"
                  spellCheck={false}
                />
              </div>
            </label>
          </div>
        </div>
      </div>

      <div className="analyzer-panels">
        <AnalyzerPanel
          state={left}
          setState={setLeft}
          fields={fields}
          hasIndex={!!index}
        />
        <AnalyzerPanel
          state={right}
          setState={setRight}
          fields={fields}
          hasIndex={!!index}
        />
      </div>
    </div>
  )
}

function AnalyzerPanel({
  state,
  setState,
  fields,
  hasIndex
}: {
  state: PanelState
  setState: (p: PanelState) => void
  fields: MappedField[]
  hasIndex: boolean
}): React.JSX.Element {
  return (
    <div className="analyzer-panel">
      <div className="analyzer-panel-head">
        <div className="analyzer-mode-tabs">
          <button
            className={state.mode === 'analyzer' ? 'on' : ''}
            onClick={() => setState({ ...state, mode: 'analyzer' })}
          >
            Analyzer
          </button>
          <button
            className={state.mode === 'field' ? 'on' : ''}
            disabled={!hasIndex}
            title={hasIndex ? '' : 'Select an index first'}
            onClick={() => setState({ ...state, mode: 'field' })}
          >
            Field
          </button>
        </div>
        <select
          className="input mono analyzer-panel-select"
          value={state.mode === 'analyzer' ? state.analyzer : state.field}
          onChange={(e) =>
            setState(
              state.mode === 'analyzer'
                ? { ...state, analyzer: e.target.value }
                : { ...state, field: e.target.value }
            )
          }
        >
          {state.mode === 'analyzer' ? (
            BUILTIN_ANALYZERS.map((a) => (
              <option key={a} value={a}>{a}</option>
            ))
          ) : (
            <>
              <option value="">— select field —</option>
              {fields.map((f) => (
                <option key={f.path} value={f.path}>{f.path}</option>
              ))}
            </>
          )}
        </select>
      </div>

      <div className="analyzer-tokens-area">
        {state.loading && (
          <div className="analyzer-loading">
            <Loader2 size={16} className="spin" />
          </div>
        )}
        {state.error && (
          <div className="analyzer-error">{state.error}</div>
        )}
        {!state.loading && !state.error && state.tokens && (
          state.tokens.length === 0 ? (
            <div className="analyzer-empty">No tokens produced.</div>
          ) : (
            <div className="token-chips">
              {state.tokens.map((tok, i) => (
                <span key={i} className="token-chip" title={`type: ${tok.type}\nposition: ${tok.position}\noffset: ${tok.start_offset}–${tok.end_offset}`}>
                  <span className="token-chip-text">{tok.token}</span>
                  <span className="token-chip-pos">{tok.position}</span>
                </span>
              ))}
            </div>
          )
        )}
        {!state.loading && !state.error && !state.tokens && (
          <div className="analyzer-empty">Type some text above to see tokens.</div>
        )}
      </div>

      {state.tokens && state.tokens.length > 0 && (
        <div className="analyzer-token-count">
          {state.tokens.length} token{state.tokens.length !== 1 ? 's' : ''}
        </div>
      )}
    </div>
  )
}
