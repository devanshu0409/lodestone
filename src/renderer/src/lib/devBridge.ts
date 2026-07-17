import type {
  ClusterConnection,
  ClusterOverview,
  EsRequestSpec,
  EsResponse,
  IpcResult,
  SaveConnectionPayload,
  UpdateStatus
} from '@shared/types'
import type { LodestoneApi } from '../../../preload/api'

/**
 * In-memory stand-in for the Electron IPC bridge so the renderer can run in a
 * plain browser (vite dev / UI review) — dev builds only, and only when the
 * real preload bridge is absent.
 */

interface MockIndexSpec {
  index: string
  pri: number
  rep: number
  health: 'green' | 'yellow' | 'red'
  docs: number
  bytes: number
  unassignedReplicas?: number
  relocating?: boolean
  initializing?: boolean
}

const PROD_NODES = ['es1-prod', 'es2-prod', 'es3-prod']
const STAGING_NODES = ['os-node-1']

const PROD_INDICES: MockIndexSpec[] = [
  { index: 'products', pri: 3, rep: 1, health: 'green', docs: 1_204_500, bytes: 3_221_225_472 },
  { index: 'orders-2026.07', pri: 2, rep: 1, health: 'green', docs: 844_120, bytes: 2_147_483_648 },
  {
    index: 'logs-2026.07.09',
    pri: 4,
    rep: 1,
    health: 'yellow',
    docs: 96_412_003,
    bytes: 214_748_364_800,
    unassignedReplicas: 3,
    relocating: true,
    initializing: true
  },
  { index: 'logs-2026.07.08', pri: 4, rep: 1, health: 'green', docs: 81_204_776, bytes: 188_978_561_024 },
  { index: 'sessions', pri: 1, rep: 2, health: 'green', docs: 51_230, bytes: 104_857_600 },
  { index: 'metrics-rollup', pri: 2, rep: 0, health: 'green', docs: 5_812_400, bytes: 10_737_418_240 },
  { index: '.kibana_8.13.4_001', pri: 1, rep: 1, health: 'green', docs: 2_150, bytes: 5_242_880 },
  { index: '.security-7', pri: 1, rep: 1, health: 'green', docs: 120, bytes: 1_048_576 }
]

const STAGING_INDICES: MockIndexSpec[] = [
  {
    index: 'logs-app',
    pri: 2,
    rep: 1,
    health: 'yellow',
    docs: 2_204_112,
    bytes: 4_294_967_296,
    unassignedReplicas: 2
  },
  { index: 'traces', pri: 1, rep: 0, health: 'green', docs: 180_000, bytes: 1_073_741_824 },
  { index: '.opensearch-dashboards_1', pri: 1, rep: 0, health: 'green', docs: 90, bytes: 524_288 }
]

function catShards(specs: MockIndexSpec[], nodes: string[]): Record<string, string>[] {
  const rows: Record<string, string>[] = []
  for (const s of specs) {
    const docsPerShard = Math.floor(s.docs / s.pri)
    const bytesPerShard = Math.floor(s.bytes / (s.pri * (s.rep + 1)))
    let unassignedLeft = s.unassignedReplicas ?? 0
    let initializingLeft = s.initializing ? 1 : 0

    for (let p = 0; p < s.pri; p++) {
      const primaryNode = nodes[p % nodes.length]
      const relocating = s.relocating && p === 0 && nodes.length > 1
      rows.push({
        index: s.index,
        shard: String(p),
        prirep: 'p',
        state: relocating ? 'RELOCATING' : 'STARTED',
        docs: String(docsPerShard),
        store: String(bytesPerShard),
        node: relocating ? `${primaryNode} -> 10.0.0.12 kX2b3F ${nodes[1]}` : primaryNode
      })
      for (let r = 1; r <= s.rep; r++) {
        if (unassignedLeft > 0) {
          unassignedLeft--
          rows.push({
            index: s.index,
            shard: String(p),
            prirep: 'r',
            state: 'UNASSIGNED',
            docs: '',
            store: '',
            node: ''
          })
          continue
        }
        const initializing = initializingLeft > 0
        if (initializing) initializingLeft--
        rows.push({
          index: s.index,
          shard: String(p),
          prirep: 'r',
          state: initializing ? 'INITIALIZING' : 'STARTED',
          docs: String(docsPerShard),
          store: String(bytesPerShard),
          node: nodes[(p + r) % nodes.length]
        })
      }
    }
  }
  return rows
}

