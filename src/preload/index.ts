import { contextBridge, ipcRenderer } from 'electron'
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

const api: LodestoneApi = {
  connections: {
    list: () => ipcRenderer.invoke('connections:list'),
    save: (payload) => ipcRenderer.invoke('connections:save', payload),
    delete: (id) => ipcRenderer.invoke('connections:delete', id),
    test: (payload) => ipcRenderer.invoke('connections:test', payload)
  },
  cluster: {
    connect: (id) => ipcRenderer.invoke('cluster:connect', id),
    disconnect: (id) => ipcRenderer.invoke('cluster:disconnect', id),
    request: (id, spec) => ipcRenderer.invoke('cluster:request', id, spec)
  },
  updater: {
    checkForUpdates: () => ipcRenderer.invoke('update:check'),
    downloadUpdate: () => ipcRenderer.invoke('update:download'),
    quitAndInstall: () => ipcRenderer.invoke('update:install'),
    onStatus: (cb) => {
      const handler = (_e: unknown, status: UpdateStatus): void => cb(status)
      ipcRenderer.on('update:status', handler)
      return () => ipcRenderer.removeListener('update:status', handler)
    }
  }
}

contextBridge.exposeInMainWorld('lodestone', api)
