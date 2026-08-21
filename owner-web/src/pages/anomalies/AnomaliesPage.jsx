import { useEffect, useState } from 'react'
import { anomalyAPI } from '../../services/api'
import Badge from '../../components/ui/Badge'

const RISK_TONE = { LOW: 'gray', MEDIUM: 'amber', HIGH: 'red', CRITICAL: 'red' }
const LEVELS = ['', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']

// §20: "Do NOT automatically accuse staff of theft" — this page only ever
// shows "suspicious activity detected — review required" framing, matching
// the wording the backend itself uses (anomaly.controller.js).
export default function AnomaliesPage() {
  const [anomalies, setAnomalies] = useState(null)
  const [riskLevel, setRiskLevel] = useState('')

  useEffect(() => {
    anomalyAPI.list(riskLevel || undefined).then((res) => setAnomalies(res.data.data.anomalies))
  }, [riskLevel])

  return (
    <div>
      <h1 className="text-xl font-semibold text-gray-900">Anomaly Monitoring</h1>
      <p className="mt-1 text-sm text-gray-500">Suspicious activity detected — review required. Explainable, cross-organization (§20).</p>

      <select value={riskLevel} onChange={(e) => setRiskLevel(e.target.value)} className="mt-4 h-9 rounded-md border border-gray-300 px-2 text-sm">
        {LEVELS.map((l) => (
          <option key={l} value={l}>{l || 'All risk levels'}</option>
        ))}
      </select>

      <div className="mt-4 space-y-3">
        {anomalies === null && <div className="rounded-lg border border-gray-200 bg-white p-6 text-sm text-gray-500">Loading…</div>}
        {anomalies?.length === 0 && <div className="rounded-lg border border-gray-200 bg-white p-6 text-sm text-gray-500">No anomalies flagged.</div>}
        {anomalies?.map((a) => (
          <div key={a._id} className="rounded-lg border border-gray-200 bg-white p-4">
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium text-gray-900">
                {a.organizationId?.name ?? 'Unknown org'} · {a.subjectType} · risk score {a.riskScore}
              </div>
              <Badge tone={RISK_TONE[a.riskLevel]}>{a.riskLevel}</Badge>
            </div>
            <ul className="mt-2 list-inside list-disc text-sm text-gray-600">
              {a.reasons.map((r, i) => (
                <li key={i}>{r.detail}</li>
              ))}
            </ul>
            <div className="mt-2 text-xs text-gray-400">{new Date(a.createdAt).toLocaleString()} · {a.status}</div>
          </div>
        ))}
      </div>
    </div>
  )
}
