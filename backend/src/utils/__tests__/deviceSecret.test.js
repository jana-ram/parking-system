const crypto = require('crypto')

describe('deviceSecret (AES-256-GCM encrypt/decrypt for Device.deviceSecretEnc)', () => {
  const originalKey = process.env.DEVICE_SECRET_ENC_KEY

  beforeEach(() => {
    jest.resetModules()
    process.env.DEVICE_SECRET_ENC_KEY = crypto.randomBytes(32).toString('hex')
  })

  afterAll(() => {
    process.env.DEVICE_SECRET_ENC_KEY = originalKey
  })

  test('round-trips a generated secret', () => {
    const { generateDeviceSecret, encryptDeviceSecret, decryptDeviceSecret } = require('../deviceSecret')
    const secret = generateDeviceSecret()
    const enc = encryptDeviceSecret(secret)
    expect(enc).not.toBe(secret)
    expect(decryptDeviceSecret(enc)).toBe(secret)
  })

  test('generated secrets are 256-bit (64 hex chars) and unique per call', () => {
    const { generateDeviceSecret } = require('../deviceSecret')
    const a = generateDeviceSecret()
    const b = generateDeviceSecret()
    expect(a).toHaveLength(64)
    expect(a).not.toBe(b)
  })

  test('tampering with the ciphertext is detected (GCM auth tag), not silently decrypted wrong', () => {
    const { encryptDeviceSecret, decryptDeviceSecret } = require('../deviceSecret')
    const enc = encryptDeviceSecret('super-secret-value')
    const buf = Buffer.from(enc, 'base64')
    buf[buf.length - 1] ^= 0xff // flip a bit in the ciphertext tail
    const tampered = buf.toString('base64')
    expect(() => decryptDeviceSecret(tampered)).toThrow()
  })

  test('throws a clear error if DEVICE_SECRET_ENC_KEY is missing or the wrong length', () => {
    delete process.env.DEVICE_SECRET_ENC_KEY
    const { encryptDeviceSecret } = require('../deviceSecret')
    expect(() => encryptDeviceSecret('x')).toThrow(/64-character hex string/)
  })
})
