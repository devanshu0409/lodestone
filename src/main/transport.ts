import http from 'node:http'
import https from 'node:https'
import { URL } from 'node:url'
import type {
  AuthConfig,
  ClusterConnection,
  ClusterHealth,
  ClusterInfo,
  ClusterStats,
  DiscoveredNode,
  Distribution,
  EsRequestSpec,
  EsResponse
} from '@shared/types'

const REQUEST_TIMEOUT_MS = 15_000

/**
 * Pluggable authentication. v1 ships none/basic; API keys, bearer tokens and
 * mTLS slot in here without touching any call site (FR-2.2).
 */
export interface AuthProvider {
  headers(): Record<string, string>
}

export function createAuthProvider(auth: AuthConfig, secret?: string): AuthProvider {
  switch (auth.type) {
    case 'basic': {
      const token = Buffer.from(`${auth.username ?? ''}:${secret ?? ''}`).toString('base64')
      return { headers: () => ({ Authorization: `Basic ${token}` }) }
    }
    case 'none':
      return { headers: () => ({}) }
  }
}

/** Errors that mean "this node is unreachable" and justify failing over to another node. */
const RETRYABLE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'REQUEST_TIMEOUT'
])

interface RawResponse {
  status: number
  body: string
}

function normalizeBaseUrl(raw: string): string {
  const url = new URL(raw.trim())
  // Strip any path/trailing slash — we only address nodes at their root.
  return `${url.protocol}//${url.host}`
}

