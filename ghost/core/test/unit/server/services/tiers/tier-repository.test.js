const assert = require('node:assert/strict');
const sinon = require('sinon');
const ObjectID = require('bson-objectid').default; // fork(salvare)
const { Product: ProductModel } = require('../../../../../core/server/models/product');
const TierRepository = require('../../../../../core/server/services/tiers/tier-repository');
const Tier = require('../../../../../core/server/services/tiers/tier');

describe('TierRepository', function () {
  afterAll(function () {
    sinon.restore();
  });

  it('Can do basic functionality', async function () {
    const DomainEvents = {
      dispatch: sinon.stub(),
    };
    sinon.stub(ProductModel, 'findAll').resolves([]);
    sinon.stub(ProductModel, 'findOne').resolves([]);
    sinon.stub(ProductModel, 'edit').resolves();
    sinon.stub(ProductModel, 'add').resolves();

    const repository = new TierRepository({
      DomainEvents,
      ProductModel,
    });

    await repository.init();

    const tier = await Tier.create({
      name: 'Test',
      slug: 'test-tier',
      type: 'paid',
      status: 'active',
      currency: 'USD',
      monthlyPrice: 5,
      yearlyPrice: 50,
    });

    await repository.save(tier);

    sinon.assert.calledOnce(ProductModel.add);

    const result = await repository.getById(tier.id);

    sinon.assert.notCalled(ProductModel.findOne);

    assert(result);

    result.name = 'New Name';

    await repository.save(tier);

    sinon.assert.calledOnce(ProductModel.edit);
  });
});

// fork(salvare): one-time price
describe('TierRepository oneTimePrice', function () {
  afterEach(function () {
    sinon.restore();
  });

  function productModel(json) {
    return {
      toJSON() {
        return {
          name: 'Course',
          slug: 'course',
          active: true,
          welcome_page_url: null,
          visibility: 'none',
          trial_days: 0,
          description: null,
          type: 'paid',
          currency: 'usd',
          monthly_price: 500,
          yearly_price: 5000,
          created_at: new Date(),
          updated_at: null,
          benefits: [],
          ...json,
        };
      },
    };
  }

  it('Maps one_time_price when loading tiers', async function () {
    const withPrice = new ObjectID().toHexString();
    const withoutPrice = new ObjectID().toHexString();
    sinon
      .stub(ProductModel, 'findAll')
      .resolves([
        productModel({ id: withPrice, one_time_price: 9900 }),
        productModel({ id: withoutPrice, slug: 'other', one_time_price: null }),
      ]);

    const repository = new TierRepository({
      DomainEvents: { dispatch: sinon.stub() },
      ProductModel,
    });
    await repository.init();

    const priced = await repository.getById(ObjectID.createFromHexString(withPrice));
    const unpriced = await repository.getById(ObjectID.createFromHexString(withoutPrice));

    assert.equal(priced.oneTimePrice, 9900);
    assert.equal(unpriced.oneTimePrice, null);
  });

  it('Saves one_time_price on add and edit', async function () {
    sinon.stub(ProductModel, 'findAll').resolves([]);
    const add = sinon.stub(ProductModel, 'add').resolves();
    const edit = sinon.stub(ProductModel, 'edit').resolves();

    const repository = new TierRepository({
      DomainEvents: { dispatch: sinon.stub() },
      ProductModel,
    });
    await repository.init();

    const tier = await Tier.create({
      name: 'Course',
      slug: 'course',
      type: 'paid',
      currency: 'USD',
      oneTimePrice: 9900,
    });

    await repository.save(tier);
    assert.equal(add.firstCall.args[0].one_time_price, 9900);

    tier.oneTimePrice = null;
    await repository.save(tier);
    assert.equal(edit.firstCall.args[0].one_time_price, null);

    const stored = await repository.getById(tier.id);
    assert.equal(stored.oneTimePrice, null);
  });
});
