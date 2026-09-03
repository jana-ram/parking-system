const Joi = require('joi')
const { RACK_ITEM_TYPES } = require('../config/rackItemTypes')

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

// §2 — Super Admin module toggles. Fixed-key (not a free-form object) so an
// unknown module name is rejected rather than silently stored; partial
// (`.min(1)`) since the controller merges only the keys sent, never
// replacing the whole modules object — see platformOrg.controller.js's
// updateOrganizationModules for why that merge semantics matters here.
const updateOrganizationModules = Joi.object({
  PARKING: Joi.boolean(),
  RACK: Joi.boolean(),
  LUGGAGE: Joi.boolean(),
  PARCEL: Joi.boolean(),
  BILLING: Joi.boolean(),
  REPORTS: Joi.boolean(),
  NOTIFICATIONS: Joi.boolean(),
  CUSTOMER_SELF_SERVICE: Joi.boolean(),
  AI_ASSISTANT: Joi.boolean(),
}).min(1).unknown(false)

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
  // §3/§O — named-permission exceptions on top of the base role (e.g. grant
  // 'pricing.edit' to a Manager without making them Org Admin). ORG_ADMIN-
  // only to set, same as every other field here.
  permissionOverrides: Joi.array().items(Joi.object({
    code: Joi.string().trim().min(1).max(60).required(),
    effect: Joi.string().valid('GRANT', 'DENY').required(),
  })).max(50),
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

// ── Rack management (§6/§7 of the platform brief) ───────────────────────
const createRack = Joi.object({
  locationId: Joi.string().hex().length(24).required(),
  code: Joi.string().trim().min(1).max(20).required(),
  name: Joi.string().trim().max(80).allow('', null),
  zone: Joi.string().trim().max(40).allow('', null),
  allowedItemTypes: Joi.array().items(Joi.string().valid(...RACK_ITEM_TYPES)).unique(),
})

const updateRack = Joi.object({
  name: Joi.string().trim().max(80).allow('', null),
  zone: Joi.string().trim().max(40).allow('', null),
  allowedItemTypes: Joi.array().items(Joi.string().valid(...RACK_ITEM_TYPES)).unique(),
  status: Joi.string().valid('ACTIVE', 'MAINTENANCE', 'BLOCKED'),
}).min(1)

const rackSlotDimensions = Joi.object({
  lengthCm: Joi.number().positive(),
  widthCm: Joi.number().positive(),
  heightCm: Joi.number().positive(),
})

const createRackSlots = Joi.object({
  slots: Joi.array().items(Joi.object({
    slotCode: Joi.string().trim().min(1).max(20).required(),
    allowedItemTypes: Joi.array().items(Joi.string().valid(...RACK_ITEM_TYPES)).unique(),
    maxWeightKg: Joi.number().positive(),
    dimensions: rackSlotDimensions,
    securityLevel: Joi.string().valid('STANDARD', 'HIGH'),
  })).min(1).max(500).required(),
})

const assignRackSlot = Joi.object({
  itemType: Joi.string().valid(...RACK_ITEM_TYPES).required(),
  itemRef: Joi.string().trim().min(1).max(120).required(),
  reason: Joi.string().trim().max(300).allow('', null),
})

const releaseRackSlot = Joi.object({
  reason: Joi.string().trim().max(300).allow('', null),
})

const updateRackSlotStatus = Joi.object({
  status: Joi.string().valid('AVAILABLE', 'RESERVED', 'BLOCKED', 'MAINTENANCE').required(),
  reason: Joi.string().trim().min(3).max(300).required(),
})

// ── Luggage management (§8 of the platform brief) ───────────────────────
const createLuggageOrder = Joi.object({
  locationId: Joi.string().hex().length(24).required(),
  customerName: Joi.string().trim().min(1).max(120).required(),
  customerPhone: Joi.string().trim().min(6).max(20).required(),
  ratePerDayMinor: Joi.number().integer().min(0).required(),
  expectedPickupAt: Joi.date().iso(),
  notes: Joi.string().trim().max(500).allow('', null),
})

