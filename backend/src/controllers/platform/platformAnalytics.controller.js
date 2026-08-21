const Organization = require('../../models/Organization')
const Location = require('../../models/Location')
const Device = require('../../models/Device')
const ParkingSession = require('../../models/ParkingSession')

/**
 * GET /platform/analytics/overview — the §29/§T KPI tiles. "Vehicles today"
 * uses a UTC calendar day, not each org's own local midnight — the honest
 * simplification for a single platform-wide number spanning orgs in
 * different timezones (§10's location-local-midnight rule is about a single
 * org's billing, a genuinely different problem from one cross-org count).
 */
const getOverview = async (req, res, next) => {
  try {
    const startOfUtcDay = new Date()
    startOfUtcDay.setUTCHours(0, 0, 0, 0)

    const [organizations, locations, devices, vehiclesToday] = await Promise.all([
      Organization.countDocuments({}),
      Location.countDocuments({}).setOptions({ skipOrgScope: true }),
      Device.countDocuments({}).setOptions({ skipOrgScope: true }),
      ParkingSession.countDocuments({ entryAt: { $gte: startOfUtcDay } }).setOptions({ skipOrgScope: true }),
    ])

    res.json({ success: true, message: 'ok', data: { organizations, locations, devices, vehiclesToday } })
  } catch (err) {
    next(err)
  }
}

module.exports = { getOverview }
