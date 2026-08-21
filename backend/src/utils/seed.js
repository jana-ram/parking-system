require('dotenv').config()
const { connectDb } = require('../config/db')
const Country = require('../models/Country')
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

if (require.main === module) {
  connectDb()
    .then(seedCountries)
    .then(() => process.exit(0))
    .catch((err) => { logger.error('Seed failed:', err.message); process.exit(1) })
}

module.exports = { seedCountries, COUNTRIES }
