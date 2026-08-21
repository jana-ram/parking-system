const Incident = require('../models/Incident')

// Incident is deliberately NOT guarded by requireOrgScope (organizationId is
// nullable for platform-level incidents, see models/Incident.js) — this
// tenant-facing route always filters explicitly, itself, as the manual
// discipline that model's header comment calls for.
const listIncidents = async (req, res, next) => {
  try {
    const filter = { organizationId: req.staffUser.organizationId }
    if (req.query.status) filter.status = req.query.status
    if (req.query.severity) filter.severity = req.query.severity
    const incidents = await Incident.find(filter).sort({ createdAt: -1 }).limit(200)
    res.json({ success: true, message: 'ok', data: { incidents } })
  } catch (err) {
    next(err)
  }
}

module.exports = { listIncidents }
