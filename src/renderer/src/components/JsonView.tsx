import { useMemo, useRef, useState } from 'react'
import type * as monaco from 'monaco-editor'
import { CodeEditor } from './CodeEditor'
import { evalJsonPath } from '../lib/jsonpath'

function pretty(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

/**
 * Read-only JSON viewer with a JSONPath filter box. Typing a path narrows the
 * shown JSON to the matches; an empty path shows the whole document. Ctrl/Cmd+F
 * anywhere in the view opens Monaco's find widget. Used wherever we surface
 * JSON (console response, search results as JSON, aggregation results).
 */
export function JsonView({
  value,
  height = '100%'
}: {
  value: unknown
  height?: number | string
}): React.JSX.Element {
  const [path, setPath] = useState('')
  const isString = typeof value === 'string'
  const trimmed = path.trim()
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)

  const { text, error, count } = useMemo(() => {
    if (isString || !trimmed || trimmed === '$') return { text: pretty(value), error: null, count: -1 }
    const res = evalJsonPath(value, trimmed)
    if (!res.ok) return { text: pretty(value), error: res.error, count: -1 }
    const shown = res.matches.length === 1 ? res.matches[0] : res.matches
    return {
      text: pretty(shown),
      error: res.matches.length === 0 ? 'No match' : null,
      count: res.matches.length
    }
  }, [value, trimmed, isString])

  const openFind = (): void => {
    const ed = editorRef.current
    if (!ed) return
    ed.focus()
    ed.getAction('actions.find')?.run()
  }

  return (
    <div
      className="json-view"
      onKeyDown={(e) => {
        // Route Ctrl/Cmd+F to the editor's find widget from anywhere in the view
        // (e.g. while the cursor is still in the JSONPath box).
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
          e.preventDefault()
          openFind()
        }
      }}
    >
      {!isString && (
        <div className="json-path-bar">
          <input
            className="input mono json-path-input"
            spellCheck={false}
            placeholder="JSONPath filter — e.g. $[*]._source.name  or  $..status"
            value={path}
            onChange={(e) => setPath(e.target.value)}
          />
          {error ? (
            <span className="json-path-msg err">{error}</span>
          ) : count >= 0 ? (
            <span className="json-path-msg">{count} match{count === 1 ? '' : 'es'}</span>
          ) : (
            <button className="json-find-btn" title="Find (Ctrl+F)" onClick={openFind}>
              ⌕ Find
            </button>
          )}
        </div>
      )}
      <CodeEditor value={text} readOnly height={height} onReady={(ed) => (editorRef.current = ed)} />
    </div>
  )
}
