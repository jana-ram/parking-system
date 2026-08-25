const Joi = require('joi')

const staffLogin = Joi.object({
  orgCode: Joi.string().trim().lowercase().required(),
  phone: Joi.string().trim().required(),
  password: Joi.string().min(6).required(),
})

// ── Platform (§1.7) ─────────────────────────────────────────────────────
const platformLogin = Joi.object({
  email: Joi.string().trim().lowercase().email().required(),
  password: Joi.string().min(6).required(),
})

const createOrganization = Joi.object({
  name: Joi.string().trim().min(2).max(120).required(),
  code: Joi.string().trim().lowercase().pattern(/^[a-z0-9-]+$/).min(2).max(60).required(),
  countryId: Joi.string().hex().length(24).required(),
  defaultCurrency: Joi.string().trim().uppercase().length(3).required(),
  defaultTimezone: Joi.string().trim().required(),
  orgAdmin: Joi.object({
    name: Joi.string().trim().min(2).max(120).required(),
    phone: Joi.string().trim().required(),
    password: Joi.string().min(6).required(),
  }).required(),
})

const updateOrganizationStatus = Joi.object({
  status: Joi.string().valid('ACTIVE', 'SUSPENDED', 'CANCELLED').required(),
})

const createCountry = Joi.object({
  isoCode: Joi.string().trim().uppercase().length(2).required(),
  name: Joi.string().trim().min(2).max(80).required(),
  defaultCurrency: Joi.string().trim().uppercase().length(3).required(),
  defaultTimezone: Joi.string().trim().required(),
})

// ── Org / Location (§4, §5) ─────────────────────────────────────────────
const updateOrg = Joi.object({
  name: Joi.string().trim().min(2).max(120),
  defaultCurrency: Joi.string().trim().uppercase().length(3),
  defaultTimezone: Joi.string().trim(),
}).min(1)

const createLocation = Joi.object({
  countryId: Joi.string().hex().length(24).required(),
  name: Joi.string().trim().min(2).max(120).required(),
  address: Joi.string().trim().allow('', null),
  geo: Joi.object({ lat: Joi.number().min(-90).max(90).required(), lng: Joi.number().min(-180).max(180).required() }).required(),
  geofenceRadiusM: Joi.number().integer().min(10).max(5000),
  timezone: Joi.string().trim().required(),
  currency: Joi.string().trim().uppercase().length(3).required(),
})

const locationFeaturesSchema = Joi.object({
  exitDiscount: Joi.object({ enabled: Joi.boolean().required() }),
  fixedEntryNoExit: Joi.object({ enabled: Joi.boolean().required() }),
  slotAssignment: Joi.object({ enabled: Joi.boolean().required() }),
}).unknown(false)

const updateLocation = Joi.object({
  name: Joi.string().trim().min(2).max(120),
  address: Joi.string().trim().allow('', null),
  geo: Joi.object({ lat: Joi.number().min(-90).max(90).required(), lng: Joi.number().min(-180).max(180).required() }),
  geofenceRadiusM: Joi.number().integer().min(10).max(5000),
  timezone: Joi.string().trim(),
  currency: Joi.string().trim().uppercase().length(3),
  status: Joi.string().valid('ACTIVE', 'INACTIVE'),
  features: locationFeaturesSchema,
}).min(1)

// ── Staff (§3, §O) ───────────────────────────────────────────────────────
const createStaff = Joi.object({
  name: Joi.string().trim().min(2).max(120).required(),
  phone: Joi.string().trim().required(),
  email: Joi.string().trim().lowercase().email().allow('', null),
  password: Joi.string().min(6).required(),
  role: Joi.string().valid('ORG_ADMIN', 'MANAGER', 'STAFF').required(),
})

const updateStaff = Joi.object({
  name: Joi.string().trim().min(2).max(120),
  email: Joi.string().trim().lowercase().email().allow('', null),
  role: Joi.string().valid('ORG_ADMIN', 'MANAGER', 'STAFF'),
  status: Joi.string().valid('ACTIVE', 'SUSPENDED'),
}).min(1)

