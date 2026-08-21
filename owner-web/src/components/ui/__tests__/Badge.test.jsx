import { describe, expect, test } from 'vitest'
import { render, screen } from '@testing-library/react'
import Badge from '../Badge'

describe('Badge', () => {
  test('applies the tone class for a known tone', () => {
    render(<Badge tone="red">Suspicious activity</Badge>)
    expect(screen.getByText('Suspicious activity')).toHaveClass('bg-red-100', 'text-red-700')
  })

  test('falls back to the gray tone for an unrecognized tone rather than rendering no styling', () => {
    render(<Badge tone="not-a-real-tone">Unknown</Badge>)
    expect(screen.getByText('Unknown')).toHaveClass('bg-gray-100', 'text-gray-700')
  })

  test('defaults to gray when no tone is passed at all', () => {
    render(<Badge>Default</Badge>)
    expect(screen.getByText('Default')).toHaveClass('bg-gray-100', 'text-gray-700')
  })
})