const addLuggageItems = Joi.object({
  items: Joi.array().items(Joi.object({
    description: Joi.string().trim().min(1).max(200).required(),
    quantity: Joi.number().integer().min(1).max(100),
  })).min(1).max(100).required(),
})

const recordLuggagePayment = Joi.object({
  method: Joi.string().valid('CASH', 'UPI', 'CARD', 'OTHER').required(),
  amountMinor: Joi.number().integer().min(1).required(),
  clientTransactionId: Joi.string().trim().required(),
})

const cancelLuggageOrder = Joi.object({
  reason: Joi.string().trim().min(3).max(300).required(),
})

const luggageOverrideAmount = Joi.object({
  manualAmountMinor: Joi.number().integer().min(0).required(),
  reason: Joi.string().trim().min(3).max(300).required(),
})

const assignLuggageItemRack = Joi.object({
  rackSlotId: Joi.string().hex().length(24).required(),
  reason: Joi.string().trim().max(300).allow('', null),
})

const releaseLuggageItemRack = Joi.object({
  reason: Joi.string().trim().max(300).allow('', null),
})

// ── Parcel management (§9 of the platform brief) ────────────────────────
const createParcelOrder = Joi.object({
  locationId: Joi.string().hex().length(24).required(),
  senderName: Joi.string().trim().min(1).max(120).required(),
  senderPhone: Joi.string().trim().max(20).allow('', null),
  receiverName: Joi.string().trim().min(1).max(120).required(),
  receiverPhone: Joi.string().trim().min(6).max(20).required(),
  ratePerDayMinor: Joi.number().integer().min(0).required(),
  expectedPickupAt: Joi.date().iso(),
  notes: Joi.string().trim().max(500).allow('', null),
})

const addParcelItems = Joi.object({
  items: Joi.array().items(Joi.object({
    parcelType: Joi.string().trim().max(60).allow('', null),
    description: Joi.string().trim().max(200).allow('', null),
    quantity: Joi.number().integer().min(1).max(100),
  })).min(1).max(100).required(),
})

const recordParcelPayment = Joi.object({
  method: Joi.string().valid('CASH', 'UPI', 'CARD', 'OTHER').required(),
  amountMinor: Joi.number().integer().min(1).required(),
  clientTransactionId: Joi.string().trim().required(),
})

const cancelParcelOrder = Joi.object({
  reason: Joi.string().trim().min(3).max(300).required(),
})

const parcelOverrideAmount = Joi.object({
  manualAmountMinor: Joi.number().integer().min(0).required(),
  reason: Joi.string().trim().min(3).max(300).required(),
})

const assignParcelItemRack = Joi.object({
  rackSlotId: Joi.string().hex().length(24).required(),
  reason: Joi.string().trim().max(300).allow('', null),
})

const releaseParcelItemRack = Joi.object({
  reason: Joi.string().trim().max(300).allow('', null),
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

// §12 — manual amount override, generic across ParkingSession/LuggageOrder/
// ParcelOrder (see the *OverrideAmount siblings further down).
const sessionOverrideAmount = Joi.object({
  manualAmountMinor: Joi.number().integer().min(0).required(),
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
  updateOrganizationModules,
  createCountry,
  updateOrg,
  createLocation,
  updateLocation,
  createParkingArea,
  createSlots,
  createRack,
  updateRack,
  createRackSlots,
  assignRackSlot,
  releaseRackSlot,
  updateRackSlotStatus,
  createLuggageOrder,
  addLuggageItems,
  recordLuggagePayment,
  cancelLuggageOrder,
  luggageOverrideAmount,
  assignLuggageItemRack,
  releaseLuggageItemRack,
  createParcelOrder,
  addParcelItems,
  recordParcelPayment,
  cancelParcelOrder,
  parcelOverrideAmount,
  assignParcelItemRack,
  releaseParcelItemRack,
  sessionOverrideAmount,
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
