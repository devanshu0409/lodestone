import { app, BrowserWindow, ipcMain } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { IpcResult, UpdateStatus } from '@shared/types'

/**
 * Wires electron-updater to the renderer.
 *
 * In packaged builds the updater auto-checks GitHub releases on startup and
 * pushes status changes via `update:status`. The renderer can trigger
 * download / install via IPC. In dev builds all handlers are no-ops.
 */
export function setupAutoUpdater(win: BrowserWindow): void {
  const packaged = app.isPackaged

  if (packaged) {
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = true

    const send = (status: UpdateStatus): void => {
      if (!win.isDestroyed()) win.webContents.send('update:status', status)
    }

    autoUpdater.on('update-available', (info) => {
      send({ state: 'available', version: info.version })
    })
    autoUpdater.on('update-not-available', () => {
      send({ state: 'idle' })
    })
    autoUpdater.on('download-progress', (p) => {
      send({ state: 'downloading', percent: Math.round(p.percent) })
    })
    autoUpdater.on('update-downloaded', () => {
      send({ state: 'downloaded' })
    })
    autoUpdater.on('error', (err) => {
      send({ state: 'error', message: err.message })
    })

    // Auto-check shortly after launch so it doesn't block window creation,
    // then re-check periodically — long-running windows still learn about
    // releases published after they started.
    const check = (): void => {
      void autoUpdater.checkForUpdates().catch(() => {
        /* offline or rate-limited — the next interval will retry */
      })
    }
    setTimeout(check, 3000)
    const interval = setInterval(check, 4 * 60 * 60 * 1000)
    win.on('closed', () => clearInterval(interval))
  }

  // Always register handlers so the renderer's typed API is satisfied.
  ipcMain.handle('update:check', async (): Promise<IpcResult<void>> => {
    if (!packaged) return { ok: true, data: undefined }
    try {
      await autoUpdater.checkForUpdates()
      return { ok: true, data: undefined }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  })

  ipcMain.handle('update:download', async (): Promise<IpcResult<void>> => {
    if (!packaged) return { ok: true, data: undefined }
    try {
      await autoUpdater.downloadUpdate()
      return { ok: true, data: undefined }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  })

  ipcMain.handle('update:install', (): IpcResult<void> => {
    if (packaged) autoUpdater.quitAndInstall()
    return { ok: true, data: undefined }
  })
}
