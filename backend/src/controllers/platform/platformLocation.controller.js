const Location = require('../../models/Location')

// GET /platform/locations — cross-org, §T. Location IS guarded by
// requireOrgScope, so the cross-tenant read here is the one sanctioned
// skipOrgScope use (this router is the legitimate cross-tenant reader, §1.7).
// organizationId populate needs no match/skipOrgScope of its own —
// Organization.js carries no organizationId field, so the plugin was never
// applied to it (see platformOrg.controller.js's header comment).
const listLocations = async (req, res, next) => {
  try {
    const locations = await Location.find({})
      .setOptions({ skipOrgScope: true })
      .populate('organizationId', 'name code')
      .sort({ createdAt: -1 })
      .limit(500)
    res.json({ success: true, message: 'ok', data: { locations } })
  } catch (err) {
    next(err)
  }
}

module.exports = { listLocations }
