import type {
  ClusterConnection,
  ClusterOverview,
  EsRequestSpec,
  EsResponse,
  IpcResult,
  SaveConnectionPayload,
  TestConnectionResult,
  UpdateStatus
} from '@shared/types'

/** Typed surface exposed to the renderer. Everything returns an IpcResult envelope. */
export interface LodestoneApi {
  connections: {
    list(): Promise<IpcResult<ClusterConnection[]>>
    save(payload: SaveConnectionPayload): Promise<IpcResult<ClusterConnection>>
    delete(id: string): Promise<IpcResult<void>>
    test(payload: SaveConnectionPayload): Promise<IpcResult<TestConnectionResult>>
  }
  cluster: {
    connect(id: string): Promise<IpcResult<ClusterOverview>>
    disconnect(id: string): Promise<IpcResult<void>>
    request(id: string, spec: EsRequestSpec): Promise<IpcResult<EsResponse>>
  }
  updater: {
    checkForUpdates(): Promise<IpcResult<void>>
    downloadUpdate(): Promise<IpcResult<void>>
    quitAndInstall(): Promise<IpcResult<void>>
    onStatus(cb: (status: UpdateStatus) => void): () => void
  }
}

declare global {
  interface Window {
    lodestone: LodestoneApi
  }
}