function catIndices(specs: MockIndexSpec[]): Record<string, string>[] {
  return specs.map((s) => ({
    index: s.index,
    health: s.health,
    status: 'open',
    pri: String(s.pri),
    rep: String(s.rep),
    'docs.count': String(s.docs),
    'store.size': String(s.bytes)
  }))
}

function catNodes(isProd: boolean): Record<string, string>[] {
  if (isProd) {
    return [
      { name: 'es1-prod', ip: '10.0.0.11', version: '8.13.4', 'node.role': 'dim', master: '*', 'heap.percent': '58', 'ram.percent': '81', cpu: '14', 'disk.used_percent': '52' },
      { name: 'es2-prod', ip: '10.0.0.12', version: '8.13.4', 'node.role': 'dim', master: '-', 'heap.percent': '77', 'ram.percent': '85', cpu: '22', 'disk.used_percent': '68' },
      { name: 'es3-prod', ip: '10.0.0.13', version: '8.13.4', 'node.role': 'di', master: '-', 'heap.percent': '91', 'ram.percent': '88', cpu: '35', 'disk.used_percent': '93' }
    ]
  }
  return [
    { name: 'os-node-1', ip: '10.1.0.5', version: '2.13.0', 'node.role': 'dim', cluster_manager: '*', 'heap.percent': '44', 'ram.percent': '61', cpu: '8', 'disk.used_percent': '37' }
  ]
}

const MOCK_MAPPING = {
  properties: {
    '@timestamp': { type: 'date' },
    level: { type: 'keyword' },
    message: { type: 'text', fields: { keyword: { type: 'keyword', ignore_above: 256 } } },
    service: { type: 'keyword' },
    // Array-valued in _source (like real ES tags) — exercises array join keys.
    tags: { type: 'keyword' },
    bytes: { type: 'long' },
    duration_ms: { type: 'float' },
    success: { type: 'boolean' },
    user: {
      properties: {
        id: { type: 'keyword' },
        name: { type: 'text', fields: { keyword: { type: 'keyword' } } }
      }
    }
  }
}

const LEVELS = ['info', 'info', 'info', 'warn', 'error', 'debug']
const SERVICES = ['checkout', 'search-api', 'auth', 'catalog', 'payments']
const MESSAGES = [
  'request completed',
  'cache miss for key user:{n}',
  'retrying upstream call (attempt 2)',
  'slow query detected',
  'connection pool exhausted, queuing request',
  'user session refreshed'
]

const MOCK_TOTAL = 12_487

function mockSource(n: number): Record<string, unknown> {
  return {
    '@timestamp': new Date(Date.parse('2026-07-09T06:00:00Z') - n * 47_000).toISOString(),
    level: LEVELS[n % LEVELS.length],
    service: SERVICES[n % SERVICES.length],
    tags: [SERVICES[n % SERVICES.length], LEVELS[n % LEVELS.length]],
    message: MESSAGES[n % MESSAGES.length].replace('{n}', String(n)),
    bytes: 512 + ((n * 7919) % 48_000),
    duration_ms: Math.round(((n * 13) % 900) * 10) / 10,
    success: n % 7 !== 0,
    user: { id: `u-${(n * 31) % 5000}`, name: `User ${(n * 31) % 5000}` }
  }
}

/** Resolve "user.id" / "service.keyword" style paths against a source doc. */
function mockFieldValue(source: Record<string, unknown>, field: string): unknown {
  const path = field.endsWith('.keyword') ? field.slice(0, -'.keyword'.length) : field
  let v: unknown = source
  for (const seg of path.split('.')) {
    if (v === null || typeof v !== 'object') return undefined
    v = (v as Record<string, unknown>)[seg]
  }
  return v
}

