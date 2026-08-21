import axios from 'axios'

// Talks ONLY to the backend's /platform/* router (§1.7 / §B) — the tenant API
// surface is a structurally separate set of routes this app never calls.
const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:5100'

const api = axios.create({
  baseURL: `${API_URL}/platform`,
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
  login: (email, password) => api.post('/auth/login', { email, password }),
}

export const countryAPI = {
  list: () => api.get('/countries'),
  create: (data) => api.post('/countries', data),
}

export const organizationAPI = {
  list: () => api.get('/organizations'),
  get: (id) => api.get(`/organizations/${id}`),
  create: (data) => api.post('/organizations', data),
  updateStatus: (id, status) => api.patch(`/organizations/${id}/status`, { status }),
}

export const locationAPI = {
  list: () => api.get('/locations'),
}

export const deviceAPI = {
  list: () => api.get('/devices'),
  deactivate: (id, reason) => api.post(`/devices/${id}/deactivate`, { reason }),
}

export const anomalyAPI = {
  list: (riskLevel) => api.get('/anomalies', { params: riskLevel ? { riskLevel } : undefined }),
}

export const incidentAPI = {
  list: (params) => api.get('/incidents', { params }),
}

export const auditAPI = {
  list: (params) => api.get('/audit', { params }),
}

export const analyticsAPI = {
  overview: () => api.get('/analytics/overview'),
}

export default api
