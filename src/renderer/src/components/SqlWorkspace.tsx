import { useState } from 'react'
import type { ClusterConnection, ClusterOverview } from '@shared/types'
import { SqlTab } from './SqlTab'
import { TabStrip } from './TabStrip'

interface Pane {
  id: string
  initialIndex?: string
  label: string
}

/**
 * Hosts several independent SQL panes. Each pane is a full SqlTab kept mounted
 * (hidden when inactive) so its builder state and results survive tab switches.
 */
export function SqlWorkspace({
  conn,
  overview
}: {
  conn: ClusterConnection
  overview: ClusterOverview
}): React.JSX.Element {
  const [panes, setPanes] = useState<Pane[]>(() => [{ id: crypto.randomUUID(), label: 'sql' }])
  const [activeId, setActiveId] = useState<string>(() => panes[0].id)

  const active = panes.find((p) => p.id === activeId) ?? panes[0]

  const relabel = (id: string, label: string): void =>
    setPanes((ps) => ps.map((p) => (p.id === id && p.label !== label ? { ...p, label } : p)))

  const addPane = (initialIndex?: string): void => {
    const p: Pane = { id: crypto.randomUUID(), initialIndex, label: initialIndex ?? 'sql' }
    setPanes((ps) => [...ps, p])
    setActiveId(p.id)
  }

  const closePane = (id: string): void => {
    if (panes.length === 1) return
    const idx = panes.findIndex((p) => p.id === id)
    const rest = panes.filter((p) => p.id !== id)
    setPanes(rest)
    if (id === activeId) setActiveId(rest[Math.max(0, idx - 1)].id)
  }

  return (
    <div className="search-workspace">
      <TabStrip
        tabs={panes.map((p) => ({ id: p.id, label: p.label }))}
        activeId={active.id}
        onSelect={setActiveId}
        onAdd={() => addPane(active.label !== 'sql' ? active.label : undefined)}
        onClone={() => addPane(active.initialIndex)}
        onClose={closePane}
        addTitle="New SQL query"
      />
      {panes.map((p) => (
        <div
          key={p.id}
          className="search-pane"
          style={p.id === active.id ? undefined : { display: 'none' }}
        >
          <SqlTab
            conn={conn}
            overview={overview}
            initialIndex={p.initialIndex}
            onIndexChange={(idx) => relabel(p.id, idx)}
          />
        </div>
      ))}
    </div>
  )
}
