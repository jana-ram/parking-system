import { useEffect, useState } from 'react'
import { incidentAPI } from '../../services/api'
import DataTable from '../../components/ui/DataTable'
import Badge from '../../components/ui/Badge'

const SEVERITY_TONE = { LOW: 'gray', MEDIUM: 'amber', HIGH: 'red', CRITICAL: 'red' }

/**
 * Serves both "Sync Incidents" and "System Health" nav entries — the
 * backend has one Incident model covering shift-abandoned/sync-conflict/
 * sync-retry-exhausted types (§27), not yet split into a separate
 * latency/queue-depth "system health" surface (that's genuinely an
 * observability/Phase 9 concern once there's a real deployment to observe,
 * per server.js's Phase 6 status comment). `title` distinguishes the two
 * entry points without duplicating the page.
 */
export default function IncidentsPage({ title = 'Incidents' }) {
  const [incidents, setIncidents] = useState(null)
  const [severity, setSeverity] = useState('')

  useEffect(() => {
    incidentAPI.list(severity ? { severity } : undefined).then((res) => setIncidents(res.data.data.incidents))
  }, [severity])

  return (
    <div>
      <h1 className="text-xl font-semibold text-gray-900">{title}</h1>
      <select value={severity} onChange={(e) => setSeverity(e.target.value)} className="mt-4 h-9 rounded-md border border-gray-300 px-2 text-sm">
        <option value="">All severities</option>
        {['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].map((s) => (
          <option key={s} value={s}>{s}</option>
        ))}
      </select>

      <div className="mt-4">
        <DataTable
          rowKey="_id"
          rows={incidents}
          columns={[
            { key: 'type', label: 'Type' },
            { key: 'org', label: 'Organization', render: (r) => r.organizationId?.name ?? 'Platform' },
            { key: 'severity', label: 'Severity', render: (r) => <Badge tone={SEVERITY_TONE[r.severity]}>{r.severity}</Badge> },
            { key: 'description', label: 'Description' },
            { key: 'status', label: 'Status' },
            { key: 'createdAt', label: 'Created', render: (r) => new Date(r.createdAt).toLocaleString() },
          ]}
        />
      </div>
    </div>
  )
}
