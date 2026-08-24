require('dotenv').config()
const express = require('express')
const http = require('http')
const cors = require('cors')
const helmet = require('helmet')
const morgan = require('morgan')
const compression = require('compression')
const mongoSanitize = require('express-mongo-sanitize')
const rateLimit = require('express-rate-limit')

const { connectDb } = require('./config/db')
const logger = require('./utils/logger')

const app = express()
const server = http.createServer(app)
app.set('trust proxy', 1)

app.use(helmet())
app.use(mongoSanitize())
app.use(compression())

const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 2000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests' },
})
app.use(generalLimiter)

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many login attempts, please try again later' },
})

const allowedOrigins = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : ['http://localhost:7000']
app.use(cors({
  origin: (origin, cb) => (!origin || allowedOrigins.includes(origin) ? cb(null, true) : cb(new Error('Not allowed by CORS'))),
  credentials: true,
}))

app.use(express.json({ limit: '5mb' }))
app.use(express.urlencoded({ extended: true, limit: '5mb' }))
if (process.env.NODE_ENV === 'development') app.use(morgan('dev'))

app.get('/health', (req, res) => res.json({ success: true, message: 'Smart Parking OS API is running', timestamp: new Date().toISOString() }))

app.use('/auth', loginLimiter, require('./routes/auth.routes'))
app.use('/orgs', require('./routes/org.routes'))
app.use('/locations', require('./routes/location.routes'))
app.use('/parking-areas', require('./routes/parkingArea.routes'))
app.use('/staff', require('./routes/staff.routes'))
app.use('/devices', require('./routes/device.routes'))
app.use('/vehicle-types', require('./routes/vehicleType.routes'))
app.use('/pricing-rules', require('./routes/pricingRule.routes'))
app.use('/tokens', require('./routes/token.routes'))
app.use('/shifts', require('./routes/shift.routes'))
app.use('/sessions', require('./routes/session.routes'))
app.use('/handovers', require('./routes/handover.routes'))
app.use('/sync', require('./routes/sync.routes'))
app.use('/audit-logs', require('./routes/audit.routes'))
app.use('/anomalies', require('./routes/anomaly.routes'))
app.use('/incidents', require('./routes/incident.routes'))
app.use('/reports', require('./routes/report.routes'))

app.use('/platform/auth', loginLimiter, require('./routes/platform/platformAuth.routes'))
app.use('/platform/organizations', require('./routes/platform/platformOrg.routes'))
app.use('/platform/countries', require('./routes/platform/platformCountry.routes'))
app.use('/platform/locations', require('./routes/platform/platformLocation.routes'))
app.use('/platform/devices', require('./routes/platform/platformDevice.routes'))
app.use('/platform/anomalies', require('./routes/platform/platformAnomaly.routes'))
app.use('/platform/incidents', require('./routes/platform/platformIncident.routes'))
app.use('/platform/audit', require('./routes/platform/platformAudit.routes'))
app.use('/platform/analytics', require('./routes/platform/platformAnalytics.routes'))

// ── Phase 8 status ────────────────────────────────────────────────────────
// Everything through Phase 6 (vehicle/token/session/pricing/payment,
// entry/exit, shift/tally/handover, sync, security hardening, audit,
// anomaly engine) plus this phase's additions: cross-org platform reads for
// the Product Owner dashboard — countries (list+create), locations, devices
// (+ platform-level deactivate), anomalies, incidents, audit (drill-in), and
// the overview KPI aggregate. Every one of these deliberately uses
// `.setOptions({skipOrgScope: true})` where the target model is
// requireOrgScope-guarded — this router is the one sanctioned cross-tenant
// reader (§1.7). Platform reads are NOT yet self-audited (see
// platformAudit.controller.js's header for why: AuditLog.organizationId is
// required, and a platform-only audit trail needs either a schema change or
// a separate collection, neither done here). Corrections/refunds, reports,
// subscriptions/billing, and full platform analytics beyond the overview
// tiles are Phase 9+ work — deliberately not stubbed out here with empty
// handlers, since an unimplemented route that returns 200 is worse than one
// that 404s.

app.use('*', (req, res) => res.status(404).json({ success: false, message: `Route ${req.originalUrl} not found` }))

app.use((err, req, res, next) => {
  logger.error(`${err.message} - ${req.originalUrl} - ${req.method}`)
  res.status(err.statusCode || 500).json({
    success: false,
    message: err.message || 'Internal Server Error',
    ...(err.code && { code: err.code }),
    ...(err.details && { errors: err.details }),
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  })
})

async function seedPlatformAdmin() {
  const PlatformAdmin = require('./models/PlatformAdmin')
  const count = await PlatformAdmin.countDocuments()
  if (count === 0) {
    // Production must supply real credentials explicitly — refusing to seed
    // with a guessable default closes the classic "day-one admin account
    // with a published password" hole. Dev/test keep the convenience default
    // so a fresh local checkout still boots without extra setup.
    if (process.env.NODE_ENV === 'production' && (!process.env.PLATFORM_ADMIN_EMAIL || !process.env.PLATFORM_ADMIN_PASSWORD)) {
      throw new Error('PLATFORM_ADMIN_EMAIL and PLATFORM_ADMIN_PASSWORD must be set in production to seed the initial platform admin')
    }
    await PlatformAdmin.create({
      name: 'Platform Owner',
      email: process.env.PLATFORM_ADMIN_EMAIL || 'owner@smartparkingos.com',
      password: process.env.PLATFORM_ADMIN_PASSWORD || 'ChangeMe@123',
    })
    logger.info('Default platform admin created')
  }
}

if (require.main === module) {
  connectDb()
    .then(async () => {
      await seedPlatformAdmin().catch(e => logger.warn('seedPlatformAdmin:', e.message))
      await require('./utils/seed').seedCountries().catch(e => logger.warn('seedCountries:', e.message))
      const PORT = process.env.PORT || 5100
      server.listen(PORT, () => logger.info(`Smart Parking OS API running on http://localhost:${PORT}`))
    })
    .catch(err => { logger.error('MongoDB connection failed:', err.message); process.exit(1) })
}

module.exports = { app, server }
