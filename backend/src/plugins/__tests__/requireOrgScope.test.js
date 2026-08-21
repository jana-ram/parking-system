const mongoose = require('mongoose')
const { MongoMemoryReplSet } = require('mongodb-memory-server')
const requireOrgScope = require('../requireOrgScope')

// requireOrgScope is the belt-and-braces tenant-isolation guard described in
// docs/ARCHITECTURE.md §E/§X — this proves it actually blocks the exact bug
// it exists to catch (a query missing its organizationId filter), rather than
// just existing as documentation.

let replSet
let TestModel

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } })
  await mongoose.connect(replSet.getUri())

  const TestSchema = new mongoose.Schema({ organizationId: mongoose.Schema.Types.ObjectId, name: String })
  TestSchema.plugin(requireOrgScope)
  TestModel = mongoose.model('OrgScopeTestModel', TestSchema)
}, 60000)

afterAll(async () => {
  await mongoose.disconnect()
  await replSet.stop()
})

describe('requireOrgScope', () => {
  test('a find() without organizationId in the filter is blocked, not silently executed', async () => {
    await expect(TestModel.find({})).rejects.toThrow(/missing "organizationId"/i)
  })

  test('the blocked query surfaces a stable ORG_SCOPE_MISSING code', async () => {
    await expect(TestModel.find({})).rejects.toMatchObject({ code: 'ORG_SCOPE_MISSING' })
  })

  test('a find() WITH organizationId in the filter executes normally', async () => {
    const orgId = new mongoose.Types.ObjectId()
    await TestModel.create({ organizationId: orgId, name: 'alpha' })
    const docs = await TestModel.find({ organizationId: orgId })
    expect(docs).toHaveLength(1)
  })

  test('findOne/countDocuments/updateOne/deleteOne are all guarded, not just find()', async () => {
    await expect(TestModel.findOne({})).rejects.toMatchObject({ code: 'ORG_SCOPE_MISSING' })
    await expect(TestModel.countDocuments({})).rejects.toMatchObject({ code: 'ORG_SCOPE_MISSING' })
    await expect(TestModel.updateOne({}, { name: 'x' })).rejects.toMatchObject({ code: 'ORG_SCOPE_MISSING' })
    await expect(TestModel.deleteOne({})).rejects.toMatchObject({ code: 'ORG_SCOPE_MISSING' })
  })

  test('an explicit skipOrgScope:true bypass is honored (the only sanctioned escape hatch)', async () => {
    await expect(TestModel.find({}).setOptions({ skipOrgScope: true })).resolves.not.toThrow()
  })

  test('aggregateScoped() requires an organizationId argument', () => {
    expect(() => TestModel.aggregateScoped(null, [])).toThrow(/without an organizationId/i)
  })

  test('aggregateScoped() injects the $match stage so cross-tenant aggregation cannot happen by accident', async () => {
    const orgId = new mongoose.Types.ObjectId()
    await TestModel.create({ organizationId: orgId, name: 'beta' })
    const result = await TestModel.aggregateScoped(orgId, [{ $count: 'total' }])
    expect(result[0].total).toBeGreaterThanOrEqual(1)
  })
})
