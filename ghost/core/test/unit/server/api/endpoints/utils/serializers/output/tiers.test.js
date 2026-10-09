const assert = require('node:assert/strict');
const ObjectID = require('bson-objectid').default;
const Tier = require('../../../../../../../../core/server/services/tiers/tier');
const tiersSerializer = require('../../../../../../../../core/server/api/endpoints/utils/serializers/output/tiers');

// fork(salvare): one-time price
describe('Tiers output serializer', function () {
  const paidTier = {
    id: new ObjectID(),
    name: 'Course',
    slug: 'course',
    type: 'paid',
    visibility: 'none',
    currency: 'usd',
  };

  function serializeRead(tier) {
    const frame = { options: {}, response: null };
    tiersSerializer.read(tier, { docName: 'tiers', method: 'read' }, frame);
    return frame.response.tiers[0];
  }

  it('includes one_time_price when it is set', async function () {
    const tier = await Tier.create({ ...paidTier, oneTimePrice: 9900 });

    const serialized = serializeRead(tier);

    assert.equal(serialized.one_time_price, 9900);
    assert.equal(serialized.monthly_price, 500);
    assert.equal(Reflect.has(serialized, 'oneTimePrice'), false);
  });

  it('omits one_time_price when it is null', async function () {
    const tier = await Tier.create(paidTier);

    const serialized = serializeRead(tier);

    assert.equal(Reflect.has(serialized, 'one_time_price'), false);
  });

  it('omits one_time_price for free tiers', async function () {
    const tier = await Tier.create({
      id: new ObjectID(),
      name: 'Free',
      slug: 'free',
      type: 'free',
      currency: null,
    });

    const serialized = serializeRead(tier);

    assert.equal(Reflect.has(serialized, 'one_time_price'), false);
    assert.equal(Reflect.has(serialized, 'monthly_price'), false);
  });

  it('includes one_time_price in browse responses', async function () {
    const priced = await Tier.create({ ...paidTier, oneTimePrice: 9900 });
    const unpriced = await Tier.create({ ...paidTier, id: new ObjectID(), slug: 'library' });
    const frame = { options: {}, response: null };

    tiersSerializer.browse(
      { data: [priced, unpriced], meta: { pagination: {} } },
      { docName: 'tiers', method: 'browse' },
      frame,
    );

    assert.equal(frame.response.tiers[0].one_time_price, 9900);
    assert.equal(Reflect.has(frame.response.tiers[1], 'one_time_price'), false);
  });
});
