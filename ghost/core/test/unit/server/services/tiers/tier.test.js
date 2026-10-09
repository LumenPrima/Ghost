const assert = require('node:assert/strict');
const ObjectID = require('bson-objectid').default;
const Tier = require('../../../../../core/server/services/tiers/tier');
const TierActivatedEvent = require('../../../../../core/server/services/tiers/tier-activated-event');
const TierArchivedEvent = require('../../../../../core/server/services/tiers/tier-archived-event');
const TierNameChangeEvent = require('../../../../../core/server/services/tiers/tier-name-change-event');
const TierPriceChangeEvent = require('../../../../../core/server/services/tiers/tier-price-change-event');

async function assertError(fn, checkError) {
  let error;
  try {
    await fn();
    error = false;
  } catch (err) {
    error = err;
  } finally {
    assert(error);
    if (checkError) {
      checkError(error);
    }
  }
}
const validInput = {
  name: 'Tier Name',
  slug: 'tier-name',
  description: 'My First Tier',
  welcomePageURL: null,
  status: 'active',
  visibility: 'public',
  type: 'paid',
  trialDays: 10,
  currency: 'usd',
  monthlyPrice: 5000,
  yearlyPrice: 50000,
  benefits: [],
};

const invalidInputs = [
  { id: [100] },
  { name: 100 },
  { name: 'a'.repeat(200) },
  { slug: 'slug'.repeat(50) },
  { description: ['whatever?'] },
  { description: 'b'.repeat(200) },
  { welcomePageURL: { cool: 'beans' } },
  { status: 'something random' },
  { visibility: 'highly visible' },
  { type: 'comped' },
  { trialDays: -10 },
  { trialDays: 10, type: 'free', currency: null, monthlyPrice: null, yearlyPrice: null },
  { currency: 'dollar bills' },
  { currency: 25 },
  { currency: 'USD', type: 'free' },
  { monthlyPrice: 2000, type: 'free', trialDays: null, currency: null, yearlyPrice: null },
  { monthlyPrice: -20 },
  { monthlyPrice: 10000000000 },
  { yearlyPrice: 2000, type: 'free', trialDays: null, monthlyPrice: null, currency: null },
  { yearlyPrice: -20 },
  { yearlyPrice: 10000000000 },
  // fork(salvare): one-time price
  { oneTimePrice: 0 },
  { oneTimePrice: -100 },
  { oneTimePrice: 99.5 },
  { oneTimePrice: '9900' },
  { oneTimePrice: 4294967296 },
  {
    oneTimePrice: 9900,
    type: 'free',
    trialDays: null,
    currency: null,
    monthlyPrice: null,
    yearlyPrice: null,
  },
  { createdAt: 'Today' },
  { updatedAt: 'Tomorrow' },
];

const validInputs = [
  { welcomePageURL: 'https://google.com' },
  { id: new ObjectID().toHexString() },
  { id: new ObjectID() },
  { type: 'free', currency: null, monthlyPrice: null, yearlyPrice: null, trialDays: null },
  { createdAt: new Date() },
  { updatedAt: new Date() },
  { status: undefined },
  { type: undefined },
  { visibility: undefined },
  // fork(salvare): one-time price
  { oneTimePrice: 9900 },
  { oneTimePrice: null },
  { oneTimePrice: undefined },
  { oneTimePrice: 4294967295 },
  {
    oneTimePrice: null,
    type: 'free',
    currency: null,
    monthlyPrice: null,
    yearlyPrice: null,
    trialDays: null,
  },
];

