/**
 * AES-256-GCM encrypt/decrypt for Device.deviceSecretEnc (§N). Deliberately
 * NOT bcrypt — HMAC verification in deviceCheck.middleware.js needs the
 * plaintext secret back, which a one-way hash can never give up. The key
 * (DEVICE_SECRET_ENC_KEY) is a 32-byte hex string from env, never derived
 * from anything request-specific.
 */
const crypto = require('crypto')

function getKey() {
  const hex = process.env.DEVICE_SECRET_ENC_KEY
  if (!hex || hex.length !== 64) {
    throw new Error('DEVICE_SECRET_ENC_KEY must be set to a 64-character hex string (32 random bytes) for AES-256-GCM')
  }
  return Buffer.from(hex, 'hex')
}

// The plaintext secret given to the client exactly once, at registration
// (§N) — the server never has it in plaintext again after this call.
function generateDeviceSecret() {
  return crypto.randomBytes(32).toString('hex')
}

function encryptDeviceSecret(plaintext) {
  const key = getKey()
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return Buffer.concat([iv, authTag, encrypted]).toString('base64')
}

function decryptDeviceSecret(encoded) {
  const key = getKey()
  const raw = Buffer.from(encoded, 'base64')
  const iv = raw.subarray(0, 12)
  const authTag = raw.subarray(12, 28)
  const encrypted = raw.subarray(28)
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(authTag)
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')
}

module.exports = { generateDeviceSecret, encryptDeviceSecret, decryptDeviceSecret }
