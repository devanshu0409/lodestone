import type {
  ClusterOverview,
  EsRequestSpec,
  EsResponse,
  TestConnectionResult,
  SaveConnectionPayload
} from '@shared/types'
import { EsTransport } from './transport'
import type { ConnectionStore } from './store'

/**
 * POST endpoints that only read data — allowed even on read-only connections.
 * Everything else that is not GET/HEAD is treated as mutating.
 */
const READONLY_POST_ALLOWLIST =
  /(^|\/)(_search|_async_search|_msearch|_count|_explain|_validate|_field_caps|_analyze|_mget|_terms_enum|_search\/template|_render\/template|_sql|_eql|_cluster\/allocation\/explain)([/?]|$)/

function isReadAllowed(spec: EsRequestSpec): boolean {
  if (spec.method === 'GET' || spec.method === 'HEAD') return true
  if (spec.method === 'POST') {
    const path = spec.path.split('?')[0]
    return READONLY_POST_ALLOWLIST.test(path)
  }
  return false
}

/** Owns one live transport per connected cluster and enforces the read-only guard. */
export class ClusterManager {
  private transports = new Map<string, EsTransport>()

  constructor(private store: ConnectionStore) {}

  private transportFor(id: string): EsTransport {
    const existing = this.transports.get(id)
    if (existing) return existing
    const conn = this.store.get(id)
    if (!conn) throw new Error('Unknown connection')
    const transport = new EsTransport(conn, this.store.getSecret(id))
    this.transports.set(id, transport)
    return transport
  }

  async connect(id: string): Promise<ClusterOverview> {
    // Rebuild the transport so edited settings (seeds, auth) take effect.
    this.transports.delete(id)
    const transport = this.transportFor(id)
    const info = await transport.describe()
    const [health, stats] = await Promise.all([transport.health(), transport.stats()])
    return { info, health, stats }
  }

  disconnect(id: string): void {
    this.transports.delete(id)
  }

  async request(id: string, spec: EsRequestSpec): Promise<EsResponse> {
    const conn = this.store.get(id)
    if (!conn) throw new Error('Unknown connection')
    if (conn.readOnly && !isReadAllowed(spec)) {
      throw new Error(
        `Blocked: "${conn.name}" is marked read-only. ${spec.method} ${spec.path} would modify the cluster.`
      )
    }
    return this.transportFor(id).request(spec)
  }

  /** Test a draft connection (possibly unsaved) without registering a transport. */
  async test(payload: SaveConnectionPayload): Promise<TestConnectionResult> {
    try {
      const secret =
        payload.secret !== undefined && payload.secret !== null
          ? payload.secret
          : this.store.getSecret(payload.connection.id)
      const transport = new EsTransport({ ...payload.connection, hasSecret: false }, secret)
      const identity = await transport.ping()
      return {
        ok: true,
        message: `Connected to "${identity.clusterName}" — ${identity.distribution} ${identity.version}`,
        clusterName: identity.clusterName,
        distribution: identity.distribution,
        version: identity.version
      }
    } catch (err) {
      return { ok: false, message: (err as Error).message }
    }
  }
}
