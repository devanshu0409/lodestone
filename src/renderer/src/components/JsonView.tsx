import { useMemo, useState } from 'react'
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
 * shown JSON to the matches; an empty path shows the whole document. Used
 * wherever we surface JSON (console response, search results as JSON).
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

  return (
    <div className="json-view">
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
          ) : (
            count >= 0 && <span className="json-path-msg">{count} match{count === 1 ? '' : 'es'}</span>
          )}
        </div>
      )}
      <CodeEditor value={text} readOnly height={height} />
    </div>
  )
}
