const { createError } = require('../utils/helpers')

/**
 * validate(schema, target?) — identical contract to
 * nammaraidu-web/backend/src/middleware/validate.middleware.js, reused as-is.
 *
 * Usage:
 *   router.post('/endpoint', validate(schema), handler)
 *   router.get('/endpoint',  validate(schema, 'query'), handler)
 */
const validate = (schema, target = 'body') => (req, res, next) => {
  const { error, value } = schema.validate(req[target], {
    abortEarly: false,
    allowUnknown: false,
    stripUnknown: true,
  })

  if (error) {
    const details = error.details.map(d => ({
      field: d.path.join('.'),
      message: d.message.replace(/['"]/g, ''),
    }))
    return next(createError(422, 'Validation failed', details, 'VALIDATION_ERROR'))
  }

  req[target] = value
  next()
}

module.exports = validate
