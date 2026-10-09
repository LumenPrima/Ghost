const assert = require('node:assert/strict');

const TiersAPI = require('../../../../../core/server/services/tiers/tiers-api');
const InMemoryTierRepository = require('../../../../../core/server/services/tiers/in-memory-tier-repository');
const TierPriceChangeEvent = require('../../../../../core/server/services/tiers/tier-price-change-event'); // fork(salvare)

describe('TiersAPI', function () {
  /** @type {TiersAPI.ITierRepository} */
  let repository;

  /** @type {TiersAPI} */
  let api;

  beforeAll(function () {
    repository = new InMemoryTierRepository();
    api = new TiersAPI({
      repository,
      slugService: {
        async generate(input) {
          return input;
        },
      },
    });
  });

  it('Can not create new free Tiers', async function () {
    let error;
    try {
      await api.add({
        name: 'My testing Tier',
        type: 'free',
      });
      error = null;
    } catch (err) {
      error = err;
    } finally {
      assert(error, 'An error should have been thrown');
    }
  });

  it('Can create new paid Tiers and find them again', async function () {
    const tier = await api.add({
      name: 'My testing Tier',
      type: 'paid',
      monthlyPrice: 5000,
      yearlyPrice: 50000,
      currency: 'usd',
    });

    const found = await api.read(tier.id.toHexString());

    assert(found);
  });

  it('Can edit a tier', async function () {
    const tier = await api.add({
      name: 'My testing Tier',
      type: 'paid',
      monthlyPrice: 5000,
      yearlyPrice: 50000,
      currency: 'usd',
    });

    const updated = await api.edit(tier.id.toHexString(), {
      name: 'Updated',
    });

    assert(updated.name === 'Updated');
  });

  it('Can archive a tier', async function () {
    const tier = await api.add({
      name: 'My testing Tier',
      type: 'paid',
      monthlyPrice: 5000,
      yearlyPrice: 50000,
      currency: 'usd',
    });

    const updated = await api.edit(tier.id.toHexString(), {
      status: 'archived',
    });

    assert(updated.status === 'archived');
  });

  it('Can browse tiers', async function () {
    const page = await api.browse();

    assert(page.data.length === 3);
    assert(page.meta.pagination.total === 3);
  });

  it('Can read a default tier', async function () {
    const defaultTier = await api.readDefaultTier();

    assert.equal(defaultTier?.name, 'My testing Tier');
  });
});

// fork(salvare): one-time price
describe('TiersAPI oneTimePrice', function () {
  /** @type {TiersAPI} */
  let api;

  beforeEach(function () {
    api = new TiersAPI({
      repository: new InMemoryTierRepository(),
      slugService: {
        async generate(input) {
          return input;
        },
      },
    });
  });

  const paidTier = {
    name: 'Course',
    type: 'paid',
    currency: 'usd',
    visibility: 'none',
  };

  it('Creates a tier with a one-time price', async function () {
    const tier = await api.add({ ...paidTier, oneTimePrice: 9900 });

    assert.equal(tier.oneTimePrice, 9900);
    const found = await api.read(tier.id.toHexString());
    assert.equal(found.oneTimePrice, 9900);
  });

  it('Creates a tier without a one-time price', async function () {
    const tier = await api.add(paidTier);

    assert.equal(tier.oneTimePrice, null);
  });

  it('Rejects an invalid one-time price on create', async function () {
    await assert.rejects(() => api.add({ ...paidTier, oneTimePrice: -1 }), {
      errorType: 'ValidationError',
    });
  });

  it('Sets a one-time price on edit without a price change event', async function () {
    const tier = await api.add(paidTier);

    const updated = await api.edit(tier.id.toHexString(), { oneTimePrice: 4900 });

    assert.equal(updated.oneTimePrice, 4900);
    assert.equal(
      updated.events.some((event) => event instanceof TierPriceChangeEvent),
      false,
    );
  });

  it('Leaves the one-time price alone when the key is absent', async function () {
    const tier = await api.add({ ...paidTier, oneTimePrice: 9900 });

    const updated = await api.edit(tier.id.toHexString(), { name: 'Renamed' });

    assert.equal(updated.name, 'Renamed');
    assert.equal(updated.oneTimePrice, 9900);
  });

  it('Clears the one-time price when it is null', async function () {
    const tier = await api.add({ ...paidTier, oneTimePrice: 9900 });

    const updated = await api.edit(tier.id.toHexString(), { oneTimePrice: null });

    assert.equal(updated.oneTimePrice, null);
  });

  it('Rejects an invalid one-time price on edit', async function () {
    const tier = await api.add({ ...paidTier, oneTimePrice: 9900 });

    await assert.rejects(() => api.edit(tier.id.toHexString(), { oneTimePrice: 0 }), {
      errorType: 'ValidationError',
    });
  });
});