// Self-service profile edit (PATCH /staff/me) — deliberately a NARROWER
// surface than updateStaff above: no role, no status. Changing either of
// those is an authorization decision about someone else's account, not a
// profile edit, and stays exclusive to the ORG_ADMIN-only PATCH /staff/:id.
// newPassword requires currentPassword so a stolen/left-open session can't
// silently lock the real owner out of their own account.
const updateOwnStaff = Joi.object({
  name: Joi.string().trim().min(2).max(120),
  email: Joi.string().trim().lowercase().email().allow('', null),
  currentPassword: Joi.string().when('newPassword', { is: Joi.exist(), then: Joi.required() }),
  newPassword: Joi.string().min(6),
}).min(1)

// ── Device (§28, §N) ─────────────────────────────────────────────────────
const registerDevice = Joi.object({
  locationId: Joi.string().hex().length(24).allow(null),
  deviceUuid: Joi.string().trim().required(),
  platform: Joi.string().trim().default('ANDROID'),
  appVersion: Joi.string().trim().allow('', null),
  osVersion: Joi.string().trim().allow('', null),
})

const deactivateDevice = Joi.object({
  reason: Joi.string().trim().min(3).max(300).required(),
})

// ── Vehicle types (§10) ──────────────────────────────────────────────────
const createVehicleType = Joi.object({
  code: Joi.string().trim().uppercase().min(2).max(30).required(),
  name: Joi.string().trim().min(2).max(60).required(),
})

// ── Pricing (§10, §Q) ────────────────────────────────────────────────────
const locationCheckSchema = Joi.object({
  lat: Joi.number().min(-90).max(90).required(),
  lng: Joi.number().min(-180).max(180).required(),
  accuracyM: Joi.number().min(0),
  mockDetected: Joi.boolean().required(),
  playIntegrity: Joi.string().allow('', null),
})

const pricingConfigSchema = Joi.object({
  tierType: Joi.string().valid('SLAB', 'HOURLY'),
  slabs: Joi.array().items(Joi.object({ uptoMinutes: Joi.number().integer().min(1).allow(null), amountMinor: Joi.number().integer().min(0).required() })),
  firstHourMinor: Joi.number().integer().min(0),
  additionalHourMinor: Joi.number().integer().min(0),
  flatAmountMinor: Joi.number().integer().min(0),
  gracePeriodMinutes: Joi.number().integer().min(0),
  dailyMaxMinor: Joi.number().integer().min(0),
  weekendMultiplier: Joi.number().min(0),
  holidayMultiplier: Joi.number().min(0),
}).unknown(false)

const createPricingRule = Joi.object({
  locationId: Joi.string().hex().length(24).allow(null),
  vehicleTypeId: Joi.string().hex().length(24).required(),
  mode: Joi.string().valid('PAY_ON_EXIT', 'PAY_ON_ENTRY', 'FIXED_DURATION', 'HYBRID').required(),
  name: Joi.string().trim().min(2).max(120).required(),
  config: pricingConfigSchema.required(),
  effectiveFrom: Joi.date().iso(),
})

const createPricingRuleVersion = Joi.object({
  config: pricingConfigSchema.required(),
  effectiveFrom: Joi.date().iso(),
})

// ── Parking areas / slots (configurable slot-assignment feature) ────────
const createParkingArea = Joi.object({
  locationId: Joi.string().hex().length(24).required(),
  name: Joi.string().trim().min(1).max(80).required(),
  capacity: Joi.number().integer().min(1),
})

const createSlots = Joi.object({
  slotNumbers: Joi.array().items(Joi.string().trim().min(1).max(20)).min(1).max(500).required(),
  vehicleTypeId: Joi.string().hex().length(24).allow(null),
})

// ── Tokens (§6, §7) ──────────────────────────────────────────────────────
const provisionTokenBatch = Joi.object({
  locationId: Joi.string().hex().length(24).required(),
  batchSize: Joi.number().integer().min(1).max(5000).required(),
  notes: Joi.string().trim().allow('', null),
})

const reinstateToken = Joi.object({
  reason: Joi.string().trim().min(3).max(300).required(),
})

// §16/§34 — the forward direction of reinstate: AVAILABLE (or an in-use
// token found to be missing/broken) -> LOST/DAMAGED/BLOCKED. Only these
// three are ever a valid target here; RETURNED/ASSIGNED/ACTIVE/AVAILABLE are
// reached exclusively through the normal entry/exit/reinstate flows, not
// this manual override.
const markTokenStatus = Joi.object({
  status: Joi.string().valid('LOST', 'DAMAGED', 'BLOCKED').required(),
  reason: Joi.string().trim().min(3).max(300).required(),
})

