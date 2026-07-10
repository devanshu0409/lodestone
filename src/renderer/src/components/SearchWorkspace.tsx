import { useEffect, useRef, useState } from 'react'
import type { ClusterConnection } from '@shared/types'
import { SearchTab } from './SearchTab'
import { TabStrip } from './TabStrip'

interface Pane {
  id: string
  initialIndex?: string
  label: string
}

/**
 * Hosts several independent search panes so you can query multiple indices at
 * once (like the head extension). Each pane is a full SearchTab kept mounted
 * (hidden when inactive) so its filters and results survive tab switches.
 */
export function SearchWorkspace({
  conn,
  browse
}: {
  conn: ClusterConnection
  /** A browse request from the Indices tab; `n` increments each time so repeat
   *  browses of the same index still open a fresh pane. */
  browse: { index: string; n: number } | null
}): React.JSX.Element {
  const [panes, setPanes] = useState<Pane[]>(() => [
    { id: crypto.randomUUID(), initialIndex: browse?.index, label: browse?.index ?? 'search' }
  ])
  const [activeId, setActiveId] = useState<string>(() => panes[0].id)
  const lastBrowse = useRef(browse?.n ?? 0)

  // Open a new pane whenever the Indices tab asks to browse an index.
  useEffect(() => {
    if (!browse || browse.n === lastBrowse.current) return
    lastBrowse.current = browse.n
    const p: Pane = { id: crypto.randomUUID(), initialIndex: browse.index, label: browse.index }
    setPanes((ps) => [...ps, p])
    setActiveId(p.id)
  }, [browse])

  const active = panes.find((p) => p.id === activeId) ?? panes[0]

  const relabel = (id: string, label: string): void =>
    setPanes((ps) => ps.map((p) => (p.id === id && p.label !== label ? { ...p, label } : p)))

  const addPane = (initialIndex?: string): void => {
    const p: Pane = { id: crypto.randomUUID(), initialIndex, label: initialIndex ?? 'search' }
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
        onAdd={() => addPane()}
        onClone={() => addPane(active.initialIndex)}
        onClose={closePane}
        addTitle="New search"
      />
      {panes.map((p) => (
        <div
          key={p.id}
          className="search-pane"
          style={p.id === active.id ? undefined : { display: 'none' }}
        >
          <SearchTab
            conn={conn}
            initialIndex={p.initialIndex}
            onIndexChange={(idx) => relabel(p.id, idx)}
          />
        </div>
      ))}
    </div>
  )
}
