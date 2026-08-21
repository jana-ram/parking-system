import { useEffect, useState } from 'react'
import { locationAPI } from '../../services/api'
import DataTable from '../../components/ui/DataTable'
import Badge from '../../components/ui/Badge'

export default function LocationsPage() {
  const [locations, setLocations] = useState(null)

  useEffect(() => {
    locationAPI.list().then((res) => setLocations(res.data.data.locations))
  }, [])

  return (
    <div>
      <h1 className="text-xl font-semibold text-gray-900">Parking Locations</h1>
      <p className="mt-1 text-sm text-gray-500">Cross-organization view (§T) — read-only here; location setup happens in the tenant mobile app (§5).</p>
      <div className="mt-4">
        <DataTable
          rowKey="_id"
          rows={locations}
          columns={[
            { key: 'name', label: 'Name' },
            { key: 'org', label: 'Organization', render: (r) => r.organizationId?.name ?? '—' },
            { key: 'currency', label: 'Currency' },
            { key: 'timezone', label: 'Timezone' },
            { key: 'status', label: 'Status', render: (r) => <Badge tone={r.status === 'ACTIVE' ? 'green' : 'gray'}>{r.status}</Badge> },
          ]}
        />
      </div>
    </div>
  )
}
