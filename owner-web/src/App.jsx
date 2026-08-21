import { Navigate, Route, Routes } from 'react-router-dom'
import AppShell from './components/layout/AppShell'
import PlaceholderPage from './components/ui/PlaceholderPage'
import LoginPage from './pages/LoginPage'
import OverviewPage from './pages/overview/OverviewPage'
import OrganizationsPage from './pages/organizations/OrganizationsPage'
import CountriesPage from './pages/countries/CountriesPage'
import LocationsPage from './pages/locations/LocationsPage'
import DevicesPage from './pages/devices/DevicesPage'
import AnomaliesPage from './pages/anomalies/AnomaliesPage'
import IncidentsPage from './pages/incidents/IncidentsPage'
import AuditPage from './pages/audit/AuditPage'
import { useAuthStore } from './context/authStore'

function ProtectedRoute({ children }) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)
  return isAuthenticated ? children : <Navigate to="/login" replace />
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        element={
          <ProtectedRoute>
            <AppShell />
          </ProtectedRoute>
        }
      >
        <Route path="/" element={<Navigate to="/overview" replace />} />
        <Route path="/overview" element={<OverviewPage />} />
        <Route path="/organizations" element={<OrganizationsPage />} />
        <Route path="/countries" element={<CountriesPage />} />
        <Route path="/locations" element={<LocationsPage />} />
        <Route path="/devices" element={<DevicesPage />} />
        <Route path="/subscriptions" element={<PlaceholderPage title="Subscriptions" />} />
        <Route path="/analytics" element={<PlaceholderPage title="Platform Analytics" />} />
        <Route path="/system-health" element={<IncidentsPage title="System Health" />} />
        <Route path="/sync-incidents" element={<IncidentsPage title="Sync Incidents" />} />
        <Route path="/anomalies" element={<AnomaliesPage />} />
        <Route path="/audit" element={<AuditPage />} />
        <Route path="/support" element={<PlaceholderPage title="Support / Ops" />} />
      </Route>
      <Route path="*" element={<Navigate to="/overview" replace />} />
    </Routes>
  )
}
