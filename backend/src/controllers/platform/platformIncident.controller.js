const Incident = require('../../models/Incident')

// GET /platform/incidents — sync incidents + system health visibility (§T,
// §27). Incident.js is deliberately NOT guarded by requireOrgScope
// (organizationId is nullable there), so this is a plain query, not a
// skipOrgScope case — see that model's own header comment.
const listIncidents = async (req, res, next) => {
  try {
    const filter = {}
    if (req.query.severity) filter.severity = req.query.severity
    if (req.query.status) filter.status = req.query.status
    if (req.query.type) filter.type = req.query.type
    const incidents = await Incident.find(filter)
      .populate('organizationId', 'name code')
      .sort({ createdAt: -1 })
      .limit(500)
    res.json({ success: true, message: 'ok', data: { incidents } })
  } catch (err) {
    next(err)
  }
}

module.exports = { listIncidents }
