import { useEffect, useState } from 'react'
import { auditAPI, organizationAPI } from '../../services/api'
import DataTable from '../../components/ui/DataTable'

/**
 * §T's audit drill-in for support cases. [Phase 8 scope note] This view
 * itself is not yet self-audited — see platformAudit.controller.js's header
 * for exactly why (AuditLog.organizationId is required, so a platform-only
 * "who looked at whose data" event has nowhere to attach without a schema
 * change this pass didn't make).
 */
export default function AuditPage() {
  const [logs, setLogs] = useState(null)
  const [orgs, setOrgs] = useState([])
  const [organizationId, setOrganizationId] = useState('')

  useEffect(() => {
    organizationAPI.list().then((res) => setOrgs(res.data.data.organizations))
  }, [])

  useEffect(() => {
    auditAPI.list(organizationId ? { organizationId } : undefined).then((res) => setLogs(res.data.data.logs))
  }, [organizationId])

  return (
    <div>
      <h1 className="text-xl font-semibold text-gray-900">Audit</h1>
      <select value={organizationId} onChange={(e) => setOrganizationId(e.target.value)} className="mt-4 h-9 rounded-md border border-gray-300 px-2 text-sm">
        <option value="">All organizations</option>
        {orgs.map((o) => (
          <option key={o._id} value={o._id}>{o.name}</option>
        ))}
      </select>

      <div className="mt-4">
        <DataTable
          rowKey="_id"
          rows={logs}
          columns={[
            { key: 'action', label: 'Action' },
            { key: 'org', label: 'Organization', render: (r) => r.organizationId?.name ?? '—' },
            { key: 'actorRole', label: 'Actor role' },
            { key: 'entityType', label: 'Entity' },
            { key: 'createdAt', label: 'When', render: (r) => new Date(r.createdAt).toLocaleString() },
          ]}
        />
      </div>
    </div>
  )
}
