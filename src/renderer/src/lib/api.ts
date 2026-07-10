import type { Distribution, EsRequestSpec, EsResponse } from '@shared/types'

/** Shared auto-refresh cadence for live views. */
export const REFRESH_MS = 15_000

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: unknown
  ) {
    super(message)
  }
}

export async function esRequest(id: string, spec: EsRequestSpec): Promise<EsResponse> {
  const res = await window.lodestone.cluster.request(id, spec)
  if (!res.ok) throw new ApiError(res.error)
  return res.data
}

function reasonOf(body: unknown): string {
  if (typeof body === 'object' && body !== null) {
    const err = (body as { error?: { reason?: string } | string }).error
    if (typeof err === 'string') return err
    if (err?.reason) return err.reason
  }
  return typeof body === 'string' ? body.slice(0, 200) : 'request failed'
}

/** Request that must succeed with a JSON body; throws ApiError otherwise. */
export async function esJson<T>(id: string, spec: EsRequestSpec): Promise<T> {
  const res = await esRequest(id, spec)
  if (!res.ok) throw new ApiError(`HTTP ${res.status}: ${reasonOf(res.body)}`, res.status, res.body)
  return res.body as T
}

function num(v: string | null | undefined): number | undefined {
  if (v === null || v === undefined || v === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

/* ---------- _cat/nodes ---------- */

export interface CatNode {
  name: string
  ip?: string
  version?: string
  /** Compact role letters as reported by _cat (e.g. "dim"). */
  roles: string
  master: boolean
  heapPercent?: number
  ramPercent?: number
  cpu?: number
  diskUsedPercent?: number
}

export async function fetchCatNodes(id: string, distribution: Distribution): Promise<CatNode[]> {
  // OpenSearch 2.x renamed the elected-manager column.
  const managerCol = distribution === 'opensearch' ? 'cluster_manager' : 'master'
  const h = `name,ip,version,node.role,${managerCol},heap.percent,ram.percent,cpu,disk.used_percent`
  const rows = await esJson<Record<string, string | null>[]>(id, {
    method: 'GET',
    path: `/_cat/nodes?format=json&h=${h}`
  })
  return rows
    .map((r) => ({
      name: r.name ?? '',
      ip: r.ip ?? undefined,
      version: r.version ?? undefined,
      roles: r['node.role'] ?? '',
      master: (r[managerCol] ?? '') === '*',
      heapPercent: num(r['heap.percent']),
      ramPercent: num(r['ram.percent']),
      cpu: num(r.cpu),
      diskUsedPercent: num(r['disk.used_percent'])
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/* ---------- _cat/indices ---------- */

export interface CatIndex {
  index: string
  health: 'green' | 'yellow' | 'red'
  status: string
  primaries: number
  replicas: number
  docs: number
  storeBytes: number
}

export async function fetchCatIndices(id: string): Promise<CatIndex[]> {
  const rows = await esJson<Record<string, string | null>[]>(id, {
    method: 'GET',
    path: '/_cat/indices?format=json&bytes=b&h=index,health,status,pri,rep,docs.count,store.size'
  })
  return rows
    .map((r) => ({
      index: r.index ?? '',
      health: (r.health as CatIndex['health']) ?? 'red',
      status: r.status ?? 'open',
      primaries: num(r.pri) ?? 0,
      replicas: num(r.rep) ?? 0,
      docs: num(r['docs.count']) ?? 0,
      storeBytes: num(r['store.size']) ?? 0
    }))
    .sort((a, b) => a.index.localeCompare(b.index))
}

/* ---------- _cat/shards ---------- */

export type ShardState = 'STARTED' | 'INITIALIZING' | 'RELOCATING' | 'UNASSIGNED'

export interface CatShard {
  index: string
  shard: number
  primary: boolean
  state: ShardState
  docs?: number
  storeBytes?: number
  /** Node currently holding the shard; undefined when unassigned. */
  node?: string
  /** Relocation target ("node -> ip name") when state is RELOCATING. */
  relocatingTo?: string
}

export async function fetchCatShards(id: string): Promise<CatShard[]> {
  const rows = await esJson<Record<string, string | null>[]>(id, {
    method: 'GET',
    path: '/_cat/shards?format=json&bytes=b&h=index,shard,prirep,state,docs,store,node'
  })
  return rows.map((r) => {
    const rawNode = r.node ?? ''
    // RELOCATING shards report "sourceNode -> targetIp targetId targetNode".
    const arrow = rawNode.indexOf(' ->')
    return {
      index: r.index ?? '',
      shard: num(r.shard) ?? 0,
      primary: r.prirep === 'p',
      state: (r.state as ShardState) ?? 'UNASSIGNED',
      docs: num(r.docs),
      storeBytes: num(r.store),
      node: arrow >= 0 ? rawNode.slice(0, arrow) : rawNode || undefined,
      relocatingTo: arrow >= 0 ? rawNode.slice(arrow + 3).trim() : undefined
    }
  })
}

/* ---------- mappings ---------- */

export interface MappedField {
  path: string
  type: string
  /** Field to sort/aggregate on (e.g. the .keyword multi-field for text), if any. */
  sortPath?: string
}

const SORTABLE_TYPES = new Set([
  'keyword',
  'long',
  'integer',
  'short',
  'byte',
  'double',
  'float',
  'half_float',
  'scaled_float',
  'unsigned_long',
  'date',
  'date_nanos',
  'boolean',
  'ip'
])

interface MappingProperty {
  type?: string
  properties?: Record<string, MappingProperty>
  fields?: Record<string, { type?: string }>
}

function flattenProperties(
  props: Record<string, MappingProperty> | undefined,
  prefix: string,
  out: MappedField[]
): void {
  for (const [name, prop] of Object.entries(props ?? {})) {
    const path = prefix ? `${prefix}.${name}` : name
    if (prop.properties) {
      if (prop.type) out.push(fieldOf(path, prop)) // e.g. explicit "object"/"nested"
      flattenProperties(prop.properties, path, out)
    } else if (prop.type) {
      out.push(fieldOf(path, prop))
    }
  }
}

function fieldOf(path: string, prop: MappingProperty): MappedField {
  const type = prop.type ?? 'object'
  let sortPath: string | undefined
  if (SORTABLE_TYPES.has(type)) {
    sortPath = path
  } else if (type === 'text') {
    const kw = Object.entries(prop.fields ?? {}).find(([, f]) => f.type === 'keyword')
    if (kw) sortPath = `${path}.${kw[0]}`
  }
  return { path, type, sortPath }
}

/** Flattened field list for an index/alias (union across concrete indices behind it). */
export async function fetchFields(id: string, index: string): Promise<MappedField[]> {
  const body = await esJson<Record<string, { mappings?: { properties?: Record<string, MappingProperty> } }>>(
    id,
    { method: 'GET', path: `/${encodeURIComponent(index)}/_mapping` }
  )
  const seen = new Map<string, MappedField>()
  for (const entry of Object.values(body)) {
    const out: MappedField[] = []
    flattenProperties(entry.mappings?.properties, '', out)
    for (const f of out) if (!seen.has(f.path)) seen.set(f.path, f)
  }
  return [...seen.values()].sort((a, b) => a.path.localeCompare(b.path))
}

/* ---------- search ---------- */

export interface SearchHit {
  _id: string
  _index: string
  _score?: number | null
  _source: Record<string, unknown>
}

export interface SearchResult {
  hits: SearchHit[]
  total: number
  totalRelation: 'eq' | 'gte'
  tookMs: number
}

export async function runSearch(id: string, index: string, body: unknown): Promise<SearchResult> {
  const res = await esJson<{
    took?: number
    hits?: { total?: { value?: number; relation?: string } | number; hits?: SearchHit[] }
  }>(id, { method: 'POST', path: `/${encodeURIComponent(index)}/_search`, body })
  const rawTotal = res.hits?.total
  const total = typeof rawTotal === 'number' ? rawTotal : (rawTotal?.value ?? 0)
  const relation =
    typeof rawTotal === 'object' && rawTotal?.relation === 'gte' ? ('gte' as const) : ('eq' as const)
  return { hits: res.hits?.hits ?? [], total, totalRelation: relation, tookMs: res.took ?? 0 }
}

/* ---------- aliases ---------- */

export interface CatAlias {
  alias: string
  index: string
}

export async function fetchCatAliases(id: string): Promise<CatAlias[]> {
  const rows = await esJson<Record<string, string | null>[]>(id, {
    method: 'GET',
    path: '/_cat/aliases?format=json&h=alias,index'
  })
  // An alias spanning N indices appears N times in _cat/aliases — collapse to
  // one row per alias (the alias itself is what you search against).
  const byAlias = new Map<string, CatAlias>()
  for (const r of rows) {
    const alias = r.alias ?? ''
    if (!alias || alias.startsWith('.') || byAlias.has(alias)) continue
    byAlias.set(alias, { alias, index: r.index ?? '' })
  }
  return [...byAlias.values()].sort((a, b) => a.alias.localeCompare(b.alias))
}

export async function aliasAction(
  id: string,
  action: 'add' | 'remove',
  index: string,
  alias: string
): Promise<void> {
  await esJson(id, {
    method: 'POST',
    path: '/_aliases',
    body: { actions: [{ [action]: { index, alias } }] }
  })
}

/* ---------- index details & operations ---------- */

export interface IndexDetails {
  settings: unknown
  mappings: unknown
  aliases: string[]
}

export async function fetchIndexDetails(id: string, index: string): Promise<IndexDetails> {
  const enc = encodeURIComponent(index)
  const [settingsRes, mappingRes, aliasRes] = await Promise.all([
    esJson<Record<string, { settings?: unknown }>>(id, { method: 'GET', path: `/${enc}/_settings` }),
    esJson<Record<string, { mappings?: unknown }>>(id, { method: 'GET', path: `/${enc}/_mapping` }),
    esJson<Record<string, { aliases?: Record<string, unknown> }>>(id, {
      method: 'GET',
      path: `/${enc}/_alias`
    })
  ])
  const first = <T>(o: Record<string, T>): T | undefined => Object.values(o)[0]
  return {
    settings: first(settingsRes)?.settings ?? {},
    mappings: first(mappingRes)?.mappings ?? {},
    aliases: Object.keys(first(aliasRes)?.aliases ?? {})
  }
}

export type IndexOp = 'refresh' | 'flush' | 'forcemerge' | 'open' | 'close'

export const INDEX_OP_LABEL: Record<IndexOp, string> = {
  refresh: 'Refresh',
  flush: 'Flush',
  forcemerge: 'Force-merge',
  open: 'Open',
  close: 'Close'
}

export async function runIndexOp(id: string, index: string, op: IndexOp): Promise<void> {
  const path = `/${encodeURIComponent(index)}/_${op === 'forcemerge' ? 'forcemerge' : op}`
  await esJson(id, { method: 'POST', path })
}

export async function deleteIndex(id: string, index: string): Promise<void> {
  await esJson(id, { method: 'DELETE', path: `/${encodeURIComponent(index)}` })
}

export async function createIndex(id: string, index: string, body: unknown): Promise<void> {
  await esJson(id, { method: 'PUT', path: `/${encodeURIComponent(index)}`, body })
}

export async function putIndexSettings(id: string, index: string, settings: unknown): Promise<void> {
  await esJson(id, { method: 'PUT', path: `/${encodeURIComponent(index)}/_settings`, body: settings })
}

/* ---------- documents ---------- */

// These writes intentionally do NOT force a refresh. A forced refresh (or
// refresh=wait_for) can stall the response for seconds — or hang — on large or
// refresh-disabled indices, which froze the confirm dialog at "Working…". The
// UI instead reflects the change optimistically (see SearchTab) so the edit is
// visible immediately without waiting on ES's near-real-time refresh.
export async function saveDocument(
  id: string,
  index: string,
  docId: string,
  source: unknown
): Promise<void> {
  await esJson(id, {
    method: 'PUT',
    path: `/${encodeURIComponent(index)}/_doc/${encodeURIComponent(docId)}`,
    body: source
  })
}

/** Partial update: only the given top-level fields change, the rest are untouched. */
export async function updateDocument(
  id: string,
  index: string,
  docId: string,
  partial: Record<string, unknown>
): Promise<void> {
  await esJson(id, {
    method: 'POST',
    path: `/${encodeURIComponent(index)}/_update/${encodeURIComponent(docId)}`,
    body: { doc: partial }
  })
}

export async function deleteDocument(id: string, index: string, docId: string): Promise<void> {
  await esJson(id, {
    method: 'DELETE',
    path: `/${encodeURIComponent(index)}/_doc/${encodeURIComponent(docId)}`
  })
}

/* ---------- _cluster/allocation/explain ---------- */

export interface AllocationDecider {
  decider?: string
  decision?: string
  explanation?: string
}

export interface AllocationExplanation {
  index?: string
  shard?: number
  primary?: boolean
  current_state?: string
  unassigned_info?: { reason?: string; details?: string; at?: string }
  can_allocate?: string
  allocate_explanation?: string
  node_allocation_decisions?: {
    node_name?: string
    node_decision?: string
    deciders?: AllocationDecider[]
  }[]
}

export async function fetchAllocationExplain(
  id: string,
  target: { index: string; shard: number; primary: boolean }
): Promise<AllocationExplanation> {
  return esJson<AllocationExplanation>(id, {
    method: 'POST',
    path: '/_cluster/allocation/explain',
    body: target
  })
}
