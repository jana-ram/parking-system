const { MODULE_KEYS, MODULE_LABELS } = require('../../config/modules')

/**
 * GET /platform/modules — the feature-module registry (§2), so owner-web can
 * render toggle checkboxes without hardcoding/duplicating the key list.
 */
const listModules = async (req, res, next) => {
  try {
    res.json({ success: true, message: 'ok', data: { keys: MODULE_KEYS, labels: MODULE_LABELS } })
  } catch (err) {
    next(err)
  }
}

module.exports = { listModules }