// ── Shift (§14-19) ───────────────────────────────────────────────────────
const startShift = Joi.object({
  locationId: Joi.string().hex().length(24).required(),
  openingCashMinor: Joi.number().integer().min(0).default(0),
})

const closeShift = Joi.object({
  clientTransactionId: Joi.string().trim().allow('', null),
  actualCashMinor: Joi.number().integer().min(0).required(),
  notes: Joi.string().trim().max(500).allow('', null),
})

const forceCloseShift = Joi.object({
  reason: Joi.string().trim().min(3).max(300).required(),
})

const initiateHandover = Joi.object({
  toShiftInstanceId: Joi.string().hex().length(24).required(),
})

// ── Collection handover (staff cash deposit to Admin/Manager) ──────────
const initiateCollectionHandover = Joi.object({
  shiftInstanceId: Joi.string().hex().length(24).required(),
  amountMinor: Joi.number().integer().min(0).required(),
  notes: Joi.string().trim().max(500).allow('', null),
})

const confirmCollectionHandover = Joi.object({
  receivedAmountMinor: Joi.number().integer().min(0).required(),
  notes: Joi.string().trim().max(500).allow('', null),
})

const rejectCollectionHandover = Joi.object({
  reason: Joi.string().trim().min(3).max(300).required(),
})

// ── Parking sessions (§9, §12, §Q) ──────────────────────────────────────
const sessionEntry = Joi.object({
  clientTransactionId: Joi.string().trim().required(),
  locationId: Joi.string().hex().length(24).required(),
  parkingAreaId: Joi.string().hex().length(24).allow(null),
  slotId: Joi.string().hex().length(24).allow(null),
  vehicleNumber: Joi.string().trim().min(3).max(20).required(),
  vehicleTypeId: Joi.string().hex().length(24).required(),
  tokenCode: Joi.string().trim().required(),
  entryAt: Joi.date().iso(),
  locationCheck: locationCheckSchema.required(),
})

const sessionExitRequest = Joi.object({
  tokenCode: Joi.string().trim().required(),
  exitAt: Joi.date().iso(),
  locationCheck: locationCheckSchema.required(),
})

const sessionCancel = Joi.object({
  reason: Joi.string().trim().min(3).max(300).required(),
})

const sessionPayment = Joi.object({
  clientTransactionId: Joi.string().trim().required(),
  method: Joi.string().valid('CASH', 'UPI', 'CARD', 'OTHER').required(),
  // min 0, not 1: a fully-discounted (free) payment legitimately collects Rs0.
  amountMinor: Joi.number().integer().min(0).required(),
  discountMinor: Joi.number().integer().min(0),
  discountReason: Joi.string().trim().min(3).max(300)
    // .required() on the `is` schema matters: without it, Joi treats a
    // MISSING discountMinor as trivially satisfying `Joi.number().greater(0)`
    // (an optional schema accepts undefined), which would wrongly force
    // discountReason to be required on every plain payment with no discount.
    .when('discountMinor', { is: Joi.number().greater(0).required(), then: Joi.required() }),
})

// ── Sync (§23-§25, Phase 5) ──────────────────────────────────────────────
const syncPush = Joi.object({
  events: Joi.array().min(1).max(50).items(
    Joi.object({
      clientTransactionId: Joi.string().trim().required(),
      entityType: Joi.string().trim().required(),
      operation: Joi.string().valid('CREATE', 'UPDATE').required(),
      payload: Joi.object().unknown(true).required(),
    }),
  ).required(),
})

// ── Anomaly (§20) ────────────────────────────────────────────────────────
const reviewAnomaly = Joi.object({
  status: Joi.string().valid('REVIEWED', 'DISMISSED').required(),
})

module.exports = {
  reviewAnomaly,
  staffLogin,
  platformLogin,
  createOrganization,
  updateOrganizationStatus,
  createCountry,
  updateOrg,
  createLocation,
  updateLocation,
  createParkingArea,
  createSlots,
  createStaff,
  updateStaff,
  updateOwnStaff,
  registerDevice,
  deactivateDevice,
  createVehicleType,
  createPricingRule,
  createPricingRuleVersion,
  provisionTokenBatch,
  reinstateToken,
  markTokenStatus,
  startShift,
  closeShift,
  forceCloseShift,
  initiateHandover,
  initiateCollectionHandover,
  confirmCollectionHandover,
  rejectCollectionHandover,
  sessionEntry,
  sessionExitRequest,
  sessionPayment,
  sessionCancel,
  syncPush,
}
