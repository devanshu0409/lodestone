import { esJson, type MappedField } from './api'
import { buildQuery, hasActiveFilter, type FilterRow } from './filterQuery'
import type { Distribution } from '@shared/types'

/**
 * The SQL tab's engine.
 *
 * Structured queries (the visual builder) COMPILE TO NATIVE `_search` requests
 * — including JOINs, which Elasticsearch cannot do server-side at all and
 * OpenSearch only does by burning coordinator-node heap. Lodestone executes
 * joins itself: fetch the (capped) left side, batch the join keys into `terms`
 * queries for the right side, and hash-join locally. The cluster only ever
 * sees ordinary bounded searches.
 *
 * Raw SQL mode passes the text through to `_sql` (Elasticsearch) or
 * `/_plugins/_sql` (OpenSearch) unchanged.
 */

/* ------------------------------------------------------------------ *
 * Model
 * ------------------------------------------------------------------ */

export type SqlFunc = 'COUNT' | 'AVG' | 'SUM' | 'MIN' | 'MAX'

export interface SelectCol {
  id: number
  side: 'l' | 'r'
  /** Aggregate function; undefined = plain column. COUNT with field '' = COUNT(*). */
  func?: SqlFunc
  field: string
}

export interface JoinSpec {
  enabled: boolean
  type: 'inner' | 'left'
  rightIndex: string
  leftKey: string
  rightKey: string
  rightWhere: FilterRow[]
}

export interface OrderSpec {
  /** Label of the output column to sort by (see colLabel). */
  column: string
  dir: 'asc' | 'desc'
}

export interface SqlState {
  index: string
  columns: SelectCol[] // empty = SELECT *
  where: FilterRow[]
  join: JoinSpec
  groupBy: string // '' = none
  orderBy: OrderSpec | null
  limit: number
  /** JOIN safety cap: max left-side rows fetched. */
  leftCap: number
}

export interface SqlResult {
  columns: string[]
  rows: unknown[][]
  tookMs: number
  /** Set when a safety cap truncated the result. */
  truncated?: string
}

/** Join safety rails — the cluster only sees bounded searches. */
export const LEFT_CAPS = [100, 1000, 5000, 10000]
const TERMS_BATCH = 1024 // join keys per right-side terms query
const RIGHT_BATCH_SIZE = 10000 // max right rows fetched per batch
const JOIN_OUTPUT_CAP = 50000 // hard stop for joined rows

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

export function getPath(source: unknown, path: string): unknown {
  let v: unknown = source
  for (const seg of path.split('.')) {
    if (v === null || typeof v !== 'object') return undefined
    v = (v as Record<string, unknown>)[seg]
  }
  return v
}

export function colLabel(c: SelectCol, joined: boolean): string {
  if (c.func) return `${c.func}(${c.field ? (joined ? `${c.side}.` : '') + c.field : '*'})`
  return joined ? `${c.side}.${c.field}` : c.field
}

/**
 * Scalar values of a (possibly array-valued) field path. Any ES field can hold
 * an array — a doc's join key may be ["uuid1","uuid2"] — so fan out over arrays
 * at every step and keep only scalars: feeding arrays into a `terms` query is
 * what the cluster rejects with "[bool] failed to parse field [filter]".
 */
function keyValuesOf(source: unknown, path: string): unknown[] {
  let nodes: unknown[] = [source]
  for (const seg of path.split('.')) {
    const next: unknown[] = []
    for (const n of nodes) {
      for (const v of Array.isArray(n) ? n : [n]) {
        if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
          next.push((v as Record<string, unknown>)[seg])
        }
      }
    }
    nodes = next
  }
  const out: unknown[] = []
  for (const n of nodes) {
    for (const v of Array.isArray(n) ? (n as unknown[]).flat(Infinity) : [n]) {
      if (v !== undefined && v !== null && typeof v !== 'object') out.push(v)
    }
  }
  return out
}

const esFieldOf = (fields: MappedField[], path: string): string =>
  fields.find((f) => f.path === path)?.sortPath ?? path

