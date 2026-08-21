/**
 * Organization — a tenant (a parking operator, from a single-lot business up to
 * an enterprise multi-location company). This is the root of every organizationId
 * scope used throughout the rest of the schema (§30) — it is not itself scoped
 * by requireOrgScope, since it IS the scope.
 */
const mongoose = require('mongoose')

const ORG_STATUSES = ['ACTIVE', 'SUSPENDED', 'CANCELLED']

const OrganizationSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  // Short unique slug (e.g. "acme-parking"), required because StaffUser.phone
  // is only unique WITHIN an organization (§E) — a staff login form needs some
  // way to disambiguate which org a phone number belongs to before checking
  // the password. Not specified explicitly in docs/ARCHITECTURE.md §Q; added
  // here as the smallest concrete resolution rather than leaving login
  // ambiguous across tenants.
  code: { type: String, required: true, unique: true, lowercase: true, trim: true, match: /^[a-z0-9-]+$/ },
  countryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Country', required: true },
  defaultCurrency: { type: String, required: true, uppercase: true },
  defaultTimezone: { type: String, required: true },
  status: { type: String, enum: ORG_STATUSES, default: 'ACTIVE' },
}, { timestamps: true })

OrganizationSchema.statics.STATUSES = ORG_STATUSES

module.exports = mongoose.model('Organization', OrganizationSchema)
