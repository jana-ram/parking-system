const Anomaly = require('../../models/Anomaly')

// GET /platform/anomalies — cross-org anomaly monitoring (§T, §20).
const listAnomalies = async (req, res, next) => {
  try {
    const filter = {}
    if (req.query.riskLevel) filter.riskLevel = req.query.riskLevel
    const anomalies = await Anomaly.find(filter)
      .setOptions({ skipOrgScope: true })
      .populate('organizationId', 'name code')
      .sort({ createdAt: -1 })
      .limit(500)
    res.json({ success: true, message: 'ok', data: { anomalies } })
  } catch (err) {
    next(err)
  }
}

module.exports = { listAnomalies }
