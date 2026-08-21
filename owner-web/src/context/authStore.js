import { create } from 'zustand'

// Same shape as nammaraidu-web/admin/src/context/authStore.js, pointed at the
// separate /platform/auth/login endpoint (§1.7) rather than tenant auth.
export const useAuthStore = create((set) => ({
  admin: null,
  isAuthenticated: !!localStorage.getItem('platform_token'),

  login: (token, admin) => {
    localStorage.setItem('platform_token', token)
    set({ admin, isAuthenticated: true })
  },

  logout: () => {
    localStorage.removeItem('platform_token')
    set({ admin: null, isAuthenticated: false })
  },
}))
