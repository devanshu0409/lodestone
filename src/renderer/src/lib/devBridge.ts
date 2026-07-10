import type {
  ClusterConnection,
  ClusterOverview,
  EsRequestSpec,
  EsResponse,
  IpcResult,
  SaveConnectionPayload
} from '@shared/types'
import type { LodestoneApi } from '../../../preload'

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

function mockSearch(index: string, from: number, size: number): unknown {
  const total = 12_487
  const count = Math.max(0, Math.min(size, total - from))
  const hits = Array.from({ length: count }, (_, i) => {
    const n = from + i
    return {
      _index: index,
      _id: `doc-${String(n).padStart(6, '0')}`,
      _source: {
        '@timestamp': new Date(Date.parse('2026-07-09T06:00:00Z') - n * 47_000).toISOString(),
        level: LEVELS[n % LEVELS.length],
        service: SERVICES[n % SERVICES.length],
        message: MESSAGES[n % MESSAGES.length].replace('{n}', String(n)),
        bytes: 512 + ((n * 7919) % 48_000),
        duration_ms: Math.round(((n * 13) % 900) * 10) / 10,
        success: n % 7 !== 0,
        user: { id: `u-${(n * 31) % 5000}`, name: `User ${(n * 31) % 5000}` }
      }
    }
  })
  return {
    took: 4,
    hits: { total: { value: total, relation: 'eq' }, hits }
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
          const body = (spec.body ?? {}) as { from?: number; size?: number }
          return respond(mockSearch(target, body.from ?? 0, body.size ?? 25))
        }
        // Mutations (ops, create/delete index, doc save/delete) — acknowledge.
        if (spec.method !== 'GET' && spec.method !== 'HEAD')
          return respond({ acknowledged: true, result: 'ok (mock)' })
        return respond({})
      }
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
