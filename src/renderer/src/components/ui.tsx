import { useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { useApp } from '../store'

/* ---------- toasts ---------- */

export function Toasts(): React.JSX.Element {
  const { toasts, dismissToast } = useApp()
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <button key={t.id} className={`toast ${t.kind}`} onClick={() => dismissToast(t.id)}>
          {t.text}
        </button>
      ))}
    </div>
  )
}

/* ---------- type-to-confirm dialog (FR-7.1) ---------- */

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  requireText,
  onConfirm,
  onClose
}: {
  open: boolean
  title: string
  body: React.ReactNode
  confirmLabel: string
  /** When set, the user must type this exact string to enable the confirm button. */
  requireText?: string
  onConfirm: () => void | Promise<void>
  onClose: () => void
}): React.JSX.Element {
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const armed = !requireText || typed === requireText

  const confirm = async (): Promise<void> => {
    setBusy(true)
    try {
      await onConfirm()
    } finally {
      setBusy(false)
      setTyped('')
    }
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          setTyped('')
          onClose()
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="dlg-overlay" />
        <Dialog.Content className="dlg-content" aria-describedby={undefined} style={{ width: 420 }}>
          <Dialog.Title className="dlg-title">{title}</Dialog.Title>
          <div className="dlg-form">
            <div style={{ fontSize: 12.5, color: 'var(--ink-2)' }}>{body}</div>
            {requireText && (
              <div className="field">
                <label>
                  Type <span className="mono" style={{ color: 'var(--danger)' }}>{requireText}</span> to
                  confirm
                </label>
                <input
                  className="input mono"
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
            )}
            <div className="dlg-foot">
              <div className="spacer" />
              <button className="btn ghost" onClick={onClose}>
                Cancel
              </button>
              <button className="btn danger" disabled={!armed || busy} onClick={() => void confirm()}>
                {busy ? 'Working…' : confirmLabel}
              </button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/* ---------- dropdown menu ---------- */

export function Menu({
  trigger,
  children
}: {
  trigger: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="menu-content" align="end" sideOffset={4}>
          {children}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

export function MenuItem({
  children,
  danger,
  onSelect
}: {
  children: React.ReactNode
  danger?: boolean
  onSelect: () => void
}): React.JSX.Element {
  return (
    <DropdownMenu.Item className={`menu-item ${danger ? 'danger' : ''}`} onSelect={onSelect}>
      {children}
    </DropdownMenu.Item>
  )
}

export function MenuSep(): React.JSX.Element {
  return <DropdownMenu.Separator className="menu-sep" />
}
