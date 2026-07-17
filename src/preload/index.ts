import { contextBridge, ipcRenderer } from 'electron'
import type { UpdateStatus } from '@shared/types'
import type { LodestoneApi } from './api'

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
