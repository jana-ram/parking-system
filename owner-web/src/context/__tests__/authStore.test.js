import { beforeEach, describe, expect, test } from 'vitest'
import { useAuthStore } from '../authStore'

// Platform-admin auth store (§1.7) — separate token key (`platform_token`)
// and separate zustand store from anything tenant-side, by construction.
describe('useAuthStore', () => {
  beforeEach(() => {
    localStorage.clear()
    useAuthStore.setState({ admin: null, isAuthenticated: !!localStorage.getItem('platform_token') })
  })

  test('starts unauthenticated with no stored token', () => {
    expect(useAuthStore.getState().isAuthenticated).toBe(false)
    expect(useAuthStore.getState().admin).toBeNull()
  })

  test('login persists the token and flips isAuthenticated', () => {
    const admin = { name: 'Owner', email: 'owner@test.com' }
    useAuthStore.getState().login('a-jwt-token', admin)

    expect(localStorage.getItem('platform_token')).toBe('a-jwt-token')
    expect(useAuthStore.getState().isAuthenticated).toBe(true)
    expect(useAuthStore.getState().admin).toEqual(admin)
  })

  test('logout clears the stored token and resets state', () => {
    useAuthStore.getState().login('a-jwt-token', { name: 'Owner' })
    useAuthStore.getState().logout()

    expect(localStorage.getItem('platform_token')).toBeNull()
    expect(useAuthStore.getState().isAuthenticated).toBe(false)
    expect(useAuthStore.getState().admin).toBeNull()
  })
})