interface MockAggSpec {
  terms?: { field: string; size?: number }
  significant_terms?: { field: string; size?: number }
  missing?: { field: string }
  histogram?: { field: string; interval: number }
  date_histogram?: { field: string; calendar_interval?: string }
  range?: { field: string; ranges: { from?: number; to?: number }[] }
  avg?: { field: string }
  sum?: { field: string }
  min?: { field: string }
  max?: { field: string }
  value_count?: { field: string }
  cardinality?: { field: string }
  stats?: { field: string }
  percentiles?: { field: string }
  aggs?: Record<string, MockAggSpec>
}

/* ---------- query evaluation (the shapes our filter builder emits) ---------- */

type MockQuery = Record<string, unknown>

const asArray = (v: unknown): MockQuery[] =>
  v === undefined ? [] : Array.isArray(v) ? (v as MockQuery[]) : [v as MockQuery]

/** First [field, spec] pair of a leaf clause like { term: { level: "error" } }. */
function leaf(q: MockQuery, kind: string): [string, unknown] | null {
  const body = q[kind]
  if (!body || typeof body !== 'object') return null
  const entries = Object.entries(body as Record<string, unknown>)
  return entries.length ? [entries[0][0], entries[0][1]] : null
}

function cmp(field: unknown, bound: unknown): number | null {
  const fs = String(field)
  const bs = String(bound)
  const fDate = Date.parse(fs)
  const bDate = Date.parse(bs)
  if (Number.isFinite(fDate) && Number.isFinite(bDate) && /[-:TZ]/.test(fs)) return fDate - bDate
  const fn = Number(field)
  const bn = Number(bound)
  if (Number.isFinite(fn) && Number.isFinite(bn)) return fn - bn
  return fs < bs ? -1 : fs > bs ? 1 : 0
}

