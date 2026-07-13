import type { MappedField } from './api'

/**
 * The structured filter model shared by the Search tab and the Aggregations
 * tab: rows of field / operator / value joined by AND/OR, compiled to a
 * `bool` query. Extracted from SearchTab so both builders stay in lockstep.
 */

export type Op =
  | '='
  | '≠'
  | 'contains'
  | 'term'
  | 'wildcard'
  | 'prefix'
  | 'fuzzy'
  | 'regexp'
  | '>'
  | '≥'
  | '<'
  | '≤'
  | 'exists'
  | 'not exists'

export const OPS: Op[] = [
  '=',
  '≠',
  'contains',
  'term',
  'wildcard',
  'prefix',
  'fuzzy',
  'regexp',
  '>',
  '≥',
  '<',
  '≤',
  'exists',
  'not exists'
]

export const VALUELESS: Set<Op> = new Set(['exists', 'not exists'])

/** How a row joins the previous one. OR binds tighter than AND (grouped runs). */
export type Conj = 'AND' | 'OR'

export interface FilterRow {
  id: number
  field: string
  op: Op
  value: string
  conj: Conj
}

let rowSeq = 0
export const newRow = (): FilterRow => ({ id: ++rowSeq, field: '', op: '=', value: '', conj: 'AND' })

export function coerce(value: string, type: string | undefined): unknown {
  if (
    type &&
    ['long', 'integer', 'short', 'byte', 'double', 'float', 'half_float', 'scaled_float', 'unsigned_long'].includes(type)
  ) {
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  if (type === 'boolean') return value === 'true'
  return value
}

/** A single row → one positive ES query clause (negatives are wrapped in must_not). */
export function rowClause(row: FilterRow, fields: Map<string, MappedField>): unknown | null {
  if (!row.field) return null
  const meta = fields.get(row.field)
  const isText = meta?.type === 'text'
  const exact = isText && meta?.sortPath ? meta.sortPath : row.field
  const value = coerce(row.value, meta?.type)
  const eq = isText && !meta?.sortPath ? { match_phrase: { [row.field]: row.value } } : { term: { [exact]: value } }
  switch (row.op) {
    case '=':
      return eq
    case '≠':
      return { bool: { must_not: [eq] } }
    case 'contains':
      return isText ? { match: { [row.field]: row.value } } : { wildcard: { [row.field]: `*${row.value}*` } }
    case 'term':
      return { term: { [exact]: value } }
    case 'wildcard':
      return { wildcard: { [row.field]: row.value } }
    case 'prefix':
      return { prefix: { [row.field]: row.value } }
    case 'fuzzy':
      return { fuzzy: { [row.field]: { value: row.value, fuzziness: 'AUTO' } } }
    case 'regexp':
      return { regexp: { [row.field]: row.value } }
    case '>':
    case '≥':
    case '<':
    case '≤': {
      const key = row.op === '>' ? 'gt' : row.op === '≥' ? 'gte' : row.op === '<' ? 'lt' : 'lte'
      return { range: { [row.field]: { [key]: value } } }
    }
    case 'exists':
      return { exists: { field: row.field } }
    case 'not exists':
      return { bool: { must_not: [{ exists: { field: row.field } }] } }
  }
}

export function buildQuery(rows: FilterRow[], fields: Map<string, MappedField>): unknown {
  const clauses = rows
    .map((r) => ({ clause: rowClause(r, fields), conj: r.conj }))
    .filter((c): c is { clause: unknown; conj: Conj } => c.clause !== null)
  if (clauses.length === 0) return { match_all: {} }

  // Group into OR-runs: an AND boundary starts a new group; OR appends to the
  // current group. Each multi-clause group becomes a should (minimum_should_match:1),
  // and the groups are ANDed together in a filter context.
  const groups: unknown[][] = []
  clauses.forEach((c, i) => {
    if (i === 0 || c.conj === 'AND') groups.push([c.clause])
    else groups[groups.length - 1].push(c.clause)
  })
  const combined = groups.map((g) =>
    g.length === 1 ? g[0] : { bool: { should: g, minimum_should_match: 1 } }
  )
  if (combined.length === 1) return combined[0]
  return { bool: { filter: combined } }
}

/** True when at least one row would contribute a clause (i.e. has a field). */
export function hasActiveFilter(rows: FilterRow[]): boolean {
  return rows.some((r) => r.field !== '')
}
