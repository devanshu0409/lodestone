import { Plus, Copy, X } from 'lucide-react'

export interface StripTab {
  id: string
  label: string
  /** Optional leading accent text (e.g. an HTTP verb), styled separately. */
  lead?: string
  leadClass?: string
}

/** A horizontal strip of workspace tabs with add / clone / close controls. */
export function TabStrip({
  tabs,
  activeId,
  onSelect,
  onAdd,
  onClone,
  onClose,
  addTitle = 'New tab'
}: {
  tabs: StripTab[]
  activeId: string
  onSelect: (id: string) => void
  onAdd: () => void
  onClone: () => void
  onClose: (id: string) => void
  addTitle?: string
}): React.JSX.Element {
  return (
    <div className="tab-strip">
      <div className="tab-strip-tabs">
        {tabs.map((t) => (
          <div
            key={t.id}
            className={`ws-tab ${t.id === activeId ? 'on' : ''}`}
            title={t.label}
            onClick={() => onSelect(t.id)}
            onMouseDown={(e) => {
              // middle-click closes, like a browser tab
              if (e.button === 1 && tabs.length > 1) {
                e.preventDefault()
                onClose(t.id)
              }
            }}
          >
            {t.lead && <span className={`ws-tab-lead ${t.leadClass ?? ''}`}>{t.lead}</span>}
            <span className="ws-tab-label">{t.label}</span>
            {tabs.length > 1 && (
              <button
                className="ws-tab-close"
                title="Close tab"
                onClick={(e) => {
                  e.stopPropagation()
                  onClose(t.id)
                }}
              >
                <X size={11} />
              </button>
            )}
          </div>
        ))}
      </div>
      <button className="ws-tab-btn" title="Clone current tab" onClick={onClone}>
        <Copy size={13} />
      </button>
      <button className="ws-tab-btn" title={addTitle} onClick={onAdd}>
        <Plus size={14} />
      </button>
    </div>
  )
}
