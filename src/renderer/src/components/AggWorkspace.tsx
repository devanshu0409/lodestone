import { useState } from 'react'
import type { ClusterConnection } from '@shared/types'
import { AggTab } from './AggTab'
import { TabStrip } from './TabStrip'

interface Pane {
  id: string
  initialIndex?: string
  label: string
}

/**
 * Hosts several independent aggregation panes so you can run parallel
 * aggregations side by side. Each pane is a full AggTab kept mounted (hidden
 * when inactive) so its builder config and results survive tab switches.
 */
export function AggWorkspace({ conn }: { conn: ClusterConnection }): React.JSX.Element {
  const [panes, setPanes] = useState<Pane[]>(() => [{ id: crypto.randomUUID(), label: 'aggs' }])
  const [activeId, setActiveId] = useState<string>(() => panes[0].id)

  const active = panes.find((p) => p.id === activeId) ?? panes[0]

  const relabel = (id: string, label: string): void =>
    setPanes((ps) => ps.map((p) => (p.id === id && p.label !== label ? { ...p, label } : p)))

  const addPane = (initialIndex?: string): void => {
    const p: Pane = { id: crypto.randomUUID(), initialIndex, label: initialIndex ?? 'aggs' }
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
        onAdd={() => addPane(active.label !== 'aggs' ? active.label : undefined)}
        onClone={() => addPane(active.initialIndex)}
        onClose={closePane}
        addTitle="New aggregation"
      />
      {panes.map((p) => (
        <div
          key={p.id}
          className="search-pane"
          style={p.id === active.id ? undefined : { display: 'none' }}
        >
          <AggTab conn={conn} initialIndex={p.initialIndex} onIndexChange={(idx) => relabel(p.id, idx)} />
        </div>
      ))}
    </div>
  )
}
