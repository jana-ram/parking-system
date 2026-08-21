// Same pattern as nammaraidu-web/admin/src/config/navPermissions.js — this is
// CLIENT-SIDE navigation gating for usability only, never the security
// boundary (§O/§3/§34). The backend's /platform/* router is what actually
// enforces access; hiding a nav item here just avoids showing platform staff
// a module they don't use day to day.
export const NAV_ITEMS = [
  { key: 'overview', label: 'Overview', path: '/overview' },
  { key: 'organizations', label: 'Organizations', path: '/organizations' },
  { key: 'countries', label: 'Countries', path: '/countries' },
  { key: 'locations', label: 'Locations', path: '/locations' },
  { key: 'devices', label: 'Devices', path: '/devices' },
  { key: 'subscriptions', label: 'Subscriptions', path: '/subscriptions' },
  { key: 'analytics', label: 'Platform Analytics', path: '/analytics' },
  { key: 'system-health', label: 'System Health', path: '/system-health' },
  { key: 'sync-incidents', label: 'Sync Incidents', path: '/sync-incidents' },
  { key: 'anomalies', label: 'Anomaly Monitoring', path: '/anomalies' },
  { key: 'audit', label: 'Audit', path: '/audit' },
  { key: 'support', label: 'Support / Ops', path: '/support' },
]