/** Render one filter row as a SQL predicate (display text only). */
function rowToSqlPredicate(r: FilterRow, prefix: string): string | null {
  if (!r.field) return null
  const f = `${prefix}${r.field}`
  const v = /^-?\d+(\.\d+)?$/.test(r.value) || r.value === 'true' || r.value === 'false'
    ? r.value
    : `'${r.value.replace(/'/g, "''")}'`
  switch (r.op) {
    case '=': return `${f} = ${v}`
    case '≠': return `${f} != ${v}`
    case '>': return `${f} > ${v}`
    case '≥': return `${f} >= ${v}`
    case '<': return `${f} < ${v}`
    case '≤': return `${f} <= ${v}`
    case 'contains': return `${f} LIKE '%${r.value.replace(/'/g, "''")}%'`
    case 'wildcard': return `${f} LIKE '${r.value.replace(/\*/g, '%').replace(/'/g, "''")}'`
    case 'prefix': return `${f} LIKE '${r.value.replace(/'/g, "''")}%'`
    case 'term': return `${f} = ${v}`
    case 'fuzzy': return `${f} = ${v} /* fuzzy */`
    case 'regexp': return `${f} RLIKE '${r.value.replace(/'/g, "''")}'`
    case 'exists': return `${f} IS NOT NULL`
    case 'not exists': return `${f} IS NULL`
    default: return null
  }
}

function whereToSql(rows: FilterRow[], prefix: string): string {
  const parts: string[] = []
  for (const r of rows) {
    const p = rowToSqlPredicate(r, prefix)
    if (!p) continue
    parts.push(parts.length === 0 ? p : `${r.conj} ${p}`)
  }
  return parts.join(' ')
}

/** Human-readable SQL for the current builder state (display / copy). */
export function toSql(s: SqlState): string {
  const joined = s.join.enabled
  const pfx = (side: 'l' | 'r'): string => (joined ? `${side}.` : '')
  let cols =
    s.columns.length === 0
      ? joined
        ? 'l.*, r.*'
        : '*'
      : s.columns.map((c) => (c.func ? `${c.func}(${c.field ? pfx(c.side) + c.field : '*'})` : pfx(c.side) + c.field)).join(', ')
  // The group key is always part of the output — reflect that in the SQL.
  if (s.groupBy && !s.columns.some((c) => !c.func && c.field === s.groupBy)) {
    cols = `${s.groupBy}, ${cols}`
  }
  const lines = [`SELECT ${cols}`, `FROM ${s.index}${joined ? ' AS l' : ''}`]
  if (joined) {
    lines.push(
      `${s.join.type.toUpperCase()} JOIN ${s.join.rightIndex} AS r`,
      `  ON l.${s.join.leftKey} = r.${s.join.rightKey}`
    )
  }
  const whereParts: string[] = []
  const lw = whereToSql(s.where, pfx('l'))
  if (lw) whereParts.push(lw)
  if (joined) {
    const rw = whereToSql(s.join.rightWhere, 'r.')
    if (rw) whereParts.push(whereParts.length ? `AND (${rw})` : rw)
  }
  if (whereParts.length) lines.push(`WHERE ${whereParts.join(' ')}`)
  if (s.groupBy) lines.push(`GROUP BY ${s.groupBy}`)
  if (s.orderBy?.column) lines.push(`ORDER BY ${s.orderBy.column} ${s.orderBy.dir.toUpperCase()}`)
  lines.push(`LIMIT ${s.limit}`)
  return lines.join('\n')
}

/* ------------------------------------------------------------------ *
 * Compile to _search
 * ------------------------------------------------------------------ */

interface Hit {
  _source: Record<string, unknown>
}

/** One physical side of a join, in the shape the join algorithm needs. */
interface JoinSide {
  side: 'l' | 'r'
  index: string
  /** _source path of the join key. */
  key: string
  /** Queryable (doc_values) form of the join key — what `terms` must target. */
  keyEs: string
  where: FilterRow[]
  fieldMap: Map<string, MappedField>
}

/** Exact count of docs matching a side's own WHERE. Cheap: size 0, no _source. */
async function countMatching(connId: string, side: JoinSide, signal?: AbortSignal): Promise<number> {
  const { total } = await search(
    connId,
    side.index,
    {
      ...(hasActiveFilter(side.where) ? { query: buildQuery(side.where, side.fieldMap) } : {}),
      size: 0,
      track_total_hits: true
    },
    signal
  )
  return total
}

/**
 * `total` is only exact when the body asked for `track_total_hits: true`.
 *
 * Every request the join makes funnels through here, so the abort check sits
 * here too: a stopped join issues no further requests. In-flight ones still
 * run to completion (and the cluster still finishes the search either way —
 * only _tasks/_cancel would stop that).
 */
