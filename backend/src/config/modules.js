/**
 * Feature-module registry — the single source of truth for which tenant
 * modules exist (§2 of the platform brief: Super Admin controls which
 * features are enabled per Organization). Adding a future module (e.g. once
 * Rack Management gets real endpoints) is a one-line addition here plus a
 * matching key in Organization.js's `modules` sub-schema and
 * schemas.js's `updateOrganizationModules` — no other migration needed.
 */
const MODULE_KEYS = [
  'PARKING',
  'RACK',
  'LUGGAGE',
  'PARCEL',
  'BILLING',
  'REPORTS',
  'NOTIFICATIONS',
  'CUSTOMER_SELF_SERVICE',
  'AI_ASSISTANT',
]

const MODULE_LABELS = {
  PARKING: 'Vehicle Parking',
  RACK: 'Rack Management',
  LUGGAGE: 'Luggage Storage',
  PARCEL: 'Parcel Storage',
  BILLING: 'Billing',
  REPORTS: 'Advanced Reports',
  NOTIFICATIONS: 'Notifications',
  CUSTOMER_SELF_SERVICE: 'Customer Self-Service',
  AI_ASSISTANT: 'AI Assistant',
}

// Applied to any Organization missing a `modules` field (new docs already get
// this from the schema defaults in Organization.js; this is for the
// boot-time backfill of pre-existing docs, seed.js's backfillOrgModuleDefaults).
const DEFAULT_MODULES = { PARKING: true, REPORTS: true }

module.exports = { MODULE_KEYS, MODULE_LABELS, DEFAULT_MODULES }