function mockMatches(source: Record<string, unknown>, q: MockQuery | undefined): boolean {
  if (!q || 'match_all' in q) return true
  if ('bool' in q) {
    const b = q.bool as Record<string, unknown>
    for (const c of asArray(b.filter)) if (!mockMatches(source, c)) return false
    for (const c of asArray(b.must)) if (!mockMatches(source, c)) return false
    for (const c of asArray(b.must_not)) if (mockMatches(source, c)) return false
    const should = asArray(b.should)
    if (should.length > 0) {
      const hasOthers =
        asArray(b.filter).length > 0 || asArray(b.must).length > 0 || asArray(b.must_not).length > 0
      const min = typeof b.minimum_should_match === 'number' ? b.minimum_should_match : hasOthers ? 0 : 1
      if (min > 0 && !should.some((c) => mockMatches(source, c))) return false
    }
    return true
  }
  let l: [string, unknown] | null
  if ((l = leaf(q, 'term'))) {
    const want = typeof l[1] === 'object' && l[1] !== null ? (l[1] as { value?: unknown }).value : l[1]
    const have = mockFieldValue(source, l[0])
    // Like real ES: an array-valued field matches if any element matches.
    return (Array.isArray(have) ? have : [have]).some((h) => String(h) === String(want))
  }
  if ((l = leaf(q, 'terms'))) {
    const wants = Array.isArray(l[1]) ? l[1] : []
    const have = mockFieldValue(source, l[0])
    const haves = (Array.isArray(have) ? have : [have]).map(String)
    return wants.some((w) => haves.includes(String(w)))
  }
  if ((l = leaf(q, 'match')) || (l = leaf(q, 'match_phrase'))) {
    const want = typeof l[1] === 'object' && l[1] !== null ? (l[1] as { query?: unknown }).query : l[1]
    return String(mockFieldValue(source, l[0]) ?? '').toLowerCase().includes(String(want).toLowerCase())
  }
  if ((l = leaf(q, 'wildcard'))) {
    const pat = typeof l[1] === 'object' && l[1] !== null ? (l[1] as { value?: unknown }).value : l[1]
    const re = new RegExp(`^${String(pat).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i')
    return re.test(String(mockFieldValue(source, l[0]) ?? ''))
  }
  if ((l = leaf(q, 'prefix'))) {
    const want = typeof l[1] === 'object' && l[1] !== null ? (l[1] as { value?: unknown }).value : l[1]
    return String(mockFieldValue(source, l[0]) ?? '').toLowerCase().startsWith(String(want).toLowerCase())
  }
  if ((l = leaf(q, 'fuzzy'))) {
    const want = typeof l[1] === 'object' && l[1] !== null ? (l[1] as { value?: unknown }).value : l[1]
    const have = String(mockFieldValue(source, l[0]) ?? '').toLowerCase()
    const w = String(want).toLowerCase()
    return have === w || have.startsWith(w.slice(0, Math.max(1, w.length - 1)))
  }
  if ((l = leaf(q, 'regexp'))) {
    const pat = typeof l[1] === 'object' && l[1] !== null ? (l[1] as { value?: unknown }).value : l[1]
    try {
      return new RegExp(`^${String(pat)}$`).test(String(mockFieldValue(source, l[0]) ?? ''))
    } catch {
      return false
    }
  }
  if ((l = leaf(q, 'range'))) {
    const v = mockFieldValue(source, l[0])
    if (v === undefined) return false
    const r = l[1] as { gt?: unknown; gte?: unknown; lt?: unknown; lte?: unknown }
    if (r.gt !== undefined && (cmp(v, r.gt) ?? -1) <= 0) return false
    if (r.gte !== undefined && (cmp(v, r.gte) ?? -1) < 0) return false
    if (r.lt !== undefined && (cmp(v, r.lt) ?? 1) >= 0) return false
    if (r.lte !== undefined && (cmp(v, r.lte) ?? 1) > 0) return false
    return true
  }
  if ('exists' in q) {
    const field = (q.exists as { field?: string }).field ?? ''
    return mockFieldValue(source, field) !== undefined
  }
  return true // unknown clause — don't filter on it
}

const CAL_MS: Record<string, number> = {
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 7 * 86_400_000,
  month: 30 * 86_400_000,
  quarter: 91 * 86_400_000,
  year: 365 * 86_400_000
}

function mockMetric(spec: MockAggSpec, docs: Record<string, unknown>[]): unknown {
  const one = <K extends keyof MockAggSpec>(k: K): { field: string } | undefined =>
    spec[k] as { field: string } | undefined
  const nums = (field: string): number[] =>
    docs.map((d) => Number(mockFieldValue(d, field))).filter((v) => Number.isFinite(v))
  if (one('avg')) {
    const v = nums(one('avg')!.field)
    return { value: v.length ? v.reduce((a, b) => a + b, 0) / v.length : null }
  }
  if (one('sum')) return { value: nums(one('sum')!.field).reduce((a, b) => a + b, 0) }
  if (one('min')) { const v = nums(one('min')!.field); return { value: v.length ? Math.min(...v) : null } }
  if (one('max')) { const v = nums(one('max')!.field); return { value: v.length ? Math.max(...v) : null } }
  if (one('value_count'))
    return { value: docs.filter((d) => mockFieldValue(d, one('value_count')!.field) !== undefined).length }
  if (one('cardinality'))
    return { value: new Set(docs.map((d) => mockFieldValue(d, one('cardinality')!.field)).filter((v) => v !== undefined)).size }
  if (one('stats')) {
    const v = nums(one('stats')!.field)
    const sum = v.reduce((a, b) => a + b, 0)
    return {
      count: v.length,
      min: v.length ? Math.min(...v) : null,
      max: v.length ? Math.max(...v) : null,
      avg: v.length ? sum / v.length : null,
      sum
    }
  }
  if (one('percentiles')) {
    const v = nums(one('percentiles')!.field).sort((a, b) => a - b)
    const p = (q: number): number | null => (v.length ? v[Math.min(v.length - 1, Math.floor((q / 100) * v.length))] : null)
    return { values: { '1.0': p(1), '25.0': p(25), '50.0': p(50), '75.0': p(75), '95.0': p(95), '99.0': p(99) } }
  }
  return null
}

function mockAggregations(
  aggs: Record<string, MockAggSpec>,
  docs: Record<string, unknown>[]
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [name, spec] of Object.entries(aggs)) {
    const bucketDef =
      spec.terms ?? spec.significant_terms ?? spec.histogram ?? spec.date_histogram ?? spec.range ?? spec.missing
    if (bucketDef) {
      let buckets: { key: unknown; key_as_string?: string; docs: Record<string, unknown>[] }[] = []
      if (spec.terms || spec.significant_terms) {
        const { field, size = 10 } = (spec.terms ?? spec.significant_terms)!
        const groups = new Map<string, Record<string, unknown>[]>()
        for (const d of docs) {
          const v = mockFieldValue(d, field)
          if (v === undefined) continue
          const key = String(v)
          groups.set(key, [...(groups.get(key) ?? []), d])
        }
        buckets = [...groups.entries()]
          .sort((a, b) => b[1].length - a[1].length)
          .slice(0, size)
          .map(([key, ds]) => ({ key, docs: ds }))
      } else if (spec.histogram) {
        const { field, interval } = spec.histogram
        const groups = new Map<number, Record<string, unknown>[]>()
        for (const d of docs) {
          const v = Number(mockFieldValue(d, field))
          if (!Number.isFinite(v)) continue
          const key = Math.floor(v / interval) * interval
          groups.set(key, [...(groups.get(key) ?? []), d])
        }
        buckets = [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([key, ds]) => ({ key, docs: ds }))
      } else if (spec.date_histogram) {
        const { field, calendar_interval = 'day' } = spec.date_histogram
        const ms = CAL_MS[calendar_interval] ?? CAL_MS.day
        const groups = new Map<number, Record<string, unknown>[]>()
        for (const d of docs) {
          const t = Date.parse(String(mockFieldValue(d, field)))
          if (!Number.isFinite(t)) continue
          const key = Math.floor(t / ms) * ms
          groups.set(key, [...(groups.get(key) ?? []), d])
        }
        buckets = [...groups.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([key, ds]) => ({ key, key_as_string: new Date(key).toISOString(), docs: ds }))
      } else if (spec.range) {
        const { field, ranges } = spec.range
        buckets = ranges.map((r) => {
          const ds = docs.filter((d) => {
            const v = Number(mockFieldValue(d, field))
            if (!Number.isFinite(v)) return false
            return (r.from === undefined || v >= r.from) && (r.to === undefined || v < r.to)
          })
          const key = `${r.from ?? '*'}-${r.to ?? '*'}`
          return { key, docs: ds }
        })
      } else if (spec.missing) {
        const { field } = spec.missing
        buckets = [{ key: 'missing', docs: docs.filter((d) => mockFieldValue(d, field) === undefined) }]
      }
      out[name] = {
        buckets: buckets.map((b) => ({
          key: b.key,
          ...(b.key_as_string ? { key_as_string: b.key_as_string } : {}),
          doc_count: b.docs.length,
          ...(spec.aggs ? mockAggregations(spec.aggs, b.docs) : {})
        }))
      }
    } else {
      out[name] = mockMetric(spec, docs)
    }
  }
  return out
}

function mockSearch(
  index: string,
  from: number,
  size: number,
  aggs?: Record<string, MockAggSpec>,
  query?: MockQuery
): unknown {
  // Materialize + filter the whole corpus so totals, hits and aggregations all
  // reflect the query — the mock behaves like a real cluster would.
  const all = Array.from({ length: MOCK_TOTAL }, (_, n) => ({ n, source: mockSource(n) }))
  const matched = query ? all.filter((d) => mockMatches(d.source, query)) : all
  const hits = matched.slice(from, from + size).map((d) => ({
    _index: index,
    _id: `doc-${String(d.n).padStart(6, '0')}`,
    _source: d.source
  }))
  let aggregations: Record<string, unknown> | undefined
  if (aggs && Object.keys(aggs).length > 0) {
    aggregations = mockAggregations(aggs, matched.map((d) => d.source))
  }
  return {
    took: 4,
    hits: { total: { value: matched.length, relation: 'eq' }, hits },
    ...(aggregations ? { aggregations } : {})
  }
}

const EXPLAIN_RESPONSE = {
  index: 'logs-2026.07.09',
  shard: 0,
  primary: false,
  current_state: 'unassigned',
  unassigned_info: {
    reason: 'NODE_LEFT',
    at: '2026-07-09T06:10:11.201Z',
    details: 'node_left [es3-prod]'
  },
  can_allocate: 'no',
  allocate_explanation:
    'Elasticsearch is not allowed to allocate this shard to any of the nodes in the cluster. Choose a node to which you expect this shard to be allocated, find this node in the node-by-node explanation, and address the reasons which prevent Elasticsearch from allocating this shard there.',
  node_allocation_decisions: [
    {
      node_name: 'es1-prod',
      node_decision: 'no',
      deciders: [
        {
          decider: 'same_shard',
          decision: 'NO',
          explanation:
            'a copy of this shard is already allocated to this node [[logs-2026.07.09][0], node[es1-prod], [P], s[STARTED]]'
        }
      ]
    },
    {
      node_name: 'es2-prod',
      node_decision: 'no',
      deciders: [
        {
          decider: 'disk_threshold',
          decision: 'NO',
          explanation:
            'the node is above the low watermark cluster setting [cluster.routing.allocation.disk.watermark.low=85%], having less than the minimum required free space'
        }
      ]
    },
    {
      node_name: 'es3-prod',
      node_decision: 'no',
      deciders: [
        {
          decider: 'disk_threshold',
          decision: 'NO',
          explanation:
            'the node is above the high watermark cluster setting [cluster.routing.allocation.disk.watermark.high=90%]'
        }
      ]
    }
  ]
}

export function installDevBridge(): void {
  if (!import.meta.env.DEV || 'lodestone' in window) return

  const connections: ClusterConnection[] = [
    {
      id: 'demo-logs',
      name: 'logs — staging',
      seeds: ['http://es-staging.internal:9200'],
      auth: { type: 'none' },
      tls: { insecure: false },
      readOnly: false,
      group: 'Staging',
      color: '#35b5a7',
      hasSecret: false
    },
    {
      id: 'demo-prod',
      name: 'search — production',
      seeds: ['https://es1.prod.internal:9200', 'https://es2.prod.internal:9200'],
      auth: { type: 'basic', username: 'ops' },
      tls: { insecure: true },
      readOnly: true,
      group: 'Production',
      color: '#e0625c',
      hasSecret: true
    }
  ]

  const ok = <T>(data: T): IpcResult<T> => ({ ok: true, data })

  const overviewFor = (id: string): ClusterOverview =>
    id === 'demo-prod'
      ? {
          info: {
            clusterName: 'search-prod',
            distribution: 'elasticsearch',
            version: '8.13.4',
            nodes: [
              { id: 'n1', name: 'es1-prod', url: 'https://es1.prod.internal:9200', roles: ['master', 'data'], version: '8.13.4' },
              { id: 'n2', name: 'es2-prod', url: 'https://es2.prod.internal:9200', roles: ['master', 'data'], version: '8.13.4' },
              { id: 'n3', name: 'es3-prod', url: 'https://es3.prod.internal:9200', roles: ['data', 'ingest'], version: '8.13.4' }
            ]
          },
          health: {
            status: 'yellow',
            numberOfNodes: 3,
            numberOfDataNodes: 3,
            activePrimaryShards: 412,
            activeShards: 810,
            relocatingShards: 1,
            initializingShards: 1,
            unassignedShards: 3,
            pendingTasks: 1,
            activeShardsPercent: 98.3
          },
          stats: { indices: 206, docs: 184_530_211, storeBytes: 412_316_860_416 }
        }
      : {
          info: {
            clusterName: 'logs-staging',
            distribution: 'opensearch',
            version: '2.13.0',
            nodes: [
              { id: 'n1', name: 'os-node-1', url: 'http://es-staging.internal:9200', roles: ['cluster_manager', 'data', 'ingest'], version: '2.13.0' }
            ]
          },
          health: {
            status: 'yellow',
            numberOfNodes: 1,
            numberOfDataNodes: 1,
            activePrimaryShards: 38,
            activeShards: 38,
            relocatingShards: 0,
            initializingShards: 0,
            unassignedShards: 2,
            pendingTasks: 0,
            activeShardsPercent: 95
          },
          stats: { indices: 19, docs: 2_384_112, storeBytes: 5_368_709_120 }
        }

  const respond = (body: unknown): IpcResult<EsResponse> =>
    ok({ status: 200, ok: true, body, tookMs: 3, nodeUrl: 'mock://cluster' })

  /** Minimal SELECT parser so Raw SQL mode demos offline:
   *  SELECT cols FROM idx [WHERE field = 'value'] [LIMIT n] */
  const ALL_COLS = ['@timestamp', 'level', 'service', 'message', 'bytes', 'duration_ms', 'success', 'user.id', 'user.name']
  function mockSql(query: string, osDialect: boolean): unknown {
    const m = query
      .replace(/\s+/g, ' ')
      .trim()
      .match(/^select (.+?) from (\S+)(?: where (\S+) ?= ?'?([^' ]+)'?)?(?: limit (\d+))?$/i)
    if (!m) {
      return { error: { reason: `mock _sql only understands: SELECT cols FROM index [WHERE field = 'value'] [LIMIT n]` }, status: 400 }
    }
    const cols = m[1].trim() === '*' ? ALL_COLS : m[1].split(',').map((c) => c.trim())
    const [whereField, whereValue, limit] = [m[3], m[4], Number(m[5] ?? 25)]
    const rows: unknown[][] = []
    for (let n = 0; n < MOCK_TOTAL && rows.length < limit; n++) {
      const src = mockSource(n)
      if (whereField && String(mockFieldValue(src, whereField)) !== whereValue) continue
      rows.push(cols.map((c) => {
        const v = mockFieldValue(src, c)
        return v !== null && typeof v === 'object' ? JSON.stringify(v) : (v ?? null)
      }))
    }
    const colDefs = cols.map((name) => ({ name, type: 'keyword' }))
    return osDialect ? { schema: colDefs, datarows: rows } : { columns: colDefs, rows }
  }

  const api: LodestoneApi = {
    connections: {
      list: async () => ok([...connections]),
      save: async (payload: SaveConnectionPayload) => {
        const saved: ClusterConnection = {
          ...payload.connection,
          hasSecret: typeof payload.secret === 'string' && payload.secret.length > 0
        }
        const i = connections.findIndex((c) => c.id === saved.id)
        if (i >= 0) connections[i] = saved
        else connections.push(saved)
        return ok(saved)
      },
      delete: async (id: string) => {
        const i = connections.findIndex((c) => c.id === id)
        if (i >= 0) connections.splice(i, 1)
        return ok(undefined)
      },
      test: async () => ok({ ok: true, message: 'Connected to "demo" — elasticsearch 8.13.4 (mock)' })
    },
    cluster: {
      connect: async (id: string) => {
        await new Promise((r) => setTimeout(r, 400))
        return ok(overviewFor(id))
      },
      disconnect: async () => ok(undefined),
      request: async (id: string, spec: EsRequestSpec): Promise<IpcResult<EsResponse>> => {
        const isProd = id === 'demo-prod'
        const path = spec.path.split('?')[0]
        // Raw-SQL passthrough endpoints (a tiny SELECT subset, demo only).
        if (path === '/_sql' || path === '/_plugins/_sql') {
          const q = (spec.body as { query?: string } | undefined)?.query ?? ''
          return respond(mockSql(q, path.startsWith('/_plugins')))
        }
        if (path.startsWith('/_cat/nodes')) return respond(catNodes(isProd))
        if (path.startsWith('/_cat/indices'))
          return respond(catIndices(isProd ? PROD_INDICES : STAGING_INDICES))
        if (path.startsWith('/_cat/shards'))
          return respond(
            catShards(isProd ? PROD_INDICES : STAGING_INDICES, isProd ? PROD_NODES : STAGING_NODES)
          )
        if (path.startsWith('/_cat/aliases'))
          return respond(
            isProd
              ? [
                  { alias: 'logs', index: 'logs-2026.07.09' },
                  { alias: 'logs', index: 'logs-2026.07.08' }
                ]
              : [{ alias: 'app', index: 'logs-app' }]
          )
        if (path.startsWith('/_cluster/allocation/explain')) return respond(EXPLAIN_RESPONSE)
        if (path === '/_cluster/health')
          return respond({
            cluster_name: isProd ? 'search-prod' : 'logs-staging',
            status: 'yellow',
            number_of_nodes: isProd ? 3 : 1,
            active_shards: isProd ? 810 : 38,
            unassigned_shards: isProd ? 3 : 2
          })
        if (path === '/' || path === '')
          return respond({
            name: isProd ? 'es1-prod' : 'os-node-1',
            cluster_name: isProd ? 'search-prod' : 'logs-staging',
            version: {
              number: isProd ? '8.13.4' : '2.13.0',
              distribution: isProd ? undefined : 'opensearch'
            },
            tagline: 'You Know, for Search'
          })

        // Index-scoped endpoints: /{index}/_suffix
        const seg = path.split('/').filter(Boolean)
        const [target, sub] = [seg[0] ? decodeURIComponent(seg[0]) : '', seg[1] ?? '']
        if (sub === '_mapping') return respond({ [target]: { mappings: MOCK_MAPPING } })
        if (sub === '_settings')
          return respond({
            [target]: {
              settings: {
                index: {
                  number_of_shards: '3',
                  number_of_replicas: '1',
                  refresh_interval: '1s',
                  uuid: 'mock-uuid',
                  creation_date: '1751990000000',
                  provided_name: target,
                  version: { created: '8505000' }
                }
              }
            }
          })
        if (sub === '_alias')
          return respond({ [target]: { aliases: target.startsWith('logs-') ? { logs: {} } : {} } })
        if (sub === '_search') {
          const body = (spec.body ?? {}) as {
            from?: number
            size?: number
            query?: MockQuery
            aggs?: Record<string, MockAggSpec>
            aggregations?: Record<string, MockAggSpec>
          }
          return respond(
            mockSearch(
              target,
              body.from ?? 0,
              body.size ?? 25,
              body.aggs ?? body.aggregations,
              body.query
            )
          )
        }
        // Mutations (ops, create/delete index, doc save/delete) — acknowledge.
        if (spec.method !== 'GET' && spec.method !== 'HEAD')
          return respond({ acknowledged: true, result: 'ok (mock)' })
        return respond({})
      }
    },
    updater: {
      checkForUpdates: async () => ok(undefined),
      downloadUpdate: async () => ok(undefined),
      quitAndInstall: async () => ok(undefined),
      onStatus: (_cb: (status: UpdateStatus) => void) => () => {}
    }
  }

  ;(window as unknown as { lodestone: LodestoneApi }).lodestone = api

  // Loud banner so a browser preview is never mistaken for the real app.
  const banner = document.createElement('div')
  banner.textContent = 'UI PREVIEW — MOCK DATA, NOT CONNECTED TO ANY CLUSTER'
  banner.style.cssText =
    'position:fixed;bottom:12px;right:12px;z-index:9999;pointer-events:none;' +
    'font:700 10px/1 "JetBrains Mono",monospace;letter-spacing:.08em;' +
    'padding:6px 10px;border-radius:4px;color:#7a5205;background:#ffd764;border:1px solid #b97a10'
  document.body.appendChild(banner)
}
