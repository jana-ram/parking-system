import axios from 'axios'

// Talks ONLY to the backend's /platform/* router (§1.7 / §B) — the tenant API
// surface is a structurally separate set of routes this app never calls.
const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:5100'

const api = axios.create({
  baseURL: `${API_URL}/parking-api`,
  timeout: 15000,
})

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('platform_token')
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

api.interceptors.response.use(
  (r) => r,
  (err) => {
    if (err.response?.status === 401) {
      localStorage.removeItem('platform_token')
      window.location.href = '/login'
    }
    return Promise.reject(err)
  },
)

export const authAPI = {
  login: (email, password) => api.post('/platform/auth/login', { email, password }),
}

export const countryAPI = {
  list: () => api.get('/platform/countries'),
  create: (data) => api.post('/platform/countries', data),
}

export const organizationAPI = {
  list: () => api.get('/platform/organizations'),
  get: (id) => api.get(`/platform/organizations/${id}`),
  create: (data) => api.post('/platform/organizations', data),
  updateStatus: (id, status) => api.patch(`/platform/organizations/${id}/status`, { status }),
}

export const locationAPI = {
  list: () => api.get('/platform/locations'),
}

export const deviceAPI = {
  list: () => api.get('/platform/devices'),
  deactivate: (id, reason) => api.post(`/platform/devices/${id}/deactivate`, { reason }),
}

export const anomalyAPI = {
  list: (riskLevel) => api.get('/platform/anomalies', { params: riskLevel ? { riskLevel } : undefined }),
}

export const incidentAPI = {
  list: (params) => api.get('/platform/incidents', { params }),
}

export const auditAPI = {
  list: (params) => api.get('/platform/audit', { params }),
}

export const analyticsAPI = {
  overview: () => api.get('/platform/analytics/overview'),
}

export default api
