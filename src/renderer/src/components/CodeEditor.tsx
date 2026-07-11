import { useEffect, useRef } from 'react'
import * as monaco from 'monaco-editor'
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import { useResolvedTheme } from '../theme'
import { dslSuggest, type DslKind } from '../lib/searchDsl'

// Fully bundled workers — no CDN, works offline (NFR-3).
self.MonacoEnvironment = {
  getWorker: (_: unknown, label: string) =>
    label === 'json' ? new jsonWorker() : new editorWorker()
}

// Editor colors derived from the app tokens so Monaco reads as part of the app (FR-8.2).
monaco.editor.defineTheme('lodestone-light', {
  base: 'vs',
  inherit: true,
  rules: [
    { token: 'string.key.json', foreground: '0e7a6e' },
    { token: 'string.value.json', foreground: '9a3b63' },
    { token: 'number', foreground: '795e26' }
  ],
  colors: {
    'editor.background': '#ffffff',
    'editor.foreground': '#171a1f',
    'editor.lineHighlightBackground': '#f4f5f6',
    'editorLineNumber.foreground': '#c9ced4',
    'editorLineNumber.activeForeground': '#8b939d',
    'editor.selectionBackground': '#0e7a6e33',
    'editorCursor.foreground': '#0e7a6e',
    'editorWidget.background': '#ffffff',
    'editorWidget.border': '#e2e5e9'
  }
})

monaco.editor.defineTheme('lodestone-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'string.key.json', foreground: '4dc6b8' },
    { token: 'string.value.json', foreground: 'd48ead' },
    { token: 'number', foreground: 'd9a76a' }
  ],
  colors: {
    'editor.background': '#16181d',
    'editor.foreground': '#e6e9ec',
    'editor.lineHighlightBackground': '#1d2126',
    'editorLineNumber.foreground': '#3a414b',
    'editorLineNumber.activeForeground': '#6a727c',
    'editor.selectionBackground': '#35b5a733',
    'editorCursor.foreground': '#35b5a7',
    'editorWidget.background': '#1d2126',
    'editorWidget.border': '#262b31'
  }
})

/**
 * Query-DSL + field autocomplete, scoped per editor. Only models registered in
 * this map (editors passed `suggestFields`) get suggestions, so the create-index
 * or settings editors aren't polluted with query keywords.
 */
const suggestRegistry = new Map<string, string[]>()

const KIND: Record<DslKind, monaco.languages.CompletionItemKind> = {
  query: monaco.languages.CompletionItemKind.Function,
  agg: monaco.languages.CompletionItemKind.Method,
  keyword: monaco.languages.CompletionItemKind.Keyword,
  field: monaco.languages.CompletionItemKind.Field,
  value: monaco.languages.CompletionItemKind.Value
}

let providerRegistered = false
function ensureCompletionProvider(): void {
  if (providerRegistered) return
  providerRegistered = true
  const provider: monaco.languages.CompletionItemProvider = {
    triggerCharacters: ['"', '.'],
    provideCompletionItems(model, position) {
      // Only editors that opted in (Console body, Search raw query) are registered.
      const fields = suggestRegistry.get(model.uri.toString())
      if (fields === undefined) return { suggestions: [] }
      const word = model.getWordUntilPosition(position)
      const line = model.getLineContent(position.lineNumber)
      // If a quote is already open, replace from it (and consume the auto-closed
      // trailing quote) so we don't end up with doubled quotes.
      const quoted = line[word.startColumn - 2] === '"'
      const trailingQuote = quoted && line[word.endColumn - 1] === '"'
      const range = new monaco.Range(
        position.lineNumber,
        quoted ? word.startColumn - 1 : word.startColumn,
        position.lineNumber,
        trailingQuote ? word.endColumn + 1 : word.endColumn
      )
      const textBefore = model.getValueInRange({
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: position.lineNumber,
        endColumn: position.column
      })
      const items = dslSuggest(textBefore, fields)
      return {
        suggestions: items.map((it) => ({
          label: it.label,
          kind: KIND[it.kind],
          detail: it.detail,
          documentation: it.doc,
          insertText: it.insert,
          // The range starts at the opening quote, so Monaco matches typed text
          // (e.g. `"qu`) against filterText — it must carry the quote too, or
          // every suggestion is filtered out and only $schema (from the JSON
          // language service) survives.
          filterText: quoted ? `"${it.label}` : it.label,
          range,
          ...(it.snippet
            ? { insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet }
            : {})
        }))
      }
    }
  }
  monaco.languages.registerCompletionItemProvider('json', provider)
}
ensureCompletionProvider()

