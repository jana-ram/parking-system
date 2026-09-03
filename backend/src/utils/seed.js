require('dotenv').config()
const { connectDb } = require('../config/db')
const Country = require('../models/Country')
const Organization = require('../models/Organization')
const { DEFAULT_MODULES } = require('../config/modules')
const logger = require('./logger')

/**
 * Reference-data seed — idempotent, safe to run on every boot or by hand
 * (`npm run seed`). Only platform reference data (§31) belongs here;
 * per-organization data (StaffUser, Location, ...) is created through the
 * API by a Platform Admin / Org Admin, not seeded, since it's real tenant
 * data in any environment past local dev.
 */
const COUNTRIES = [
  { isoCode: 'IN', name: 'India', defaultCurrency: 'INR', defaultTimezone: 'Asia/Kolkata' },
  { isoCode: 'US', name: 'United States', defaultCurrency: 'USD', defaultTimezone: 'America/New_York' },
  { isoCode: 'AE', name: 'United Arab Emirates', defaultCurrency: 'AED', defaultTimezone: 'Asia/Dubai' },
]

async function seedCountries() {
  for (const c of COUNTRIES) {
    await Country.updateOne({ isoCode: c.isoCode }, { $setOnInsert: c }, { upsert: true })
  }
  logger.info(`Seeded ${COUNTRIES.length} countries`)
}

/**
 * Backfills `modules` onto any Organization written before the feature-module
 * system existed. Idempotent — only touches docs missing the field.
 * Organization.create() already gets DEFAULT-equivalent values from the
 * schema's own per-key defaults (Organization.js), so this only matters for
 * docs already in the database when this migration first runs.
 */
async function backfillOrgModuleDefaults() {
  const result = await Organization.updateMany(
    { modules: { $exists: false } },
    { $set: { modules: DEFAULT_MODULES } },
  )
  if (result.modifiedCount) logger.info(`Backfilled modules on ${result.modifiedCount} organization(s)`)
}

if (require.main === module) {
  connectDb()
    .then(seedCountries)
    .then(() => process.exit(0))
    .catch((err) => { logger.error('Seed failed:', err.message); process.exit(1) })
}

module.exports = { seedCountries, COUNTRIES, backfillOrgModuleDefaults }
