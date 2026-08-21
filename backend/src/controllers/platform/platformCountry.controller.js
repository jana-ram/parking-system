const Country = require('../../models/Country')
const { createError } = require('../../utils/helpers')

// Country carries no organizationId (it's global platform reference data,
// §31) — not guarded by requireOrgScope, same reasoning as Organization.js.
const listCountries = async (req, res, next) => {
  try {
    const countries = await Country.find({}).sort({ name: 1 })
    res.json({ success: true, message: 'ok', data: { countries } })
  } catch (err) {
    next(err)
  }
}

const createCountry = async (req, res, next) => {
  try {
    const country = await Country.create(req.body)
    res.status(201).json({ success: true, message: 'Country added', data: { country } })
  } catch (err) {
    if (err.code === 11000) return next(createError(409, 'This country already exists', null, 'VALIDATION_ERROR'))
    next(err)
  }
}

module.exports = { listCountries, createCountry }
