import { useCallback, useEffect, useState } from 'react'
import { Lock, Pencil, RefreshCw, Unplug } from 'lucide-react'
import type { ClusterConnection } from '@shared/types'
import { useApp, type Session } from '../store'
import { REFRESH_MS } from '../lib/api'
import { Overview } from './Overview'
import { ShardGrid } from './ShardGrid'
import { Indices } from './Indices'
import { SearchWorkspace } from './SearchWorkspace'
import { Console } from './Console'
import { AnalyzerPlayground } from './AnalyzerPlayground'
import { AggWorkspace } from './AggWorkspace'
import { SqlWorkspace } from './SqlWorkspace'

type Tab = 'overview' | 'shards' | 'indices' | 'search' | 'aggs' | 'sql' | 'console' | 'analyze'

const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'shards', label: 'Shards' },
  { id: 'indices', label: 'Indices' },
  { id: 'search', label: 'Search' },
  { id: 'aggs', label: 'Aggregations' },
  { id: 'sql', label: 'SQL' },
  { id: 'console', label: 'Console' },
  { id: 'analyze', label: 'Analyze' }
]

export function ClusterView({ conn }: { conn: ClusterConnection }): React.JSX.Element {
  const { sessions, connect, disconnect, openDialog, bumpRefresh } = useApp()
  const session: Session = sessions[conn.id] ?? { status: 'idle' }
  const [tab, setTab] = useState<Tab>('overview')
  // Keep-alive: once a tab is visited it stays mounted (hidden via CSS) so its
  // state — search filters, console request, scroll — survives tab switches.
  const [visited, setVisited] = useState<Set<Tab>>(() => new Set<Tab>(['overview']))
  // Browse requests from the Indices tab; the nonce lets a repeat browse of the
  // same index still open a fresh search pane.
  const [browse, setBrowse] = useState<{ index: string; n: number } | null>(null)

  const show = useCallback((t: Tab): void => {
    setTab(t)
    setVisited((v) => (v.has(t) ? v : new Set(v).add(t)))
  }, [])

  useEffect(() => {
    if (session.status !== 'connected') return
    const t = setInterval(() => void connect(conn.id, { silent: true }), REFRESH_MS)
    return () => clearInterval(t)
  }, [conn.id, session.status, connect])

  if (session.status === 'connecting' && !session.overview) {
    return (
      <div className="state-screen">
        <div className="spinner" />
        <p>Connecting to {conn.name}…</p>
      </div>
    )
  }

  if (session.status === 'error' && !session.overview) {
    return (
      <div className="state-screen">
        <h2>Can’t reach {conn.name}</h2>
        <div className="err">{session.error}</div>
        <div className="actions">
          <button className="btn" onClick={() => openDialog(conn.id)}>
            Edit connection
          </button>
          <button className="btn primary" onClick={() => void connect(conn.id)}>
            Retry
          </button>
        </div>
      </div>
    )
  }

  if (session.status === 'idle' || !session.overview) {
    return (
      <div className="state-screen">
        <h2>{conn.name}</h2>
        <p>Not connected.</p>
        <div className="actions">
          <button className="btn primary" onClick={() => void connect(conn.id)}>
            Connect
          </button>
        </div>
      </div>
    )
  }

  const { info, health } = session.overview

  return (
    <>
      <header className="context-bar">
        <span className={`health-led ${health.status}`} />
        <span className="cluster-name">{info.clusterName}</span>
        <span className="chip">
          {info.distribution === 'opensearch' ? 'OpenSearch' : 'Elasticsearch'} {info.version}
        </span>
        {conn.readOnly && (
          <span className="badge-ro">
            <Lock size={10} />
            READ-ONLY
          </span>
        )}
        {session.status === 'error' && (
          <span className="chip" style={{ color: 'var(--danger)', borderColor: 'var(--danger)' }}>
            refresh failed
          </span>
        )}
        <div className="spacer" />
        <button
          className="icon-btn"
          title="Refresh"
          onClick={() => {
            bumpRefresh()
            void connect(conn.id, { silent: true })
          }}
        >
          <RefreshCw size={14} />
        </button>
        <button className="icon-btn" title="Edit connection" onClick={() => openDialog(conn.id)}>
          <Pencil size={14} />
        </button>
        <button className="icon-btn" title="Disconnect" onClick={() => disconnect(conn.id)}>
          <Unplug size={14} />
        </button>
      </header>

      <nav className="tab-bar">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`tab ${tab === t.id ? 'on' : ''}`}
            onClick={() => show(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {visited.has('overview') && (
        <TabPanel active={tab === 'overview'}>
          <Overview conn={conn} overview={session.overview} />
        </TabPanel>
      )}
      {visited.has('shards') && (
        <TabPanel active={tab === 'shards'}>
          <ShardGrid conn={conn} overview={session.overview} />
        </TabPanel>
      )}
      {visited.has('indices') && (
        <TabPanel active={tab === 'indices'}>
          <Indices
            conn={conn}
            onBrowse={(index) => {
              setBrowse((b) => ({ index, n: (b?.n ?? 0) + 1 }))
              show('search')
            }}
          />
        </TabPanel>
      )}
      {visited.has('search') && (
        <TabPanel active={tab === 'search'}>
          <SearchWorkspace conn={conn} browse={browse} />
        </TabPanel>
      )}
      {visited.has('aggs') && (
        <TabPanel active={tab === 'aggs'}>
          <AggWorkspace conn={conn} />
        </TabPanel>
      )}
      {visited.has('sql') && (
        <TabPanel active={tab === 'sql'}>
          <SqlWorkspace conn={conn} overview={session.overview} />
        </TabPanel>
      )}
      {visited.has('console') && (
        <TabPanel active={tab === 'console'}>
          <Console conn={conn} overview={session.overview} />
        </TabPanel>
      )}
      {visited.has('analyze') && (
        <TabPanel active={tab === 'analyze'}>
          <AnalyzerPlayground conn={conn} />
        </TabPanel>
      )}
    </>
  )
}

/** A mounted-but-maybe-hidden tab body. Hidden panels use display:none so they
 *  drop out of the flex column and the active panel still fills the space. */
function TabPanel({
  active,
  children
}: {
  active: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="tab-panel" style={active ? undefined : { display: 'none' }}>
      {children}
    </div>
  )
}
