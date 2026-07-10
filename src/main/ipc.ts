import { ipcMain } from 'electron'
import type { EsRequestSpec, IpcResult, SaveConnectionPayload } from '@shared/types'
import { ConnectionStore } from './store'
import { ClusterManager } from './clusters'

function wrap<T>(fn: () => T | Promise<T>): Promise<IpcResult<T>> {
  return Promise.resolve()
    .then(fn)
    .then((data) => ({ ok: true as const, data }))
    .catch((err: Error) => ({ ok: false as const, error: err.message || String(err) }))
}

export function registerIpc(): void {
  const store = new ConnectionStore()
  const clusters = new ClusterManager(store)

  ipcMain.handle('connections:list', () => wrap(() => store.list()))
  ipcMain.handle('connections:save', (_e, payload: SaveConnectionPayload) =>
    wrap(() => store.save(payload))
  )
  ipcMain.handle('connections:delete', (_e, id: string) =>
    wrap(() => {
      clusters.disconnect(id)
      store.delete(id)
    })
  )
  ipcMain.handle('connections:test', (_e, payload: SaveConnectionPayload) =>
    wrap(() => clusters.test(payload))
  )

  ipcMain.handle('cluster:connect', (_e, id: string) => wrap(() => clusters.connect(id)))
  ipcMain.handle('cluster:disconnect', (_e, id: string) => wrap(() => clusters.disconnect(id)))
  ipcMain.handle('cluster:request', (_e, id: string, spec: EsRequestSpec) =>
    wrap(() => clusters.request(id, spec))
  )
}
