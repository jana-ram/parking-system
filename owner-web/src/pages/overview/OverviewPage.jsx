import { useEffect, useState } from 'react'
import { analyticsAPI } from '../../services/api'

// Real KPI tiles, backed by GET /platform/analytics/overview (Phase 8).
const TILE_DEFS = [
  { key: 'organizations', label: 'Organizations' },
  { key: 'locations', label: 'Locations' },
  { key: 'devices', label: 'Devices' },
  { key: 'vehiclesToday', label: 'Vehicles today (UTC day)' },
]

export default function OverviewPage() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    analyticsAPI
      .overview()
      .then((res) => setData(res.data.data))
      .finally(() => setLoading(false))
  }, [])

  return (
    <div>
      <h1 className="text-xl font-semibold text-gray-900">Overview</h1>
      <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
        {TILE_DEFS.map((t) => (
          <div key={t.key} className="rounded-lg border border-gray-200 bg-white p-4">
            <div className="text-sm text-gray-500">{t.label}</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums text-gray-900">
              {loading ? '—' : (data?.[t.key] ?? '—')}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