export function CodeEditor({
  value,
  onChange,
  readOnly = false,
  height = 220,
  suggestFields,
  language = 'json'
}: {
  value: string
  onChange?: (value: string) => void
  readOnly?: boolean
  height?: number | string
  /** When set, enables ES query-DSL + these field names as autocomplete. */
  suggestFields?: string[]
  /** Monaco language id (default json). */
  language?: string
}): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const modelUriRef = useRef<string | null>(null)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const suggestRef = useRef(suggestFields)
  suggestRef.current = suggestFields
  const theme = useResolvedTheme()

  useEffect(() => {
    const host = hostRef.current!
    const editor = monaco.editor.create(host, {
      value,
      language,
      readOnly,
      minimap: { enabled: false },
      fontFamily: "'JetBrains Mono', Consolas, monospace",
      fontSize: 12,
      lineNumbers: 'on',
      folding: true,
      scrollBeyondLastLine: false,
      // We drive layout ourselves: automaticLayout can latch onto a bogus
      // size while the containing dialog is still animating in.
      automaticLayout: false,
      renderLineHighlight: 'line',
      tabSize: 2,
      wordWrap: 'on',
      // DSL keys/values live inside JSON strings — suggest there too, not just
      // on Ctrl+Space.
      quickSuggestions: { other: true, comments: false, strings: true },
      suggestOnTriggerCharacters: true,
      fixedOverflowWidgets: true,
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
      padding: { top: 8, bottom: 8 }
    })
    editorRef.current = editor
    if (import.meta.env.DEV) {
      // Dev-only handle so tooling/tests can reach editor instances (tree-shaken in prod).
      const g = globalThis as unknown as { __editors?: unknown[] }
      g.__editors = [...(g.__editors ?? []), editor]
    }
    const modelUri = editor.getModel()?.uri.toString() ?? null
    modelUriRef.current = modelUri
    if (modelUri && suggestRef.current) suggestRegistry.set(modelUri, suggestRef.current)
    const sub = editor.onDidChangeModelContent(() => {
      onChangeRef.current?.(editor.getValue())
    })

    // Re-layout to the real box whenever it changes size (dialog settling,
    // window resize, split-pane drags). ResizeObserver fires once immediately
    // with the settled dimensions, which clears the sentinel scroll height.
    const ro = new ResizeObserver(() => {
      const { width, height } = host.getBoundingClientRect()
      if (width > 0 && height > 0) editor.layout({ width, height })
    })
    ro.observe(host)

    return () => {
      ro.disconnect()
      sub.dispose()
      editor.dispose()
      if (modelUri) suggestRegistry.delete(modelUri)
      editorRef.current = null
    }
    // The editor is created once; value/readOnly updates are handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Keep the field suggestions in sync as the console's target index changes.
  useEffect(() => {
    const uri = modelUriRef.current
    if (!uri) return
    if (suggestFields) suggestRegistry.set(uri, suggestFields)
    else suggestRegistry.delete(uri)
  }, [suggestFields])

  useEffect(() => {
    monaco.editor.setTheme(theme === 'dark' ? 'lodestone-dark' : 'lodestone-light')
  }, [theme])

  useEffect(() => {
    const editor = editorRef.current
    if (editor && editor.getValue() !== value) editor.setValue(value)
  }, [value])

  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly })
  }, [readOnly])

  return <div ref={hostRef} className="code-editor" style={{ height }} />
}
