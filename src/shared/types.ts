/** Shared type contracts between main, preload and renderer. */

export type AuthType = 'none' | 'basic'

export interface AuthConfig {
  type: AuthType
  /** Username for basic auth. The password travels separately and never returns to the renderer. */
  username?: string
}

export interface TlsConfig {
  /** Accept self-signed / untrusted certificates for this cluster. */
  insecure: boolean
}

export interface ClusterConnection {
  id: string
  name: string
  /** Seed node URLs, e.g. http://localhost:9200. Discovery expands this to the full topology. */
  seeds: string[]
  auth: AuthConfig
  tls: TlsConfig
  /** When true, all mutating requests are blocked (enforced in the main process). */
  readOnly: boolean
  /** Optional folder name for grouping clusters in the rail. Empty = ungrouped. */
  group?: string
  /** Tag color (hex) shown in the cluster rail. */
  color: string
  /** True when a password is stored for this connection (renderer never sees the secret itself). */
  hasSecret: boolean
}

export interface SaveConnectionPayload {
  connection: Omit<ClusterConnection, 'hasSecret'>
  /**
   * undefined — keep the existing secret;
   * null — clear it;
   * string — set a new one.
   */
  secret?: string | null
}

export type Distribution = 'elasticsearch' | 'opensearch'

export interface DiscoveredNode {
  id: string
  name: string
  url: string
  roles: string[]
  version: string
}

export interface ClusterHealth {
  status: 'green' | 'yellow' | 'red'
  numberOfNodes: number
  numberOfDataNodes: number
  activePrimaryShards: number
  activeShards: number
  relocatingShards: number
  initializingShards: number
  unassignedShards: number
  pendingTasks: number
  activeShardsPercent: number
}

export interface ClusterStats {
  indices: number
  docs: number
  storeBytes: number
}

export interface ClusterInfo {
  clusterName: string
  distribution: Distribution
  version: string
  nodes: DiscoveredNode[]
}

export interface ClusterOverview {
  info: ClusterInfo
  health: ClusterHealth
  stats: ClusterStats
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'HEAD'

export interface EsRequestSpec {
  method: HttpMethod
  /** Path with optional query string, e.g. /_cluster/health?level=indices */
  path: string
  body?: unknown
}

export interface EsResponse {
  status: number
  ok: boolean
  body: unknown
  tookMs: number
  /** The node that actually served the request (after any failover). */
  nodeUrl: string
}

export interface TestConnectionResult {
  ok: boolean
  message: string
  clusterName?: string
  distribution?: Distribution
  version?: string
}

/** Uniform IPC envelope so errors cross the bridge without throwing opaque objects. */
export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string }

/** Auto-updater status pushed from main → renderer via `update:status` event. */
export type UpdateStatus =
  | { state: 'idle' }
  | { state: 'available'; version: string }
  | { state: 'downloading'; percent: number }
  | { state: 'downloaded' }
  | { state: 'error'; message: string }
