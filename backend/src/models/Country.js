/**
 * Country — global reference data (ISO 3166 + default currency/timezone per
 * country). Not organization-scoped: shared platform-wide reference table,
 * managed only from the Product Owner dashboard.
 */
const mongoose = require('mongoose')

const CountrySchema = new mongoose.Schema({
  isoCode: { type: String, required: true, unique: true, uppercase: true, minlength: 2, maxlength: 2 },
  name: { type: String, required: true },
  defaultCurrency: { type: String, required: true, uppercase: true, minlength: 3, maxlength: 3 },
  defaultTimezone: { type: String, required: true },
}, { timestamps: true })

module.exports = mongoose.model('Country', CountrySchema)
