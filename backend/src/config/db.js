const mongoose = require('mongoose')
const logger = require('../utils/logger')

async function connectDb() {
  await mongoose.connect(process.env.MONGO_URI)
  logger.info('MongoDB connected')

  // Fail fast and loud in production if we somehow connected to a standalone
  // instance rather than a replica set — every session/token/slot/payment
  // write below relies on multi-document transactions (§E), and a standalone
  // mongod only fails that at the *first write*, deep inside a request, which
  // is a much worse place to discover it than at boot.
  const hello = await mongoose.connection.db.admin().command({ hello: 1 }).catch(() => null)
  const isReplicaSet = !!(hello && (hello.setName || hello.msg === 'isdbgrid'))
  if (!isReplicaSet) {
    const msg = 'MongoDB is not running as a replica set (or mongos) — multi-document ' +
      'transactions will fail on the first session entry/exit write. See .env.example ' +
      'for local replica-set setup, or docs/ARCHITECTURE.md §1.1/§W.'
    if (process.env.NODE_ENV === 'production') throw new Error(msg)
    logger.warn(msg)
  }

  // Mongoose's default autoIndex builds indexes in the BACKGROUND, unawaited
  // — the app would otherwise start accepting traffic before the partial
  // unique indexes that guarantee §1 items 13-14 (no double-active-session,
  // no double-active-token) actually exist. A request landing in that window
  // could create a duplicate the index would normally have rejected. All
  // route files are already required by this point (server.js requires them
  // at module-load time, before calling connectDb), so every model that
  // matters is registered — this blocks server startup until every one of
  // them confirms its indexes are built.
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()))
  logger.info(`Indexes verified for ${Object.keys(mongoose.models).length} models`)

  return mongoose.connection
}

module.exports = { connectDb }
