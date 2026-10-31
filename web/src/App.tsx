import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Activity, AlertTriangle, ArrowDownToLine, ArrowUpFromLine, Bell, Check,
  ChevronRight, CircleHelp, Clock3, LayoutDashboard, Menu, Network, Radio,
  RefreshCw, ShieldCheck, Signal, Wifi, X,
} from 'lucide-react'
import {
  Area, AreaChart, CartesianGrid, Line, LineChart, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from 'recharts'
import type { Event, InterfacesResource, ListResponse, Metric, Prediction, QoS, ServicesResource, SystemStatus } from './types'

const API = (import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:8000').replace(/\/$/, '')
const REFRESH_MS = 5_000

type Page = 'Overview' | 'Network topology' | 'Live monitoring' | 'SLA assurance'
type DashboardData = {
  system: SystemStatus
  qos: QoS | null
  qosHistory: QoS[]
  metrics: Metric[]
  events: Event[]
  interfaces: Metric[]
  service: ServicesResource['telecom:services']['service'][number] | null
  prediction: Prediction
}

async function get<T>(path: string): Promise<T> {
  const response = await fetch(`${API}${path}`, { headers: { Accept: 'application/json' } })
  if (!response.ok) throw new Error(`${path} returned ${response.status} ${response.statusText}`)
  return response.json() as Promise<T>
}

async function loadDashboard(): Promise<DashboardData> {
  const [system, latest, qosHistory, metrics, events, interfaces, services, prediction] = await Promise.all([
    get<SystemStatus>('/api/v1/system'),
    get<{ data: QoS | null }>('/api/v1/qos/latest'),
    get<ListResponse<QoS>>('/api/v1/qos/history?limit=100'),
    get<ListResponse<Metric>>('/api/v1/metrics/history?limit=200'),
    get<ListResponse<Event>>('/api/v1/sla/events?limit=100'),
    get<InterfacesResource>('/restconf/data/telecom:interfaces'),
    get<ServicesResource>('/restconf/data/telecom:services'),
    get<Prediction>('/api/v1/prediction/early-warning'),
  ])
  return {
    system,
    qos: latest.data,
    qosHistory: [...qosHistory.data].reverse(),
    metrics: [...metrics.data].reverse(),
    events: events.data,
    interfaces: interfaces['telecom:interfaces'].interface,
    service: services['telecom:services'].service[0] ?? null,
    prediction,
  }
}

function App() {
  const [page, setPage] = useState<Page>('Overview')
  const [data, setData] = useState<DashboardData | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const [mobileMenu, setMobileMenu] = useState(false)
  const [slaFilter, setSlaFilter] = useState<'ALL' | 'OPEN' | 'CLOSED'>('ALL')

  const refresh = useCallback(async () => {
    try {
      const next = await loadDashboard()
      setData(next)
      setError('')
      setLastUpdated(new Date())
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to reach the assurance API')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => void refresh(), REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [refresh])

  const activeEvents = useMemo(() => data?.events.filter((event) => event.status === 'OPEN') ?? [], [data])
  const filteredEvents = useMemo(
    () => data?.events.filter((event) => slaFilter === 'ALL' || event.status === slaFilter) ?? [],
    [data, slaFilter],
  )
  const totalThroughput = data?.interfaces.reduce((sum, row) => sum + (row.rx_mbps ?? 0) + (row.tx_mbps ?? 0), 0) ?? 0
  const latencyValues = data?.qosHistory.map((row) => row.latency_avg_ms).filter((value): value is number => value !== null) ?? []
  const lossValues = data?.qosHistory.map((row) => row.packet_loss_pct).filter((value): value is number => value !== null) ?? []
  const avgLatency = latencyValues.length ? latencyValues.reduce((sum, value) => sum + value, 0) / latencyValues.length : null
  const avgLoss = lossValues.length ? lossValues.reduce((sum, value) => sum + value, 0) / lossValues.length : null
  const isBreach = data?.qos?.sla_status?.toUpperCase() === 'BREACH'
  const qosFresh = Boolean(data?.qos && isFresh(data.qos.timestamp))
  const trafficFresh = Boolean(data?.system.latest_traffic && isFresh(data.system.latest_traffic.timestamp))

  const nav: Array<{ label: Page; icon: typeof LayoutDashboard }> = [
    { label: 'Overview', icon: LayoutDashboard },
    { label: 'Network topology', icon: Network },
    { label: 'Live monitoring', icon: Activity },
    { label: 'SLA assurance', icon: ShieldCheck },
  ]

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileMenu ? 'sidebar-open' : ''}`}>
        <div className="brand"><div className="brand-mark"><Signal size={19} /></div><div><strong>ASSURE<span>NET</span></strong><small>TELECOM NOC</small></div></div>
        <div className="workspace-label">WORKSPACE</div>
        <nav className="side-nav" aria-label="Main navigation">
          {nav.map(({ label, icon: Icon }) => <button key={label} className={`nav-item ${page === label ? 'active' : ''}`} onClick={() => { setPage(label); setMobileMenu(false) }}><Icon size={17} /><span>{label}</span>{page === label && <ChevronRight size={15} className="nav-chevron" />}</button>)}
        </nav>
        <div className="sidebar-spacer" />
        <div className="sidebar-lab"><div className="lab-icon"><Radio size={16} /></div><div><span>LAB ENVIRONMENT</span><strong>Telecom Assurance</strong><small>3 network nodes</small></div><span className="live-dot" /></div>
        <div className="sidebar-foot"><span className="foot-dot" />Local monitoring stack <span className="version">v1.0</span></div>
      </aside>

      {mobileMenu && <button className="mobile-scrim" aria-label="Close navigation" onClick={() => setMobileMenu(false)} />}

      <main className="main-area">
        <header className="topbar">
          <div className="topbar-title"><button className="mobile-menu-button" onClick={() => setMobileMenu(true)} aria-label="Open navigation"><Menu size={19} /></button><div className="breadcrumbs"><span>Assurance</span><ChevronRight size={13} /><strong>{page}</strong></div></div>
          <div className="topbar-actions"><div className="connection-state"><span className={`live-dot ${error ? 'offline' : ''}`} />{error ? 'API disconnected' : 'API connected'}</div><span className="topbar-divider" /><span className="updated-label">{lastUpdated ? `Updated ${lastUpdated.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}` : 'Waiting for data'}</span><button className="icon-button" title="Refresh data" onClick={() => { setLoading(true); void refresh() }}><RefreshCw size={16} className={loading ? 'spin' : ''} /></button><button className="icon-button notification-button" title={`${activeEvents.length} open incidents`} onClick={() => setPage('SLA assurance')}><Bell size={16} />{activeEvents.length > 0 && <i />}</button><div className="avatar">N</div></div>
        </header>

        <div className="page-content">
          <div className="page-heading"><div><div className="eyebrow">TELECOM SERVICE ASSURANCE</div><h1>{page === 'Network topology' ? 'Network topology' : page}</h1><p>{pageSubtitle(page)}</p></div><div className="heading-right"><span className="auto-refresh"><span className="pulse-dot" />Auto refresh · 5 sec</span></div></div>

          {error && <div className="error-banner"><AlertTriangle size={17} /><div><strong>Live data unavailable</strong><span>{error}. Showing the last successful snapshot, if available.</span></div><button onClick={() => { setLoading(true); void refresh() }}>Retry</button></div>}
          {loading && !data ? <LoadingState /> : !data ? <ErrorState onRetry={() => { setLoading(true); void refresh() }} /> : <>
            {page === 'Overview' && <Overview data={data} activeEvents={activeEvents} totalThroughput={totalThroughput} avgLatency={avgLatency} avgLoss={avgLoss} isBreach={Boolean(isBreach)} qosFresh={qosFresh} trafficFresh={trafficFresh} onNavigate={setPage} />}
            {page === 'Network topology' && <Topology data={data} qosFresh={qosFresh} trafficFresh={trafficFresh} />}
            {page === 'Live monitoring' && <Monitoring data={data} />}
            {page === 'SLA assurance' && <SlaPage data={data} events={filteredEvents} filter={slaFilter} setFilter={setSlaFilter} qosFresh={qosFresh} />}
          </>}
          <footer className="page-footer"><span>ASSURENET · TELECOM SERVICE ASSURANCE PLATFORM</span><span>Data sourced from SNMP &amp; QoS monitors <span className="footer-separator">·</span> {lastUpdated ? `Last sync ${lastUpdated.toLocaleTimeString()}` : 'No sync yet'}</span></footer>
        </div>
      </main>
    </div>
  )
}

function pageSubtitle(page: Page) {
  const text: Record<Page, string> = {
    Overview: 'Real-time view of your network health and service performance.',
    'Network topology': 'Topology and interface traffic from your simulated telecom lab.',
    'Live monitoring': 'Historical traffic and QoS measurements from your monitors.',
    'SLA assurance': 'Incident lifecycle, service levels, and breach history.',
  }
  return text[page]
}

function Overview({ data, activeEvents, totalThroughput, avgLatency, avgLoss, isBreach, qosFresh, trafficFresh, onNavigate }: {
  data: DashboardData; activeEvents: Event[]; totalThroughput: number; avgLatency: number | null; avgLoss: number | null; isBreach: boolean; qosFresh: boolean; trafficFresh: boolean; onNavigate: (page: Page) => void
}) {
  const chartData = data.qosHistory.slice(-24).map((row) => ({ time: timeLabel(row.timestamp), latency: row.latency_avg_ms, loss: row.packet_loss_pct }))
  const recentEvents = data.events.slice(0, 5)
  const healthLabel = !qosFresh ? (data.qos ? 'Monitoring data is stale' : 'Awaiting first QoS sample') : isBreach ? 'SLA breach detected' : 'Network operating normally'
  const healthStatus = !qosFresh ? (data.qos ? 'STALE' : 'UNKNOWN') : data.qos?.sla_status ?? 'UNKNOWN'
  return <>
    <div className={`health-banner ${!qosFresh ? 'health-unknown' : isBreach ? 'health-breach' : 'health-normal'}`}><div className="health-icon">{!qosFresh ? <CircleHelp size={19} /> : isBreach ? <AlertTriangle size={19} /> : <Check size={19} />}</div><div className="health-copy"><span>NETWORK HEALTH</span><strong>{healthLabel}</strong><small>{data.qos ? `Last probe to ${data.qos.target_ip} · ${timeAgo(data.qos.timestamp)}` : 'QoS monitor has not reported a measurement yet'}</small></div><div className="health-meta"><span className="status-chip">{healthStatus}</span><span>{activeEvents.length} open incident{activeEvents.length === 1 ? '' : 's'}</span></div></div>

    <div className="kpi-grid overview-kpis">
      <KpiCard icon={<Activity size={17} />} label="AVG. LATENCY" value={avgLatency === null ? '—' : `${avgLatency.toFixed(2)} ms`} detail="Recent QoS samples" accent="cyan" />
      <KpiCard icon={<Wifi size={17} />} label="AVG. PACKET LOSS" value={avgLoss === null ? '—' : `${avgLoss.toFixed(2)}%`} detail={data.qos ? `Latest ${formatMeasurement(data.qos.packet_loss_pct, '%')}` : 'No QoS samples'} accent="violet" />
      <KpiCard icon={<ArrowDownToLine size={17} />} label="TOTAL THROUGHPUT" value={`${formatRate(totalThroughput)} Mbps`} detail="RX + TX across router links" accent="blue" />
      <KpiCard icon={<AlertTriangle size={17} />} label="OPEN SLA INCIDENTS" value={String(activeEvents.length).padStart(2, '0')} detail={activeEvents.length ? 'Requires attention' : 'No active incidents'} accent={activeEvents.length ? 'red' : 'green'} />
      <KpiCard icon={<Activity size={17} />} label="AI EARLY WARNING" value={data.prediction.available ? `${data.prediction.risk_score_pct}%` : '—'} detail={data.prediction.available ? !qosFresh ? 'Last QoS sample is stale · experimental score' : `Next ${data.prediction.horizon_samples} samples · experimental` : data.prediction.reason ?? 'Model unavailable'} accent="violet" />
    </div>

    <div className="section-grid overview-grid">
      <section className="panel chart-panel"><PanelHeader title="QoS performance" subtitle="Latency and packet loss · recent samples" action="View monitoring" onAction={() => onNavigate('Live monitoring')} /><div className="chart-legend-head"><span><i className="legend-dot cyan-dot" />Latency <b>{data.qos ? formatMeasurement(data.qos.latency_avg_ms, ' ms') : '—'}</b></span><span><i className="legend-dot violet-dot" />Packet loss <b>{data.qos ? formatMeasurement(data.qos.packet_loss_pct, '%') : '—'}</b></span></div>{chartData.length ? <div className="chart-wrap overview-chart"><ResponsiveContainer width="100%" height="100%"><LineChart data={chartData} margin={{ top: 8, right: 10, left: -18, bottom: 0 }}><CartesianGrid stroke="#202a35" strokeDasharray="3 5" vertical={false} /><XAxis dataKey="time" tick={{ fill: '#748292', fontSize: 10 }} axisLine={false} tickLine={false} minTickGap={28} /><YAxis yAxisId="latency" tick={{ fill: '#748292', fontSize: 10 }} axisLine={false} tickLine={false} /><YAxis yAxisId="loss" orientation="right" domain={[0, 'auto']} tick={{ fill: '#748292', fontSize: 10 }} axisLine={false} tickLine={false} /><Tooltip content={<ChartTooltip />} /><Line yAxisId="latency" type="monotone" dataKey="latency" name="Latency (ms)" stroke="#36d5e8" strokeWidth={2} dot={false} activeDot={{ r: 4 }} /><Line yAxisId="loss" type="monotone" dataKey="loss" name="Packet loss (%)" stroke="#9c86ff" strokeWidth={2} dot={false} activeDot={{ r: 4 }} /></LineChart></ResponsiveContainer></div> : <EmptyState title="No QoS history yet" text="Measurements will appear here when the QoS monitor records data." />}</section>
      <section className="panel"><PanelHeader title="Service status" subtitle="Current assurance signals" /><div className="service-row"><span className="service-icon"><ShieldCheck size={17} /></span><div className="service-info"><strong>QoS monitoring</strong><small>{data.qos?.target_ip ?? 'Target not yet reported'}</small></div><StatePill state={qosFresh ? data.qos?.sla_status ?? 'UNKNOWN' : data.qos ? 'STALE' : 'UNKNOWN'} /></div><div className="service-row"><span className="service-icon blue-service"><Network size={17} /></span><div className="service-info"><strong>Router interfaces</strong><small>{data.interfaces.length} interface samples available</small></div><StatePill state={trafficFresh ? data.interfaces.length ? 'UP' : 'UNKNOWN' : data.interfaces.length ? 'STALE' : 'UNKNOWN'} /></div><div className="service-row"><span className="service-icon green-service"><Activity size={17} /></span><div className="service-info"><strong>Metrics database</strong><small>SQLite · read-only API access</small></div><StatePill state={data.system.database.toUpperCase()} /></div><div className="service-bottom"><span>Service view</span><button onClick={() => onNavigate('Network topology')}>Open topology <ChevronRight size={14} /></button></div></section>
    </div>

    <section className="panel recent-panel"><PanelHeader title="Recent SLA events" subtitle="Latest incident transitions" action="View all events" onAction={() => onNavigate('SLA assurance')} /><EventTable events={recentEvents} compact /></section>
  </>
}

function Topology({ data, qosFresh, trafficFresh }: { data: DashboardData; qosFresh: boolean; trafficFresh: boolean }) {
  const latestByInterface = new Map(data.interfaces.map((row) => [row.interface, row]))
  const r0 = latestByInterface.get('r0')
  const r1 = latestByInterface.get('r1')
  return <>
    <section className="panel topology-panel"><PanelHeader title="Simulated network" subtitle="Client → Router → Server · namespace topology" /><div className="topology-canvas">
      <NodeCard kind="endpoint" icon={<Radio size={19} />} name="Client" namespace="tsa-client" address="10.10.1.2" detail="Probe source" state={qosFresh ? 'UP' : data.qos ? 'STALE' : 'UNKNOWN'} />
      <LinkLine label="10.10.1.0/24" fresh={trafficFresh} />
      <NodeCard kind="router" icon={<Network size={19} />} name="Router" namespace="tsa-router" address="10.10.1.1 · 10.10.2.1" detail="IPv4 forwarding" state={trafficFresh && r0 && r1 ? 'UP' : r0 || r1 ? 'STALE' : 'UNKNOWN'} />
      <LinkLine label="10.10.2.0/24" fresh={trafficFresh} />
      <NodeCard kind="endpoint" icon={<Radio size={19} />} name="Server" namespace="tsa-server" address="10.10.2.2" detail="QoS target" state={qosFresh && (data.qos?.packets_received ?? 0) > 0 ? 'UP' : data.qos ? 'STALE' : 'UNKNOWN'} />
    </div></section>
    <div className="section-grid topology-lower"><section className="panel"><PanelHeader title="Router interfaces" subtitle="Latest SNMP traffic samples" /><div className="interface-grid">{['r0', 'r1'].map((name) => <InterfaceCard key={name} name={name} metric={latestByInterface.get(name)} />)}</div></section><section className="panel"><PanelHeader title="Path health" subtitle="From latest available measurements" /><div className="path-summary"><div className="path-summary-row"><span>Latest QoS target</span><strong>{data.qos?.target_ip ?? 'No sample'}</strong></div><div className="path-summary-row"><span>Round trip latency</span><strong>{data.qos ? formatMeasurement(data.qos.latency_avg_ms, ' ms') : '—'}</strong></div><div className="path-summary-row"><span>Packet loss</span><strong>{data.qos ? formatMeasurement(data.qos.packet_loss_pct, '%') : '—'}</strong></div><div className="path-summary-row"><span>SLA state</span><StatePill state={data.qos?.sla_status ?? 'UNKNOWN'} /></div></div><div className="data-note"><CircleHelp size={14} /><span>Node reachability is inferred from recorded QoS samples. The API does not expose live namespace link state.</span></div></section></div>
  </>
}

function Monitoring({ data }: { data: DashboardData }) {
  const trafficByTime = new Map<string, { time: string; r0Rx?: number; r0Tx?: number; r1Rx?: number; r1Tx?: number }>()
  for (const row of data.metrics) {
    const point = trafficByTime.get(row.timestamp) ?? { time: timeLabel(row.timestamp) }
    if (row.interface === 'r0') {
      point.r0Rx = row.rx_mbps ?? undefined
      point.r0Tx = row.tx_mbps ?? undefined
    } else if (row.interface === 'r1') {
      point.r1Rx = row.rx_mbps ?? undefined
      point.r1Tx = row.tx_mbps ?? undefined
    }
    trafficByTime.set(row.timestamp, point)
  }
  const traffic = Array.from(trafficByTime.values())
  const qos = data.qosHistory.map((row) => ({ time: timeLabel(row.timestamp), latency: row.latency_avg_ms, loss: row.packet_loss_pct }))
  return <>
    <div className="monitor-summary"><KpiCard icon={<ArrowDownToLine size={17} />} label="LATEST RX + TX" value={`${formatRate(data.interfaces.reduce((s, x) => s + (x.rx_mbps ?? 0) + (x.tx_mbps ?? 0), 0))} Mbps`} detail="Across r0 and r1" accent="cyan" /><KpiCard icon={<Clock3 size={17} />} label="LATEST LATENCY" value={data.qos ? formatMeasurement(data.qos.latency_avg_ms, ' ms') : '—'} detail={data.qos ? timeAgo(data.qos.timestamp) : 'Waiting for QoS'} accent="blue" /><KpiCard icon={<Wifi size={17} />} label="LATEST PACKET LOSS" value={data.qos ? formatMeasurement(data.qos.packet_loss_pct, '%') : '—'} detail={data.qos?.sla_status ?? 'No status'} accent="violet" /></div>
    <div className="section-grid monitoring-grid"><section className="panel chart-panel"><PanelHeader title="SNMP interface throughput" subtitle="RX and TX · Mbps · latest traffic history" /><div className="chart-legend-head"><span><i className="legend-dot cyan-dot" />r0 RX</span><span><i className="legend-dot blue-dot" />r0 TX</span><span><i className="legend-dot violet-dot" />r1 RX</span><span><i className="legend-dot green-dot" />r1 TX</span></div>{traffic.length ? <div className="chart-wrap large-chart"><ResponsiveContainer width="100%" height="100%"><AreaChart data={traffic} margin={{ top: 8, right: 12, left: -10, bottom: 0 }}><defs><linearGradient id="r0rxFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#36d5e8" stopOpacity={0.19} /><stop offset="100%" stopColor="#36d5e8" stopOpacity={0} /></linearGradient><linearGradient id="r1rxFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#9c86ff" stopOpacity={0.15} /><stop offset="100%" stopColor="#9c86ff" stopOpacity={0} /></linearGradient></defs><CartesianGrid stroke="#202a35" strokeDasharray="3 5" vertical={false} /><XAxis dataKey="time" tick={{ fill: '#748292', fontSize: 10 }} axisLine={false} tickLine={false} minTickGap={28} /><YAxis tick={{ fill: '#748292', fontSize: 10 }} axisLine={false} tickLine={false} /><Tooltip content={<ChartTooltip />} /><Area type="monotone" dataKey="r0Rx" name="r0 RX Mbps" stroke="#36d5e8" fill="url(#r0rxFill)" strokeWidth={2} dot={false} connectNulls={false} /><Line type="monotone" dataKey="r0Tx" name="r0 TX Mbps" stroke="#608cff" strokeWidth={1.6} dot={false} connectNulls={false} /><Area type="monotone" dataKey="r1Rx" name="r1 RX Mbps" stroke="#9c86ff" fill="url(#r1rxFill)" strokeWidth={1.6} dot={false} connectNulls={false} /><Line type="monotone" dataKey="r1Tx" name="r1 TX Mbps" stroke="#51ce9e" strokeWidth={1.6} dot={false} connectNulls={false} /></AreaChart></ResponsiveContainer></div> : <EmptyState title="No traffic history yet" text="SNMP measurements will appear here when the collector is running." />}</section>
      <section className="panel chart-panel"><PanelHeader title="Latency and packet loss" subtitle={`QoS probe history · target ${data.qos?.target_ip ?? 'not reported'}`} /><div className="chart-legend-head"><span><i className="legend-dot cyan-dot" />Latency · ms</span><span><i className="legend-dot violet-dot" />Loss · %</span></div>{qos.length ? <div className="chart-wrap large-chart"><ResponsiveContainer width="100%" height="100%"><LineChart data={qos} margin={{ top: 8, right: 10, left: -12, bottom: 0 }}><CartesianGrid stroke="#202a35" strokeDasharray="3 5" vertical={false} /><XAxis dataKey="time" tick={{ fill: '#748292', fontSize: 10 }} axisLine={false} tickLine={false} minTickGap={28} /><YAxis yAxisId="latency" tick={{ fill: '#748292', fontSize: 10 }} axisLine={false} tickLine={false} /><YAxis yAxisId="loss" orientation="right" domain={[0, 'auto']} tick={{ fill: '#748292', fontSize: 10 }} axisLine={false} tickLine={false} /><Tooltip content={<ChartTooltip />} /><Line yAxisId="latency" type="monotone" dataKey="latency" name="Latency (ms)" stroke="#36d5e8" strokeWidth={2} dot={false} activeDot={{ r: 4 }} /><Line yAxisId="loss" type="monotone" dataKey="loss" name="Packet loss (%)" stroke="#9c86ff" strokeWidth={2} dot={false} activeDot={{ r: 4 }} /></LineChart></ResponsiveContainer></div> : <EmptyState title="No QoS history yet" text="QoS measurements will appear here when the monitor records data." />}</section></div>
    <section className="panel recent-panel"><PanelHeader title="Measurement history" subtitle={`${data.metrics.length} recent SNMP records`} /><div className="table-scroll"><table><thead><tr><th>TIME</th><th>INTERFACE</th><th>RX RATE</th><th>TX RATE</th><th>RX BYTES</th><th>TX BYTES</th></tr></thead><tbody>{data.metrics.slice(-12).reverse().map((row) => <tr key={row.id}><td>{formatDateTime(row.timestamp)}</td><td><span className="interface-tag">{row.interface}</span></td><td>{row.rx_mbps === null ? '—' : `${row.rx_mbps.toFixed(5)} Mbps`}</td><td>{row.tx_mbps === null ? '—' : `${row.tx_mbps.toFixed(5)} Mbps`}</td><td>{formatBytes(row.rx_bytes)}</td><td>{formatBytes(row.tx_bytes)}</td></tr>)}</tbody></table>{data.metrics.length === 0 && <EmptyState title="No SNMP measurements" text="Start the SNMP collector to populate this view." />}</div></section>
  </>
}

function SlaPage({ data, events, filter, setFilter, qosFresh }: { data: DashboardData; events: Event[]; filter: 'ALL' | 'OPEN' | 'CLOSED'; setFilter: (value: 'ALL' | 'OPEN' | 'CLOSED') => void; qosFresh: boolean }) {
  const openCount = data.events.filter((event) => event.status === 'OPEN').length
  const closedCount = data.events.filter((event) => event.status === 'CLOSED').length
  return <>
    <div className={`sla-current ${qosFresh && data.qos?.sla_status === 'BREACH' ? 'sla-current-breach' : ''} ${!qosFresh ? 'sla-current-stale' : ''}`}><div className="sla-current-icon">{!qosFresh ? <CircleHelp size={20} /> : data.qos?.sla_status === 'BREACH' ? <AlertTriangle size={20} /> : <ShieldCheck size={20} />}</div><div><span>{qosFresh ? 'CURRENT SERVICE STATE' : 'LAST RECORDED SERVICE STATE'}</span><strong>{qosFresh ? data.qos?.sla_status ?? 'UNKNOWN' : data.qos ? `${data.qos.sla_status} · STALE` : 'UNKNOWN'}</strong><small>{data.qos?.breach_reason ?? (data.qos ? `Monitoring ${data.qos.target_ip} · sample ${timeAgo(data.qos.timestamp)}` : 'Waiting for a QoS sample')}</small></div><div className="sla-current-right"><span>Thresholds</span><b>Latency ≤ 50 ms <i /> Packet loss ≤ 1%</b></div></div>
    <div className="kpi-grid sla-kpis"><KpiCard icon={<AlertTriangle size={17} />} label="OPEN INCIDENTS" value={String(openCount).padStart(2, '0')} detail="Active SLA breaches" accent={openCount ? 'red' : 'green'} /><KpiCard icon={<Check size={17} />} label="RESOLVED INCIDENTS" value={String(closedCount).padStart(2, '0')} detail="Recorded recoveries" accent="green" /><KpiCard icon={<Activity size={17} />} label="LATEST LATENCY" value={data.qos ? formatMeasurement(data.qos.latency_avg_ms, ' ms') : '—'} detail="Current QoS measurement" accent="cyan" /><KpiCard icon={<Wifi size={17} />} label="LATEST PACKET LOSS" value={data.qos ? formatMeasurement(data.qos.packet_loss_pct, '%') : '—'} detail="Current QoS measurement" accent="violet" /></div>
    <section className="panel recent-panel sla-events-panel"><PanelHeader title="Incident history" subtitle={`${data.events.length} total recorded events`} /><div className="filter-tabs">{(['ALL', 'OPEN', 'CLOSED'] as const).map((value) => <button className={filter === value ? 'selected' : ''} key={value} onClick={() => setFilter(value)}>{value[0] + value.slice(1).toLowerCase()}<span>{value === 'ALL' ? data.events.length : value === 'OPEN' ? openCount : closedCount}</span></button>)}</div><EventTable events={events} /></section>
    <div className="threshold-note"><ShieldCheck size={16} /><span>SLA thresholds shown above reflect the QoS monitor configuration. Incident details are read directly from the <code>sla_events</code> history table.</span></div>
  </>
}

function KpiCard({ icon, label, value, detail, accent }: { icon: ReactNode; label: string; value: string; detail: string; accent: string }) {
  return <div className={`kpi-card accent-${accent}`}><div className="kpi-top"><span>{label}</span><i>{icon}</i></div><strong>{value}</strong><small>{detail}</small></div>
}

function PanelHeader({ title, subtitle, action, onAction }: { title: string; subtitle?: string; action?: string; onAction?: () => void }) {
  return <div className="panel-header"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>{action && <button className="panel-action" onClick={onAction}>{action}<ChevronRight size={14} /></button>}</div>
}

function StatePill({ state }: { state: string }) {
  const normalized = state.toUpperCase()
  const tone = ['NORMAL', 'UP', 'AVAILABLE', 'CLOSED'].includes(normalized) ? 'good' : ['BREACH', 'OPEN', 'DOWN'].includes(normalized) ? 'bad' : normalized === 'STALE' ? 'warn' : 'muted'
  return <span className={`state-pill ${tone}`}><i />{state}</span>
}

function EventTable({ events, compact = false }: { events: Event[]; compact?: boolean }) {
  if (!events.length) return <EmptyState title="No SLA events recorded" text="Breach and recovery events will appear here as the monitor detects them." />
  return <div className="table-scroll"><table className={compact ? 'compact-table' : ''}><thead><tr><th>INCIDENT</th><th>SEVERITY</th><th>REASON</th><th>STARTED</th>{!compact && <><th>RESOLVED</th><th>DURATION</th></>}<th>STATUS</th></tr></thead><tbody>{events.map((event) => <tr key={event.id}><td className="incident-id">INC-{String(event.id).padStart(4, '0')}</td><td><span className={`severity ${event.severity.toLowerCase()}`}>{event.severity}</span></td><td className="reason-cell"><span>{event.reason}</span>{event.peak_latency_ms != null && <small>Peak {formatMeasurement(event.peak_latency_ms, ' ms')} · {formatMeasurement(event.peak_packet_loss_pct, '%')} loss</small>}</td><td>{formatDateTime(event.started_at)}</td>{!compact && <><td>{event.resolved_at ? formatDateTime(event.resolved_at) : '—'}</td><td>{formatDuration(event.duration_seconds)}</td></>}<td><StatePill state={event.status} /></td></tr>)}</tbody></table></div>
}

function NodeCard({ kind, icon, name, namespace, address, detail, state }: { kind: string; icon: ReactNode; name: string; namespace: string; address: string; detail: string; state: string }) {
  return <div className={`node-card node-${kind}`}><div className="node-top"><div className="node-icon">{icon}</div><StatePill state={state} /></div><strong>{name}</strong><span className="node-namespace">{namespace}</span><span className="node-address">{address}</span><small>{detail}</small></div>
}

function LinkLine({ label, fresh }: { label: string; fresh: boolean }) {
  return <div className={`network-link ${fresh ? 'link-fresh' : 'link-stale'}`}><div className="link-points"><i /><span /><i /></div><span className="link-label">{label}</span><small>{fresh ? 'SNMP recent' : 'SNMP stale'}</small></div>
}

function InterfaceCard({ name, metric }: { name: string; metric?: Metric }) {
  return <div className="interface-card"><div className="interface-card-top"><span className="interface-tag">{name}</span><span className="interface-source"><span className="live-dot" />SNMP</span></div><div className="interface-rates"><div><ArrowDownToLine size={14} /><span>RX</span><strong>{metric?.rx_mbps == null ? '—' : `${metric.rx_mbps.toFixed(5)} Mbps`}</strong></div><div><ArrowUpFromLine size={14} /><span>TX</span><strong>{metric?.tx_mbps == null ? '—' : `${metric.tx_mbps.toFixed(5)} Mbps`}</strong></div></div><div className="interface-counter"><span>RX {metric ? formatBytes(metric.rx_bytes) : '—'}</span><span>TX {metric ? formatBytes(metric.tx_bytes) : '—'}</span></div><small>Last sample · {metric ? timeAgo(metric.timestamp) : 'No data'}</small></div>
}

function EmptyState({ title, text }: { title: string; text: string }) {
  return <div className="empty-state"><div><Activity size={18} /></div><strong>{title}</strong><span>{text}</span></div>
}

function LoadingState() {
  return <div className="loading-state"><div className="loading-spinner" /><strong>Connecting to assurance API</strong><span>Loading live network and service data…</span></div>
}

function ErrorState({ onRetry }: { onRetry: () => void }) {
  return <div className="error-state"><div><X size={19} /></div><strong>Could not load dashboard data</strong><span>Check that the FastAPI backend is running and the API base URL is correct.</span><button onClick={onRetry}>Try again <RefreshCw size={14} /></button></div>
}

function ChartTooltip({ active, payload, label }: { active?: boolean; payload?: Array<{ name: string; value: number | null }>; label?: string }) {
  if (!active || !payload?.length) return null
  return <div className="chart-tooltip"><span>{label}</span>{payload.map((entry) => <div key={entry.name}><i />{entry.name}<b>{formatMeasurement(entry.value, '', 4)}</b></div>)}</div>
}

function timeLabel(timestamp: string) {
  const date = new Date(timestamp)
  return Number.isNaN(date.getTime()) ? timestamp : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function formatDateTime(timestamp: string) {
  const date = new Date(timestamp)
  return Number.isNaN(date.getTime()) ? timestamp : date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function timeAgo(timestamp: string) {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(timestamp).getTime()) / 1000))
  if (!Number.isFinite(seconds)) return 'time unavailable'
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  return `${Math.floor(seconds / 3600)}h ago`
}

function isFresh(timestamp: string, maxAgeMs = 30_000) {
  const measuredAt = new Date(timestamp).getTime()
  return Number.isFinite(measuredAt) && Date.now() - measuredAt <= maxAgeMs
}

function formatRate(value: number) {
  return value < 0.01 ? value.toFixed(5) : value < 10 ? value.toFixed(3) : value.toFixed(2)
}

function formatMeasurement(value: number | null | undefined, suffix: string, digits = 2) {
  return value == null || !Number.isFinite(value) ? '—' : `${value.toFixed(digits)}${suffix}`
}

function formatBytes(value: number) {
  if (value < 1_000) return `${value} B`
  if (value < 1_000_000) return `${(value / 1_000).toFixed(1)} KB`
  return `${(value / 1_000_000).toFixed(2)} MB`
}

function formatDuration(value: number | null) {
  if (value === null) return '—'
  if (value < 60) return `${value.toFixed(1)} sec`
  const mins = Math.floor(value / 60)
  const secs = Math.floor(value % 60)
  return `${mins}m ${secs}s`
}

export default App
