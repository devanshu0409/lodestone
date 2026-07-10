import { useEffect, useState } from 'react'
import { Download, RotateCw, X } from 'lucide-react'
import type { UpdateStatus } from '@shared/types'

export function UpdateBanner(): React.JSX.Element | null {
  const [status, setStatus] = useState<UpdateStatus>({ state: 'idle' })
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    const off = window.lodestone.updater.onStatus(setStatus)
    return off
  }, [])

  if (dismissed || status.state === 'idle' || status.state === 'error') return null

  if (status.state === 'downloading') {
    return (
      <div className="update-banner">
        <Download size={14} />
        <span>Downloading update…</span>
        <span className="update-progress">{status.percent}%</span>
        <div className="update-bar">
          <div className="update-bar-fill" style={{ width: `${status.percent}%` }} />
        </div>
        <button className="btn ghost update-dismiss" title="Dismiss" onClick={() => setDismissed(true)}>
          <X size={13} />
        </button>
      </div>
    )
  }

  if (status.state === 'downloaded') {
    return (
      <div className="update-banner">
        <RotateCw size={14} />
        <span>Update ready — restart to install.</span>
        <span className="spacer" />
        <button className="btn primary" onClick={() => void window.lodestone.updater.quitAndInstall()}>
          <RotateCw size={13} /> Restart &amp; update
        </button>
        <button className="btn ghost update-dismiss" title="Dismiss" onClick={() => setDismissed(true)}>
          <X size={13} />
        </button>
      </div>
    )
  }

  // state === 'available'
  return (
    <div className="update-banner">
      <Download size={14} />
      <span>
        A new version <span className="update-version">{status.version}</span> is available.
      </span>
      <span className="spacer" />
      <button
        className="btn primary"
        onClick={() => void window.lodestone.updater.downloadUpdate()}
      >
        <Download size={13} /> Download &amp; install
      </button>
      <button className="btn ghost update-dismiss" title="Remind me later" onClick={() => setDismissed(true)}>
        <X size={13} />
      </button>
    </div>
  )
}
