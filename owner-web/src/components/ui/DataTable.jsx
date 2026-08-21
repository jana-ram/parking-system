// A plain, dependency-free table — this dashboard doesn't need react-table's
// sorting/pagination machinery yet for lists this size (§T's cross-org reads
// cap at 300-500 rows server-side); reach for it later if that changes.
export default function DataTable({ columns, rows, rowKey, emptyLabel = 'Nothing here yet.' }) {
  if (!rows) {
    return <div className="rounded-lg border border-gray-200 bg-white p-6 text-sm text-gray-500">Loading…</div>
  }
  if (rows.length === 0) {
    return <div className="rounded-lg border border-gray-200 bg-white p-6 text-sm text-gray-500">{emptyLabel}</div>
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
      <table className="min-w-full divide-y divide-gray-200 text-sm">
        <thead className="bg-gray-50">
          <tr>
            {columns.map((c) => (
              <th key={c.key} className="px-4 py-2 text-left font-medium text-gray-500">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.map((row) => (
            <tr key={row[rowKey]}>
              {columns.map((c) => (
                <td key={c.key} className="px-4 py-2 text-gray-900">
                  {c.render ? c.render(row) : (row[c.key] ?? '—')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