async function search(
  connId: string,
  index: string,
  body: unknown,
  signal?: AbortSignal
): Promise<{ hits: Hit[]; total: number }> {
  signal?.throwIfAborted()
  const res = await esJson<{
    hits?: { hits?: Hit[]; total?: { value?: number } | number }
  }>(connId, {
    method: 'POST',
    path: `/${encodeURIComponent(index)}/_search`,
    body
  })
  const hits = res.hits?.hits ?? []
  const t = res.hits?.total
  // ES 7+/OpenSearch return {value,relation}; older shapes return a bare number.
  return { hits, total: typeof t === 'number' ? t : (t?.value ?? hits.length) }
}

/** The compiled left-side (or only) _search body — also used by "View DSL". */
export function compileSearchBody(
  s: SqlState,
  fields: MappedField[],
  fieldMap: Map<string, MappedField>
): Record<string, unknown> {
  const hasAgg = s.columns.some((c) => c.func)
  const body: Record<string, unknown> = {}
  if (hasActiveFilter(s.where)) body.query = buildQuery(s.where, fieldMap)

  // With a join, aggregation happens client-side over the joined rows — the
  // left fetch is always a plain (bounded) select.
  if (!s.join.enabled && (hasAgg || s.groupBy)) {
    body.size = 0
    const metricAggs: Record<string, unknown> = {}
    for (const c of s.columns) {
      if (!c.func || c.func === 'COUNT') continue
      metricAggs[colKey(c)] = { [c.func.toLowerCase()]: { field: esFieldOf(fields, c.field) } }
    }
    if (s.groupBy) {
      body.aggs = {
        g: {
          terms: { field: esFieldOf(fields, s.groupBy), size: Math.min(s.limit, 1000) },
          ...(Object.keys(metricAggs).length ? { aggs: metricAggs } : {})
        }
      }
    } else if (Object.keys(metricAggs).length) {
      body.aggs = metricAggs
    }
    return body
  }

  body.size = s.join.enabled ? s.leftCap : s.limit
  // Exact total, so the join knows whether the cap actually truncated it rather
  // than inferring from a full page (7.x/OpenSearch stop counting at 10k without this).
  if (s.join.enabled) body.track_total_hits = true
  const needed = neededFields(s, 'l')
  if (needed) body._source = needed
  if (s.orderBy?.column && !s.join.enabled) {
    const f = fieldMap.get(s.orderBy.column)
    if (f?.sortPath) body.sort = [{ [f.sortPath]: s.orderBy.dir }]
  }
  return body
}

const colKey = (c: SelectCol): string => `${c.func}_${c.field.replace(/[^\w]/g, '_')}`

/** _source filter: only the columns we render + the join key. null = all. */
function neededFields(s: SqlState, side: 'l' | 'r'): string[] | null {
  if (s.columns.length === 0 && !s.groupBy) return null
  const set = new Set<string>()
  for (const c of s.columns) if (c.field && c.side === side) set.add(c.field)
  if (s.groupBy) {
    // With a join the group key is side-qualified ("l.field" / "r.field").
    const g = s.groupBy.match(/^([lr])\.(.+)$/)
    if (g ? g[1] === side : side === 'l') set.add(g ? g[2] : s.groupBy)
  }
  if (s.join.enabled) set.add(side === 'l' ? s.join.leftKey : s.join.rightKey)
  if (s.orderBy?.column) {
    const raw = s.orderBy.column.replace(/^[lr]\./, '')
    set.add(raw)
  }
  return [...set]
}

/* ------------------------------------------------------------------ *
 * Execution
 * ------------------------------------------------------------------ */

