import { describe, expect, test } from 'vitest'
import { render, screen } from '@testing-library/react'
import DataTable from '../DataTable'

const columns = [
  { key: 'name', label: 'Name' },
  { key: 'status', label: 'Status', render: (row) => row.status.toUpperCase() },
]

describe('DataTable', () => {
  test('shows a loading state when rows is undefined/null (still fetching)', () => {
    render(<DataTable columns={columns} rows={null} rowKey="id" />)
    expect(screen.getByText('Loading…')).toBeInTheDocument()
  })

  test('shows the empty label once rows has resolved to an empty array', () => {
    render(<DataTable columns={columns} rows={[]} rowKey="id" emptyLabel="No organizations yet." />)
    expect(screen.getByText('No organizations yet.')).toBeInTheDocument()
  })

  test('renders one row per item, using a column render() when provided and the raw field otherwise', () => {
    const rows = [{ id: '1', name: 'Acme Parking', status: 'active' }]
    render(<DataTable columns={columns} rows={rows} rowKey="id" />)
    expect(screen.getByText('Acme Parking')).toBeInTheDocument()
    expect(screen.getByText('ACTIVE')).toBeInTheDocument()
  })

  test('falls back to an em dash for a missing field with no render()', () => {
    const rows = [{ id: '1', name: null, status: 'active' }]
    render(<DataTable columns={columns} rows={rows} rowKey="id" />)
    expect(screen.getByText('—')).toBeInTheDocument()
  })
})
