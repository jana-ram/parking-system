const syncService = require('../services/sync.service')

const push = async (req, res, next) => {
  try {
    const results = await syncService.processPushBatch({
      organizationId: req.staffUser.organizationId,
      staffUser: req.staffUser,
      device: req.device,
      events: req.body.events,
    })
    req.device.lastSyncAt = new Date()
    await req.device.save()
    res.json({ success: true, message: 'Sync processed', data: { results } })
  } catch (err) {
    next(err)
  }
}

const pull = async (req, res, next) => {
  try {
    const data = await syncService.pull({
      organizationId: req.staffUser.organizationId,
      device: req.device,
      since: req.query.since,
    })
    res.json({ success: true, message: 'ok', data })
  } catch (err) {
    next(err)
  }
}

module.exports = { push, pull }
