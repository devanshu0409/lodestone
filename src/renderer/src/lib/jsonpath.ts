/**
 * A small, dependency-free JSONPath evaluator covering the common subset people
 * actually type against a JSON blob:
 *   $                 root
 *   .name / ['name']  child by key
 *   [0] / [-1]        array index (negative counts from the end)
 *   [*] / .*          wildcard (all array elements or object values)
 *   [1:3]             array slice
 *   ..name / ..*      recursive descent
 *
 * It is intentionally not a full JSONPath (no filter expressions `?()`), which
 * keeps it tiny and predictable for an interactive "narrow this JSON" box.
 */

type Token =
  | { type: 'child'; name: string }
  | { type: 'index'; index: number }
  | { type: 'wild' }
  | { type: 'slice'; start?: number; end?: number }
  | { type: 'recurse'; name?: string }

function tokenize(expr: string): Token[] {
  const s = expr.trim()
  const tokens: Token[] = []
  let i = s[0] === '$' ? 1 : 0
  const readName = (): string => {
    let name = ''
    while (i < s.length && /[\w$@-]/.test(s[i])) {
      name += s[i]
      i++
    }
    return name
  }
  while (i < s.length) {
    const c = s[i]
    if (c === '.') {
      if (s[i + 1] === '.') {
        i += 2
        if (s[i] === '*') {
          tokens.push({ type: 'recurse' })
          i++
        } else tokens.push({ type: 'recurse', name: readName() })
      } else {
        i++
        if (s[i] === '*') {
          tokens.push({ type: 'wild' })
          i++
        } else {
          const name = readName()
          if (!name) throw new Error('Expected a name after "."')
          tokens.push({ type: 'child', name })
        }
      }
    } else if (c === '[') {
      const end = s.indexOf(']', i)
      if (end < 0) throw new Error('Unclosed "["')
      const inner = s.slice(i + 1, end).trim()
      i = end + 1
      if (inner === '*') tokens.push({ type: 'wild' })
      else if (/^-?\d+$/.test(inner)) tokens.push({ type: 'index', index: parseInt(inner, 10) })
      else if (/^'.*'$/.test(inner) || /^".*"$/.test(inner))
        tokens.push({ type: 'child', name: inner.slice(1, -1) })
      else if (inner.includes(':')) {
        const [a, b] = inner.split(':')
        tokens.push({
          type: 'slice',
          start: a.trim() ? parseInt(a, 10) : undefined,
          end: b.trim() ? parseInt(b, 10) : undefined
        })
      } else throw new Error(`Unsupported selector "[${inner}]"`)
    } else if (/\s/.test(c)) {
      i++
    } else {
      throw new Error(`Unexpected character "${c}"`)
    }
  }
  return tokens
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

function step(nodes: unknown[], tok: Token): unknown[] {
  const out: unknown[] = []
  for (const node of nodes) {
    switch (tok.type) {
      case 'child':
        if (isObj(node) && tok.name in node) out.push(node[tok.name])
        break
      case 'index':
        if (Array.isArray(node)) {
          const idx = tok.index < 0 ? node.length + tok.index : tok.index
          if (idx >= 0 && idx < node.length) out.push(node[idx])
        }
        break
      case 'wild':
        if (Array.isArray(node)) out.push(...node)
        else if (isObj(node)) out.push(...Object.values(node))
        break
      case 'slice':
        if (Array.isArray(node)) out.push(...node.slice(tok.start, tok.end))
        break
      case 'recurse': {
        const collect = (v: unknown): void => {
          if (tok.name === undefined) out.push(v)
          else if (isObj(v) && tok.name in v) out.push(v[tok.name])
          if (Array.isArray(v)) for (const c of v) collect(c)
          else if (isObj(v)) for (const c of Object.values(v)) collect(c)
        }
        collect(node)
        break
      }
    }
  }
  return out
}

export type JsonPathResult =
  | { ok: true; matches: unknown[] }
  | { ok: false; error: string }

export function evalJsonPath(data: unknown, expr: string): JsonPathResult {
  try {
    const tokens = tokenize(expr)
    let nodes: unknown[] = [data]
    for (const t of tokens) nodes = step(nodes, t)
    return { ok: true, matches: nodes }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}