describe('Tier', function () {
  describe('create', function () {
    it('Errors if passed an invalid input', async function () {
      for (const invalidInput of invalidInputs) {
        let input = {};
        Object.assign(input, validInput, invalidInput);
        await assertError(async function () {
          await Tier.create(input);
        });
      }
    });

    it('Uses default monthly and yearly price if they are set to 0', async function () {
      const tier = await Tier.create({
        ...validInput,
        monthlyPrice: 0,
        yearlyPrice: 0,
      });

      assert.equal(tier.getPrice('month'), 500);
      assert.equal(tier.getPrice('year'), 5000);
    });

    it('Does not error for valid inputs', async function () {
      for (const validInputItem of validInputs) {
        let input = {};
        Object.assign(input, validInput, validInputItem);
        await Tier.create(input);
      }
    });

    it('Can create a Tier with valid input', async function () {
      const tier = await Tier.create(validInput);

      const expectedProps = [
        'slug',
        'name',
        'description',
        'welcomePageURL',
        'status',
        'visibility',
        'type',
        'trialDays',
        'currency',
        'monthlyPrice',
        'yearlyPrice',
        'oneTimePrice', // fork(salvare)
        'createdAt',
        'updatedAt',
        'benefits',
      ];

      for (const prop of expectedProps) {
        assert(tier[prop] === tier.toJSON()[prop]);
      }
      assert(tier.id.toHexString() === tier.toJSON().id);
    });

    it('Errors when attempting to set invalid properties', async function () {
      const tier = await Tier.create(validInput);

      assertError(() => {
        tier.name = 20;
      });

      assertError(() => {
        tier.benefits = 20;
      });

      assertError(() => {
        tier.description = 20;
      });

      assertError(() => {
        tier.welcomePageURL = 20;
      });

      assertError(() => {
        tier.status = 20;
      });

      assertError(() => {
        tier.visibility = 20;
      });

      assertError(() => {
        tier.trialDays = 'one hundred';
      });

      assertError(() => {
        tier.currency = 'one hundred';
      });

      assertError(() => {
        tier.monthlyPrice = 'one hundred';
      });

      assertError(() => {
        tier.yearlyPrice = 'one hundred';
      });
    });

    it('Can change name and adds an event', async function () {
      const tier = await Tier.create(validInput);

      tier.name = 'New name';

      assert(
        tier.events.find((event) => {
          return event instanceof TierNameChangeEvent;
        }),
      );
    });

    it('Can update pricing information and adds an event', async function () {
      const tier = await Tier.create(validInput);

      tier.updatePricing({
        currency: 'eur',
        monthlyPrice: 1000,
        yearlyPrice: 6000,
      });

      assert(tier.currency === 'EUR');
      assert(tier.monthlyPrice === 1000);
      assert(tier.yearlyPrice === 6000);
      assert(
        tier.events.find((event) => {
          return event instanceof TierPriceChangeEvent;
        }),
      );
    });

    it('Can archive tier and adds an event', async function () {
      const tier = await Tier.create(validInput);

      tier.status = 'archived';
      assert(
        tier.events.find((event) => {
          return event instanceof TierArchivedEvent;
        }),
      );
    });

    it('Can activate tier and adds an event', async function () {
      const tier = await Tier.create({ ...validInput, status: 'archived' });

      tier.status = 'active';
      assert(
        tier.events.find((event) => {
          return event instanceof TierActivatedEvent;
        }),
      );
    });

    it('Does not add event if values not changed', async function () {
      const tier = await Tier.create(validInput);

      tier.status = 'active';
      assert(
        !tier.events.find((event) => {
          return event instanceof TierActivatedEvent;
        }),
      );

      tier.name = 'Tier Name';
      assert(
        !tier.events.find((event) => {
          return event instanceof TierNameChangeEvent;
        }),
      );

      tier.updatePricing({
        currency: tier.currency,
        monthlyPrice: tier.monthlyPrice,
        yearlyPrice: tier.yearlyPrice,
      });
      assert(
        !tier.events.find((event) => {
          return event instanceof TierPriceChangeEvent;
        }),
      );
    });

    it('Cannot set pricing data on a free tier', async function () {
      const tier = await Tier.create({
        ...validInput,
        type: 'free',
        currency: null,
        monthlyPrice: null,
        yearlyPrice: null,
        trialDays: null,
      });

      assertError(() => {
        tier.updatePricing({
          currency: 'usd',
          monthlyPrice: 1000,
          yearlyPrice: 10000,
        });
      });
    });

    // fork(salvare): one-time price
    describe('oneTimePrice', function () {
      it('Defaults to null', async function () {
        const tier = await Tier.create(validInput);

        assert.equal(tier.oneTimePrice, null);
        assert.equal(tier.toJSON().oneTimePrice, null);
      });

      it('Is set from create input and included in toJSON', async function () {
        const tier = await Tier.create({ ...validInput, oneTimePrice: 9900 });

        assert.equal(tier.oneTimePrice, 9900);
        assert.equal(tier.toJSON().oneTimePrice, 9900);
      });

      it('Survives a round trip through Tier.create with an existing Tier', async function () {
        const tier = await Tier.create({ ...validInput, oneTimePrice: 9900 });
        const copy = await Tier.create(tier);

        assert.equal(copy.oneTimePrice, 9900);
      });

      it('Can be set, changed and cleared without adding events', async function () {
        const tier = await Tier.create({ ...validInput, id: new ObjectID() });

        tier.oneTimePrice = 9900;
        assert.equal(tier.oneTimePrice, 9900);

        tier.oneTimePrice = 4294967295;
        assert.equal(tier.oneTimePrice, 4294967295);

        tier.oneTimePrice = null;
        assert.equal(tier.oneTimePrice, null);

        assert.equal(tier.events.length, 0);
      });

      it('Rejects invalid values in the setter', async function () {
        const tier = await Tier.create({ ...validInput, oneTimePrice: 9900 });

        for (const value of [0, -1, 1.5, '9900', 4294967296, Number.NaN]) {
          await assertError(
            () => {
              tier.oneTimePrice = value;
            },
            (err) => {
              assert.equal(err.errorType, 'ValidationError');
            },
          );
        }

        assert.equal(tier.oneTimePrice, 9900);
      });

      it('Cannot be set on a free tier', async function () {
        const tier = await Tier.create({
          ...validInput,
          type: 'free',
          currency: null,
          monthlyPrice: null,
          yearlyPrice: null,
          trialDays: null,
        });

        await assertError(
          () => {
            tier.oneTimePrice = 9900;
          },
          (err) => {
            assert.equal(err.message, 'Free Tiers cannot have a one-time price');
          },
        );

        tier.oneTimePrice = null;
        assert.equal(tier.oneTimePrice, null);
      });
    });

    it('Can set the description of a Tier', async function () {
      const tier = await Tier.create(validInput);

      tier.description = 'Updated description';

      assert.equal('Updated description', tier.description);
    });
  });
});