function httpRequest(
  base: string,
  spec: EsRequestSpec,
  headers: Record<string, string>,
  insecureTls: boolean
): Promise<RawResponse> {
  return new Promise((resolvePromise, reject) => {
    const url = new URL(spec.path.startsWith('/') ? spec.path : `/${spec.path}`, base)
    const isHttps = url.protocol === 'https:'
    const mod = isHttps ? https : http
    const payload =
      spec.body === undefined || spec.body === null
        ? undefined
        : typeof spec.body === 'string'
          ? spec.body
          : JSON.stringify(spec.body)

    const req = mod.request(
      url,
      {
        method: spec.method,
        headers: {
          Accept: 'application/json',
          ...(payload !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...headers
        },
        timeout: REQUEST_TIMEOUT_MS,
        ...(isHttps && insecureTls ? { rejectUnauthorized: false } : {})
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () =>
          resolvePromise({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') })
        )
        res.on('error', reject)
      }
    )

    req.on('timeout', () => {
      req.destroy(Object.assign(new Error(`Request timed out after ${REQUEST_TIMEOUT_MS}ms`), { code: 'REQUEST_TIMEOUT' }))
    })
    req.on('error', reject)
    if (payload !== undefined) req.write(payload)
    req.end()
  })
}

function parseBody(raw: string): unknown {
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

export class TransportError extends Error {
  constructor(
    message: string,
    readonly attempts: { nodeUrl: string; error: string }[]
  ) {
    super(message)
  }
}

/**
 * One transport per registered cluster: owns the node pool, routes every
 * request to a healthy node, and fails over transparently on network errors.
 * Seed nodes always stay in the pool — discovered publish addresses may not
 * be routable from the user's machine (e.g. container-internal IPs).
 */
export class EsTransport {
  private pool: string[]
  private activeIndex = 0
  private readonly auth: AuthProvider
  private readonly insecureTls: boolean

  constructor(conn: ClusterConnection, secret?: string) {
    this.pool = [...new Set(conn.seeds.map(normalizeBaseUrl))]
    if (this.pool.length === 0) throw new Error('Connection has no seed nodes')
    this.auth = createAuthProvider(conn.auth, secret)
    this.insecureTls = conn.tls.insecure
  }

  get nodeUrls(): string[] {
    return [...this.pool]
  }

  async request(spec: EsRequestSpec): Promise<EsResponse> {
    const attempts: { nodeUrl: string; error: string }[] = []
    const started = Date.now()

    for (let i = 0; i < this.pool.length; i++) {
      const index = (this.activeIndex + i) % this.pool.length
      const node = this.pool[index]
      try {
        const raw = await httpRequest(node, spec, this.auth.headers(), this.insecureTls)
        this.activeIndex = index
        return {
          status: raw.status,
          ok: raw.status >= 200 && raw.status < 300,
          body: parseBody(raw.body),
          tookMs: Date.now() - started,
          nodeUrl: node
        }
      } catch (err) {
        const e = err as NodeJS.ErrnoException
        attempts.push({ nodeUrl: node, error: e.message })
        if (!RETRYABLE_CODES.has(e.code ?? '')) {
          throw new TransportError(`Request to ${node} failed: ${e.message}`, attempts)
        }
        // Unreachable node — try the next one in the pool.
      }
    }

    throw new TransportError(
      `All ${this.pool.length} node(s) unreachable: ${attempts.map((a) => `${a.nodeUrl} (${a.error})`).join('; ')}`,
      attempts
    )
  }

  /** GET / — identifies the cluster and detects the distribution (ES vs OpenSearch). */
  async ping(): Promise<{ clusterName: string; distribution: Distribution; version: string }> {
    const res = await this.request({ method: 'GET', path: '/' })
    if (!res.ok) {
      throw new Error(this.describeHttpError(res))
    }
    const body = res.body as {
      cluster_name?: string
      version?: { number?: string; distribution?: string }
    }
    const distribution: Distribution =
      body.version?.distribution === 'opensearch' ? 'opensearch' : 'elasticsearch'
    return {
      clusterName: body.cluster_name ?? 'unknown',
      distribution,
      version: body.version?.number ?? 'unknown'
    }
  }

  /**
   * Expand the pool via the cluster's own view of its topology (_nodes/http).
   * Fixes elasticsearch-head's single-node blind spot: one seed is enough.
   */
  async discover(): Promise<DiscoveredNode[]> {
    const res = await this.request({ method: 'GET', path: '/_nodes/http' })
    if (!res.ok) return [] // e.g. restricted user without monitor privilege — keep seeds only
    const body = res.body as {
      nodes?: Record<
        string,
        { name?: string; version?: string; roles?: string[]; http?: { publish_address?: string } }
      >
    }
    const scheme = new URL(this.pool[0]).protocol
    const nodes: DiscoveredNode[] = []

    for (const [id, node] of Object.entries(body.nodes ?? {})) {
      const publish = node.http?.publish_address
      if (!publish) continue
      // publish_address is "host:port" or "hostname/ip:port" — prefer the part after "/".
      const hostPort = publish.includes('/') ? publish.slice(publish.indexOf('/') + 1) : publish
      const url = `${scheme}//${hostPort}`
      nodes.push({
        id,
        name: node.name ?? id,
        url,
        roles: node.roles ?? [],
        version: node.version ?? 'unknown'
      })
    }

    if (nodes.length > 0) {
      const seeds = this.pool
      this.pool = [...new Set([...seeds, ...nodes.map((n) => n.url)])]
    }
    return nodes
  }

  async health(): Promise<ClusterHealth> {
    const res = await this.request({ method: 'GET', path: '/_cluster/health' })
    if (!res.ok) throw new Error(this.describeHttpError(res))
    const b = res.body as Record<string, unknown>
    return {
      status: (b.status as ClusterHealth['status']) ?? 'red',
      numberOfNodes: Number(b.number_of_nodes ?? 0),
      numberOfDataNodes: Number(b.number_of_data_nodes ?? 0),
      activePrimaryShards: Number(b.active_primary_shards ?? 0),
      activeShards: Number(b.active_shards ?? 0),
      relocatingShards: Number(b.relocating_shards ?? 0),
      initializingShards: Number(b.initializing_shards ?? 0),
      unassignedShards: Number(b.unassigned_shards ?? 0),
      pendingTasks: Number(b.number_of_pending_tasks ?? 0),
      activeShardsPercent: Number(b.active_shards_percent_as_number ?? 0)
    }
  }

  async stats(): Promise<ClusterStats> {
    const res = await this.request({ method: 'GET', path: '/_cluster/stats' })
    if (!res.ok) throw new Error(this.describeHttpError(res))
    const b = res.body as {
      indices?: { count?: number; docs?: { count?: number }; store?: { size_in_bytes?: number } }
    }
    return {
      indices: b.indices?.count ?? 0,
      docs: b.indices?.docs?.count ?? 0,
      storeBytes: b.indices?.store?.size_in_bytes ?? 0
    }
  }

  async describe(): Promise<ClusterInfo> {
    const identity = await this.ping()
    const nodes = await this.discover()
    return { ...identity, nodes }
  }

  private describeHttpError(res: EsResponse): string {
    if (res.status === 401) return 'Authentication failed (401) — check username/password'
    if (res.status === 403) return 'Not authorized (403) — the user lacks required privileges'
    const reason =
      typeof res.body === 'object' && res.body !== null
        ? ((res.body as { error?: { reason?: string } }).error?.reason ?? JSON.stringify(res.body).slice(0, 200))
        : String(res.body).slice(0, 200)
    return `Cluster responded with HTTP ${res.status}: ${reason}`
  }
}