export async function runStructured(
  connId: string,
  s: SqlState,
  fields: MappedField[],
  fieldMap: Map<string, MappedField>,
  rightFields: MappedField[],
  rightFieldMap: Map<string, MappedField>,
  signal?: AbortSignal
): Promise<SqlResult> {
  const started = Date.now()
  const hasAgg = s.columns.some((c) => c.func)

  /* ---- aggregation path (no join — ES computes the aggs) ---- */
  if (!s.join.enabled && (hasAgg || s.groupBy)) {
    signal?.throwIfAborted()
    const body = compileSearchBody(s, fields, fieldMap)
    const res = await esJson<{
      hits?: { total?: { value?: number } | number }
      aggregations?: Record<string, unknown>
    }>(connId, { method: 'POST', path: `/${encodeURIComponent(s.index)}/_search`, body })

    const columns = [
      ...(s.groupBy ? [s.groupBy] : []),
      ...s.columns.filter((c) => c.func).map((c) => colLabel(c, false))
    ]
    const metricValue = (holder: Record<string, unknown>, c: SelectCol, docCount: number): unknown => {
      if (c.func === 'COUNT') return docCount
      const v = holder[colKey(c)] as { value?: unknown } | undefined
      return v?.value ?? null
    }
    const rows: unknown[][] = []
    if (s.groupBy) {
      const buckets =
        ((res.aggregations?.g as { buckets?: Record<string, unknown>[] })?.buckets ?? [])
      for (const b of buckets) {
        rows.push([
          b.key_as_string ?? b.key,
          ...s.columns.filter((c) => c.func).map((c) => metricValue(b, c, Number(b.doc_count ?? 0)))
        ])
      }
    } else {
      const total = typeof res.hits?.total === 'number' ? res.hits.total : (res.hits?.total?.value ?? 0)
      rows.push([...s.columns.filter((c) => c.func).map((c) => metricValue(res.aggregations ?? {}, c, total))])
    }
    return { columns, rows: sortAndLimit(rows, columns, s), tookMs: Date.now() - started }
  }

  /* ---- plain select (no join) ---- */
  if (!s.join.enabled) {
    const body = compileSearchBody(s, fields, fieldMap)
    const { hits } = await search(connId, s.index, body, signal)
    const cols = outputCols(s, fields, rightFields)
    const rows = hits.map((h) => cols.map((c) => cell(getPath(h._source, c.field))))
    return {
      columns: cols.map((c) => colLabel(c, false)),
      rows,
      tookMs: Date.now() - started
    }
  }

  /* ---- client-side JOIN ---- */
  // Every cap that bit is reported — one overwriting another would hide a real
  // reason the numbers are short.
  const cuts: string[] = []
  const truncation = (): string | undefined => (cuts.length ? cuts.join('; ') : undefined)

  const sides: Record<'l' | 'r', JoinSide> = {
    l: {
      side: 'l',
      index: s.index,
      key: s.join.leftKey,
      keyEs: esFieldOf(fields, s.join.leftKey),
      where: s.where,
      fieldMap
    },
    r: {
      side: 'r',
      index: s.join.rightIndex,
      key: s.join.rightKey,
      keyEs: esFieldOf(rightFields, s.join.rightKey),
      where: s.join.rightWhere,
      fieldMap: rightFieldMap
    }
  }

  // 1. Pick the driving side. Whichever side is more selective drives: fetching
  // it whole means the cap never truncates an answer the other side could have
  // supplied. LEFT JOIN has no choice — it must emit unmatched left rows, and
  // driving from the right can only ever find left rows that DO match.
  let driver = sides.l
  if (s.join.type === 'inner') {
    const [lCount, rCount] = await Promise.all([
      countMatching(connId, sides.l, signal),
      countMatching(connId, sides.r, signal)
    ])
    if (rCount < lCount) driver = sides.r
  }
  const probe = driver.side === 'l' ? sides.r : sides.l

  // 2. Driving side — capped. track_total_hits gives the real match count, so
  // this is an exact statement about what was dropped, not a guess from a page.
  const driverBody = compileSearchBody(s, fields, fieldMap)
  if (driver.side === 'r') {
    // compileSearchBody only ever describes the left index; rebuild for the right.
    driverBody.query = hasActiveFilter(driver.where)
      ? buildQuery(driver.where, driver.fieldMap)
      : { match_all: {} }
    const needed = neededFields(s, 'r')
    if (needed) driverBody._source = needed
    else delete driverBody._source
    delete driverBody.sort
  }
  const { hits: driverHits, total: driverTotal } = await search(connId, driver.index, driverBody, signal)
  if (driverTotal > s.leftCap) {
    cuts.push(
      `joined ${driverHits.length.toLocaleString()} of ${driverTotal.toLocaleString()} matching ` +
        `${driver.side === 'l' ? 'left' : 'right'} rows (cap ${s.leftCap.toLocaleString()}) — ` +
        `narrow the WHERE or raise the cap`
    )
  }

  // 3. Unique join keys → batched terms queries against the probe index.
  const keys = [...new Set(driverHits.flatMap((h) => keyValuesOf(h._source, driver.key)))]
  const probeByKey = new Map<string, Record<string, unknown>[]>()
  for (let i = 0; i < keys.length; i += TERMS_BATCH) {
    const batch = keys.slice(i, i + TERMS_BATCH)
    const must: unknown[] = [{ terms: { [probe.keyEs]: batch } }]
    if (hasActiveFilter(probe.where)) must.push(buildQuery(probe.where, probe.fieldMap))
    const { hits: probeHits, total: probeTotal } = await search(
      connId,
      probe.index,
      {
        query: { bool: { filter: must } },
        size: RIGHT_BATCH_SIZE,
        track_total_hits: true,
        ...(neededFields(s, probe.side) ? { _source: neededFields(s, probe.side) } : {})
      },
      signal
    )
    if (probeTotal > RIGHT_BATCH_SIZE && !cuts.some((c) => c.startsWith('probe side'))) {
      cuts.push(
        `probe side matched ${probeTotal.toLocaleString()} rows for a key batch but only ` +
          `${RIGHT_BATCH_SIZE.toLocaleString()} were fetched — narrow the ` +
          `${probe.side === 'l' ? 'left' : 'right'} WHERE`
      )
    }
    for (const h of probeHits) {
      // A doc registers under every value of an array-valued key.
      for (const k of new Set(keyValuesOf(h._source, probe.key).map(String))) {
        const list = probeByKey.get(k) ?? []
        list.push(h._source)
        probeByKey.set(k, list)
      }
    }
  }

  // A capped row list is still a list of correct rows — but an aggregate over a
  // capped list is a wrong NUMBER wearing the look of a right one (COUNT(*) would
  // report the cap, not the total). Refuse rather than mislead.
  // ponytail: only bites when BOTH sides exceed the cap, since the join drives from
  // the smaller one. Upgrade path if that shows up: search_after to page the driver.
  if ((hasAgg || s.groupBy) && truncation()) {
    throw new Error(
      `Can't aggregate over a truncated join — the result would be wrong, not just partial. ` +
        `${truncation()}. Narrow the WHERE until the join fits, or drop the functions/GROUP BY to see the rows.`
    )
  }

  // 4. Hash join locally — the cluster never sees this part.
  // With aggregates / GROUP BY, join on just the raw fields they need, then
  // aggregate the joined rows here (they're already local).
  const aggMode = hasAgg || !!s.groupBy
  let cols: SelectCol[]
  if (aggMode) {
    const seen = new Map<string, SelectCol>()
    let id = -1
    const add = (side: 'l' | 'r', field: string): void => {
      if (!seen.has(`${side}.${field}`)) seen.set(`${side}.${field}`, { id: id--, side, field })
    }
    const g = s.groupBy.match(/^([lr])\.(.+)$/)
    if (g) add(g[1] as 'l' | 'r', g[2])
    for (const c of s.columns) if (c.func && c.field) add(c.side, c.field)
    cols = [...seen.values()]
  } else {
    cols = outputCols(s, fields, rightFields)
  }
  const rows: unknown[][] = []
  // Row assembly is by physical side, not by driver/probe — so a right-driven
  // join emits identical rows to a left-driven one.
  const docFor = (
    c: SelectCol,
    driverDoc: Record<string, unknown>,
    probeDoc: Record<string, unknown> | null
  ): unknown =>
    c.side === driver.side ? cell(getPath(driverDoc, c.field)) : probeDoc && cell(getPath(probeDoc, c.field))

  outer: for (const dh of driverHits) {
    const dKeys = new Set(keyValuesOf(dh._source, driver.key).map(String))
    const matches: Record<string, unknown>[] = []
    const seenDocs = new Set<Record<string, unknown>>()
    for (const k of dKeys) {
      for (const m of probeByKey.get(k) ?? []) {
        if (!seenDocs.has(m)) {
          seenDocs.add(m)
          matches.push(m)
        }
      }
    }
    if (matches.length === 0) {
      // Only reachable for LEFT JOIN, which always drives from the left.
      if (s.join.type === 'left') rows.push(cols.map((c) => docFor(c, dh._source, null)))
      continue
    }
    for (const m of matches) {
      rows.push(cols.map((c) => docFor(c, dh._source, m)))
      if (rows.length >= JOIN_OUTPUT_CAP) {
        cuts.push(`joined output capped at ${JOIN_OUTPUT_CAP.toLocaleString()} rows`)
        break outer
      }
    }
  }

  let labels = cols.map((c) => colLabel(c, true))
  let outRows = rows
  if (aggMode) {
    // The output cap can bite here, after the pre-join check — same rule applies.
    if (truncation()) {
      throw new Error(
        `Can't aggregate over a truncated join — the result would be wrong, not just partial. ` +
          `${truncation()}. Narrow the WHERE so the join fits, or drop the functions/GROUP BY to see the rows.`
      )
    }
    ;({ columns: labels, rows: outRows } = aggregateJoined(rows, labels, s))
  }
  return {
    columns: labels,
    rows: sortAndLimit(outRows, labels, s),
    tookMs: Date.now() - started,
    truncated: truncation()
  }
}

