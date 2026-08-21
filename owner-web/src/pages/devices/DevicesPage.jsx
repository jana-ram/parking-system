import { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { deviceAPI } from '../../services/api'
import DataTable from '../../components/ui/DataTable'
import Badge from '../../components/ui/Badge'

const STATUS_TONE = { ACTIVE: 'green', DEACTIVATED: 'gray', SUSPICIOUS: 'red' }

export default function DevicesPage() {
  const [devices, setDevices] = useState(null)

  const load = () => deviceAPI.list().then((res) => setDevices(res.data.data.devices))
  useEffect(() => { load() }, [])

  const handleDeactivate = async (device) => {
    const reason = window.prompt(`Reason for deactivating device ${device.deviceUuid}?`)
    if (!reason) return
    try {
      await deviceAPI.deactivate(device._id, reason)
      toast.success('Device deactivated')
      load()
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not deactivate device')
    }
  }

  return (
    <div>
      <h1 className="text-xl font-semibold text-gray-900">Devices</h1>
      <p className="mt-1 text-sm text-gray-500">Cross-organization registry (§28) — platform-level force-deactivate for support/abuse cases.</p>
      <div className="mt-4">
        <DataTable
          rowKey="_id"
          rows={devices}
          columns={[
            { key: 'deviceUuid', label: 'Device UUID' },
            { key: 'org', label: 'Organization', render: (r) => r.organizationId?.name ?? '—' },
            { key: 'platform', label: 'Platform' },
            { key: 'status', label: 'Status', render: (r) => <Badge tone={STATUS_TONE[r.status]}>{r.status}</Badge> },
            { key: 'lastActiveAt', label: 'Last active', render: (r) => (r.lastActiveAt ? new Date(r.lastActiveAt).toLocaleString() : '—') },
            {
              key: 'actions',
              label: '',
              render: (r) =>
                r.status === 'ACTIVE' ? (
                  <button onClick={() => handleDeactivate(r)} className="text-xs font-medium text-red-700 hover:underline">
                    Deactivate
                  </button>
                ) : null,
            },
          ]}
        />
      </div>
    </div>
  )
}
