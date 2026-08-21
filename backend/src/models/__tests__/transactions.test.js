const mongoose = require('mongoose')
const { MongoMemoryReplSet } = require('mongodb-memory-server')

// docs/ARCHITECTURE.md §E/§1.1: entry/exit each touch 3-5 collections
// (ParkingSession + QrToken + TokenMovement + ParkingSlot [+ Payment]) and
// must succeed or fail together. That requires session.withTransaction(),
// which in turn requires MongoDB to be a REPLICA SET — a plain standalone
// mongod throws on the first transactional write. This test is the Phase 1
// exit criterion from docs/ARCHITECTURE.md §Z: "a real multi-document
// transaction succeeds against the dev replica set."

let replSet
let Token
let Session

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } })
  await mongoose.connect(replSet.getUri())

  const TokenSchema = new mongoose.Schema({ status: String })
  const SessionSchema = new mongoose.Schema({ tokenId: mongoose.Schema.Types.ObjectId, status: String })
  Token = mongoose.model('TxnTestToken', TokenSchema)
  Session = mongoose.model('TxnTestSession', SessionSchema)
}, 60000)

afterAll(async () => {
  await mongoose.disconnect()
  await replSet.stop()
})

describe('multi-document transactions (the §1.1 infra prerequisite)', () => {
  test('a successful transaction commits writes across BOTH collections atomically', async () => {
    const token = await Token.create({ status: 'AVAILABLE' })

    const session = await mongoose.startSession()
    await session.withTransaction(async () => {
      await Token.updateOne({ _id: token._id }, { status: 'ASSIGNED' }, { session })
      await Session.create([{ tokenId: token._id, status: 'CREATED' }], { session })
    })
    await session.endSession()

    const updatedToken = await Token.findById(token._id)
    const createdSession = await Session.findOne({ tokenId: token._id })
    expect(updatedToken.status).toBe('ASSIGNED')
    expect(createdSession).not.toBeNull()
    expect(createdSession.status).toBe('CREATED')
  })

  test('a failed transaction rolls back BOTH writes — no half-applied entry ever exists', async () => {
    const token = await Token.create({ status: 'AVAILABLE' })

    const session = await mongoose.startSession()
    await expect(session.withTransaction(async () => {
      await Token.updateOne({ _id: token._id }, { status: 'ASSIGNED' }, { session })
      await Session.create([{ tokenId: token._id, status: 'CREATED' }], { session })
      throw new Error('simulated failure after both writes were staged')
    })).rejects.toThrow(/simulated failure/)
    await session.endSession()

    const untouchedToken = await Token.findById(token._id)
    const noSession = await Session.findOne({ tokenId: token._id })
    expect(untouchedToken.status).toBe('AVAILABLE') // rolled back, not left ASSIGNED
    expect(noSession).toBeNull() // rolled back, not left CREATED
  })
})