/** GROUP BY + aggregate functions over already-joined local rows. */
function aggregateJoined(
  rows: unknown[][],
  rawLabels: string[],
  s: SqlState
): { columns: string[]; rows: unknown[][] } {
  const funcs = s.columns.filter((c) => c.func)
  const gi = s.groupBy ? rawLabels.indexOf(s.groupBy) : -1
  const groups = new Map<string, { key: unknown; members: unknown[][] }>()
  for (const r of rows) {
    const key = gi >= 0 ? r[gi] : null
    const g = groups.get(String(key)) ?? { key, members: [] }
    g.members.push(r)
    groups.set(String(key), g)
  }
  // No GROUP BY = one global group, present even over zero rows (COUNT(*) = 0).
  if (gi < 0 && groups.size === 0) groups.set('', { key: null, members: [] })

  const columns = [...(s.groupBy ? [s.groupBy] : []), ...funcs.map((c) => colLabel(c, true))]
  const out: unknown[][] = []
  for (const g of groups.values()) {
    const cells = funcs.map((c) => {
      const fi = c.field ? rawLabels.indexOf(`${c.side}.${c.field}`) : -1
      if (c.func === 'COUNT') {
        return fi >= 0 ? g.members.filter((m) => m[fi] !== null && m[fi] !== undefined).length : g.members.length
      }
      const nums = g.members.map((m) => Number(m[fi])).filter(Number.isFinite)
      if (nums.length === 0) return null
      switch (c.func) {
        case 'AVG': return nums.reduce((a, b) => a + b, 0) / nums.length
        case 'SUM': return nums.reduce((a, b) => a + b, 0)
        case 'MIN': return Math.min(...nums)
        case 'MAX': return Math.max(...nums)
        default: return null
      }
    })
    out.push([...(gi >= 0 ? [g.key] : []), ...cells])
  }
  return { columns, rows: out }
}

