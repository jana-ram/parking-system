import { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { organizationAPI, countryAPI, moduleAPI } from '../../services/api'
import DataTable from '../../components/ui/DataTable'
import Badge from '../../components/ui/Badge'

const STATUS_TONE = { ACTIVE: 'green', SUSPENDED: 'amber', CANCELLED: 'red' }

export default function OrganizationsPage() {
  const [orgs, setOrgs] = useState(null)
  const [countries, setCountries] = useState([])
  const [modalOpen, setModalOpen] = useState(false)
  const [form, setForm] = useState({ name: '', code: '', countryId: '', defaultCurrency: '', defaultTimezone: '', adminName: '', adminPhone: '', adminPassword: '' })
  const [creating, setCreating] = useState(false)

  // §2: Super Admin per-tenant module toggles.
  const [moduleKeys, setModuleKeys] = useState([])
  const [moduleLabels, setModuleLabels] = useState({})
  const [modulesOrg, setModulesOrg] = useState(null)
  const [modulesForm, setModulesForm] = useState({})
  const [savingModules, setSavingModules] = useState(false)

  const load = () => organizationAPI.list().then((res) => setOrgs(res.data.data.organizations))

  useEffect(() => {
    load()
    countryAPI.list().then((res) => setCountries(res.data.data.countries))
    moduleAPI.list().then((res) => {
      setModuleKeys(res.data.data.keys)
      setModuleLabels(res.data.data.labels)
    })
  }, [])

  const openModulesModal = (org) => {
    setModulesForm(Object.fromEntries(moduleKeys.map((key) => [key, Boolean(org.modules?.[key])])))
    setModulesOrg(org)
  }

  const handleModulesSave = async (e) => {
    e.preventDefault()
    setSavingModules(true)
    try {
      await organizationAPI.updateModules(modulesOrg._id, modulesForm)
      toast.success(`${modulesOrg.name}'s modules updated`)
      setModulesOrg(null)
      load()
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not update modules')
    } finally {
      setSavingModules(false)
    }
  }

  const handleCreate = async (e) => {
    e.preventDefault()
    setCreating(true)
    try {
      await organizationAPI.create({
        name: form.name,
        code: form.code,
        countryId: form.countryId,
        defaultCurrency: form.defaultCurrency,
        defaultTimezone: form.defaultTimezone,
        orgAdmin: { name: form.adminName, phone: form.adminPhone, password: form.adminPassword },
      })
      toast.success('Organization created')
      setModalOpen(false)
      setForm({ name: '', code: '', countryId: '', defaultCurrency: '', defaultTimezone: '', adminName: '', adminPhone: '', adminPassword: '' })
      load()
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not create organization')
    } finally {
      setCreating(false)
    }
  }

  const handleStatusChange = async (org, status) => {
    try {
      await organizationAPI.updateStatus(org._id, status)
      toast.success(`${org.name} is now ${status}`)
      load()
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not update status')
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-gray-900">Organizations</h1>
        <button onClick={() => setModalOpen(true)} className="rounded-md bg-gray-900 px-3 py-1.5 text-sm font-medium text-white">
          + New Organization
        </button>
      </div>

      <div className="mt-4">
        <DataTable
          rowKey="_id"
          rows={orgs}
          columns={[
            { key: 'name', label: 'Name' },
            { key: 'code', label: 'Code' },
            { key: 'defaultCurrency', label: 'Currency' },
            { key: 'status', label: 'Status', render: (r) => <Badge tone={STATUS_TONE[r.status]}>{r.status}</Badge> },
            {
              key: 'actions',
              label: '',
              render: (r) => (
                <div className="flex gap-2">
                  <button onClick={() => openModulesModal(r)} className="text-xs font-medium text-gray-700 hover:underline">
                    Modules
                  </button>
                  {r.status === 'ACTIVE' && (
                    <button onClick={() => handleStatusChange(r, 'SUSPENDED')} className="text-xs font-medium text-amber-700 hover:underline">
                      Suspend
                    </button>
                  )}
                  {r.status === 'SUSPENDED' && (
                    <button onClick={() => handleStatusChange(r, 'ACTIVE')} className="text-xs font-medium text-green-700 hover:underline">
                      Reinstate
                    </button>
                  )}
                </div>
              ),
            },
          ]}
        />
      </div>

      {modalOpen && (
        <div className="fixed inset-0 z-10 flex items-center justify-center bg-gray-900/40">
          <form onSubmit={handleCreate} className="w-full max-w-md rounded-lg bg-white p-6">
            <h2 className="mb-4 text-lg font-semibold text-gray-900">New Organization</h2>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Name" value={form.name} onChange={(v) => setForm({ ...form, name: v })} />
              <Field label="Code (slug)" value={form.code} onChange={(v) => setForm({ ...form, code: v.toLowerCase() })} />
              <div className="col-span-2">
                <label className="block text-sm text-gray-700">Country</label>
                <select
                  required
                  value={form.countryId}
                  onChange={(e) => {
                    const c = countries.find((x) => x._id === e.target.value)
                    setForm({ ...form, countryId: e.target.value, defaultCurrency: c?.defaultCurrency ?? '', defaultTimezone: c?.defaultTimezone ?? '' })
                  }}
                  className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                >
                  <option value="">Select…</option>
                  {countries.map((c) => (
                    <option key={c._id} value={c._id}>{c.name}</option>
                  ))}
                </select>
              </div>
              <Field label="Currency" value={form.defaultCurrency} onChange={(v) => setForm({ ...form, defaultCurrency: v.toUpperCase() })} />
              <Field label="Timezone" value={form.defaultTimezone} onChange={(v) => setForm({ ...form, defaultTimezone: v })} />
            </div>
            <h3 className="mb-2 mt-4 text-sm font-semibold text-gray-700">First Org Admin</h3>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Name" value={form.adminName} onChange={(v) => setForm({ ...form, adminName: v })} />
              <Field label="Phone" value={form.adminPhone} onChange={(v) => setForm({ ...form, adminPhone: v })} />
              <Field label="Password" type="password" value={form.adminPassword} onChange={(v) => setForm({ ...form, adminPassword: v })} />
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={() => setModalOpen(false)} className="rounded-md px-3 py-1.5 text-sm text-gray-600">
                Cancel
              </button>
              <button type="submit" disabled={creating} className="rounded-md bg-gray-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">
                {creating ? 'Creating…' : 'Create'}
              </button>
            </div>
          </form>
        </div>
      )}

      {modulesOrg && (
        <div className="fixed inset-0 z-10 flex items-center justify-center bg-gray-900/40">
          <form onSubmit={handleModulesSave} className="w-full max-w-md rounded-lg bg-white p-6">
            <h2 className="mb-1 text-lg font-semibold text-gray-900">Modules</h2>
            <p className="mb-4 text-sm text-gray-500">{modulesOrg.name} — enabled here are enforced by the API, not just hidden in a UI.</p>
            <div className="space-y-2">
              {moduleKeys.map((key) => (
                <label key={key} className="flex items-center gap-2 text-sm text-gray-700">
                  <input
                    type="checkbox"
                    checked={Boolean(modulesForm[key])}
                    onChange={(e) => setModulesForm({ ...modulesForm, [key]: e.target.checked })}
                    className="h-4 w-4 rounded border-gray-300"
                  />
                  {moduleLabels[key] || key}
                </label>
              ))}
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={() => setModulesOrg(null)} className="rounded-md px-3 py-1.5 text-sm text-gray-600">
                Cancel
              </button>
              <button type="submit" disabled={savingModules} className="rounded-md bg-gray-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">
                {savingModules ? 'Saving…' : 'Save'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}

function Field({ label, value, onChange, type = 'text' }) {
  return (
    <div>
      <label className="block text-sm text-gray-700">{label}</label>
      <input
        required
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
      />
    </div>
  )
}
