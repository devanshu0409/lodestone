import { useEffect } from 'react'
import { useApp } from './store'
import { Sidebar } from './components/Sidebar'
import { ClusterView } from './components/ClusterView'
import { ConnectionDialog } from './components/ConnectionDialog'
import { UpdateBanner } from './components/UpdateBanner'
import { Toasts } from './components/ui'

export function App(): React.JSX.Element {
  const { connections, activeId, loaded, loadConnections, openDialog } = useApp()
  const active = connections.find((c) => c.id === activeId)

  useEffect(() => {
    void loadConnections()
  }, [loadConnections])

  return (
    <div className="app">
      <Sidebar />
      <main className="content">
        <UpdateBanner />
        {active ? (
          <ClusterView conn={active} />
        ) : (
          <div className="state-screen">
            <div className="glyph">⌖</div>
            {loaded && connections.length === 0 ? (
              <>
                <h2>No clusters yet</h2>
                <p>
                  Add a cluster to see its health, nodes and indices. One node URL is enough — the
                  rest of the topology is discovered automatically.
                </p>
                <div className="actions">
                  <button className="btn primary" onClick={() => openDialog()}>
                    Add cluster
                  </button>
                </div>
              </>
            ) : (
              <>
                <h2>Select a cluster</h2>
                <p>Pick a cluster from the rail on the left, or add a new one.</p>
              </>
            )}
          </div>
        )}
      </main>
      <ConnectionDialog />
      <Toasts />
    </div>
  )
}