/** SELECT * expands to the mapped leaf fields of each side. */
function outputCols(s: SqlState, fields: MappedField[], rightFields: MappedField[]): SelectCol[] {
  if (s.columns.length > 0) return s.columns.filter((c) => !c.func)
  let id = -1
  const l = fields.map((f) => ({ id: id--, side: 'l' as const, field: f.path }))
  if (!s.join.enabled) return l
  return [...l, ...rightFields.map((f) => ({ id: id--, side: 'r' as const, field: f.path }))]
}

function cell(v: unknown): unknown {
  if (v !== null && typeof v === 'object') return JSON.stringify(v)
  return v ?? null
}

function sortAndLimit(rows: unknown[][], columns: string[], s: SqlState): unknown[][] {
  let out = rows
  if (s.orderBy?.column) {
    const i = columns.indexOf(s.orderBy.column)
    if (i >= 0) {
      const dir = s.orderBy.dir === 'asc' ? 1 : -1
      out = [...rows].sort((a, b) => {
        const av = a[i], bv = b[i]
        if (av === null || av === undefined) return 1
        if (bv === null || bv === undefined) return -1
        const an = Number(av), bn = Number(bv)
        if (Number.isFinite(an) && Number.isFinite(bn)) return (an - bn) * dir
        return String(av) < String(bv) ? -dir : String(av) > String(bv) ? dir : 0
      })
    }
  }
  return out.slice(0, s.limit)
}

/* ------------------------------------------------------------------ *
 * Raw SQL passthrough (dialect-aware)
 * ------------------------------------------------------------------ */

export async function runRawSql(
  connId: string,
  distribution: Distribution,
  sql: string,
  signal?: AbortSignal
): Promise<SqlResult> {
  const started = Date.now()
  signal?.throwIfAborted()
  if (distribution === 'opensearch') {
    const res = await esJson<{
      schema?: { name: string }[]
      datarows?: unknown[][]
    }>(connId, { method: 'POST', path: '/_plugins/_sql?format=json', body: { query: sql } })
    return {
      columns: (res.schema ?? []).map((c) => c.name),
      rows: res.datarows ?? [],
      tookMs: Date.now() - started
    }
  }
  const res = await esJson<{
    columns?: { name: string }[]
    rows?: unknown[][]
  }>(connId, { method: 'POST', path: '/_sql?format=json', body: { query: sql } })
  return {
    columns: (res.columns ?? []).map((c) => c.name),
    rows: res.rows ?? [],
    tookMs: Date.now() - started
  }
}
