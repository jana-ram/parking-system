const winston = require('winston')
const path = require('path')

// Same shape as nammaraidu-web/backend/src/utils/logger.js — the splat-args fix
// (logger.error('label:', err) style calls losing their second argument) applies
// here too since we're using the same winston call patterns.
const SPLAT = Symbol.for('splat')
const appendSplatArgs = winston.format((info) => {
  const args = info[SPLAT]
  if (args && args.length) {
    const extra = args
      .map(arg => (arg instanceof Error ? (arg.stack || arg.message) : typeof arg === 'object' ? JSON.stringify(arg) : String(arg)))
      .join(' ')
    info.message = `${info.message} ${extra}`
  }
  return info
})

const logger = winston.createLogger({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  format: winston.format.combine(
    winston.format.errors({ stack: true }),
    appendSplatArgs(),
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ level, message, timestamp, stack }) =>
      `${timestamp} [${level.toUpperCase()}]: ${stack || message}`
    )
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    }),
    new winston.transports.File({
      filename: path.join('logs', 'error.log'),
      level: 'error',
      maxsize: 5242880,
      maxFiles: 5
    }),
    new winston.transports.File({
      filename: path.join('logs', 'combined.log'),
      maxsize: 5242880,
      maxFiles: 5
    })
  ]
})

module.exports = logger
