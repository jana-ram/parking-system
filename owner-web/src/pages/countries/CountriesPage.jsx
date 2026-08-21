import { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { countryAPI } from '../../services/api'
import DataTable from '../../components/ui/DataTable'

export default function CountriesPage() {
  const [countries, setCountries] = useState(null)
  const [form, setForm] = useState({ isoCode: '', name: '', defaultCurrency: '', defaultTimezone: '' })
  const [creating, setCreating] = useState(false)

  const load = () => countryAPI.list().then((res) => setCountries(res.data.data.countries))
  useEffect(() => { load() }, [])

  const handleAdd = async (e) => {
    e.preventDefault()
    setCreating(true)
    try {
      await countryAPI.create({ ...form, isoCode: form.isoCode.toUpperCase(), defaultCurrency: form.defaultCurrency.toUpperCase() })
      toast.success('Country added')
      setForm({ isoCode: '', name: '', defaultCurrency: '', defaultTimezone: '' })
      load()
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not add country')
    } finally {
      setCreating(false)
    }
  }

  return (
    <div>
      <h1 className="text-xl font-semibold text-gray-900">Countries</h1>
      <p className="mt-1 text-sm text-gray-500">Reference data (§31) — currency/timezone defaults new organizations inherit.</p>

      <form onSubmit={handleAdd} className="mt-4 flex flex-wrap items-end gap-2 rounded-lg border border-gray-200 bg-white p-4">
        <MiniField label="ISO code" value={form.isoCode} onChange={(v) => setForm({ ...form, isoCode: v })} maxLength={2} />
        <MiniField label="Name" value={form.name} onChange={(v) => setForm({ ...form, name: v })} />
        <MiniField label="Currency" value={form.defaultCurrency} onChange={(v) => setForm({ ...form, defaultCurrency: v })} maxLength={3} />
        <MiniField label="Timezone" value={form.defaultTimezone} onChange={(v) => setForm({ ...form, defaultTimezone: v })} placeholder="Asia/Kolkata" />
        <button disabled={creating} className="h-9 rounded-md bg-gray-900 px-3 text-sm font-medium text-white disabled:opacity-50">
          {creating ? 'Adding…' : 'Add'}
        </button>
      </form>

      <div className="mt-4">
        <DataTable
          rowKey="_id"
          rows={countries}
          columns={[
            { key: 'isoCode', label: 'ISO' },
            { key: 'name', label: 'Name' },
            { key: 'defaultCurrency', label: 'Currency' },
            { key: 'defaultTimezone', label: 'Timezone' },
          ]}
        />
      </div>
    </div>
  )
}

function MiniField({ label, value, onChange, maxLength, placeholder }) {
  return (
    <div>
      <label className="block text-xs text-gray-500">{label}</label>
      <input
        required
        value={value}
        maxLength={maxLength}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 h-9 w-32 rounded-md border border-gray-300 px-2 text-sm"
      />
    </div>
  )
}
