export type QoS = {
  id: number
  timestamp: string
  target_ip: string
  packets_sent: number
  packets_received: number
  packet_loss_pct: number
  latency_avg_ms: number
  sla_status: string
  breach_reason: string | null
}

export type Metric = {
  id: number
  timestamp: string
  interface: string
  rx_bytes: number
  tx_bytes: number
  rx_mbps: number | null
  tx_mbps: number | null
}

export type Event = {
  id: number
  started_at: string
  resolved_at: string | null
  severity: string
  reason: string
  peak_latency_ms: number | null
  peak_packet_loss_pct: number | null
  duration_seconds: number | null
  status: string
}

export type SystemStatus = {
  status: string
  database: string
  latest_qos: Pick<QoS, 'timestamp' | 'target_ip' | 'sla_status'> | null
  latest_traffic: Pick<Metric, 'timestamp' | 'interface'> | null
  open_sla_event: Pick<Event, 'id' | 'started_at' | 'severity' | 'reason'> | null
}

export type InterfacesResource = { 'telecom:interfaces': { interface: Metric[] } }
export type ServicesResource = {
  'telecom:services': {
    service: Array<{
      name: string
      status: string
      'latest-measurement': QoS | null
      'open-sla-event': Event | null
    }>
  }
}

export type ListResponse<T> = { count: number; limit: number; data: T[] }

export type Prediction = {
  available: boolean
  reason?: string
  risk_score_pct?: number
  horizon_samples?: number
  current_sla_status?: string
  latest_sample_timestamp?: string
  new_samples_since_training?: number
  score_type?: string
  experimental?: boolean
}
