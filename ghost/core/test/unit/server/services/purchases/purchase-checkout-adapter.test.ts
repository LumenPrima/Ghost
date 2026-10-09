import assert from 'node:assert/strict';
import sinon from 'sinon';
import {
  PurchaseCheckoutAdapter,
  type PurchaseCheckoutAdapterDeps,
} from '../../../../../core/server/services/purchases/purchase-checkout-adapter';
import { buildMember, buildTier } from './utils';

interface PriceRow {
  id: string;
  stripe_price_id: string;
  stripe_product_id: string;
  currency: string;
  amount: number;
  active: boolean;
  type: string;
}

interface StripePriceFixture {
  id: string;
  active: boolean;
  currency: string;
  unit_amount: number;
  nickname: string | null;
  recurring: unknown;
}

describe('PurchaseCheckoutAdapter', function () {
  let rows: PriceRow[];
  let stripePrices: Map<string, StripePriceFixture>;
  let StripePriceModel: {
    where: sinon.SinonStub;
    edit: sinon.SinonStub;
    add: sinon.SinonStub;
  };
  let stripeApi: {
    getPrice: sinon.SinonStub;
    createPrice: sinon.SinonStub;
    createPurchaseCheckoutSession: sinon.SinonStub;
  };
  let paymentsService: {
    getCustomerForMember: sinon.SinonStub;
    getProductForTier: sinon.SinonStub;
  };
  let adapter: PurchaseCheckoutAdapter;
  let createdCount: number;

  function addRow(row: Partial<PriceRow> & { stripe_price_id: string }) {
    rows.push({
      id: `row_${rows.length + 1}`,
      stripe_product_id: 'prod_1',
      currency: 'usd',
      amount: 9900,
      active: true,
      type: 'one_time',
      ...row,
    });
  }

  beforeEach(function () {
    rows = [];
    stripePrices = new Map();
    createdCount = 0;

    // A small stateful stand-in for the stripe_prices model, so that a price
    // created by one call is found by the next.
    StripePriceModel = {
      where: sinon.stub().callsFake((filter: Partial<PriceRow>) => ({
        query: () => ({
          select: async () =>
            rows
              .filter((row) =>
                Object.entries(filter).every(
                  ([key, value]) => row[key as keyof PriceRow] === value,
                ),
              )
              .map((row) => ({ id: row.id, stripe_price_id: row.stripe_price_id })),
        }),
      })),
      edit: sinon.stub().callsFake(async (data: { active: boolean }, { id }: { id: string }) => {
        const row = rows.find((candidate) => candidate.id === id);
        if (row) {
          row.active = data.active;
        }
      }),
      add: sinon.stub().callsFake(async (data: Omit<PriceRow, 'id'>) => {
        addRow(data);
      }),
    };
    stripeApi = {
      getPrice: sinon.stub().callsFake(async (id: string) => {
        const price = stripePrices.get(id);
        if (!price) {
          throw new Error(`No such price: ${id}`);
        }
        return price;
      }),
      createPrice: sinon.stub().callsFake(async (options: { currency: string; amount: number }) => {
        // Yield, so concurrent callers really interleave.
        await new Promise((resolve) => {
          setImmediate(resolve);
        });
        createdCount += 1;
        const price = {
          id: `price_created_${createdCount}`,
          active: true,
          currency: options.currency,
          unit_amount: options.amount,
          nickname: 'One-time',
          recurring: null,
        };
        stripePrices.set(price.id, price);
        return price;
      }),
      createPurchaseCheckoutSession: sinon
        .stub()
        .resolves({ id: 'cs_1', url: 'https://checkout.stripe.com/c/cs_1', mode: 'payment' }),
    };
    paymentsService = {
      getCustomerForMember: sinon.stub().resolves({ id: 'cus_1', email: 'member@example.com' }),
      getProductForTier: sinon.stub().resolves({ id: 'prod_1' }),
    };

    adapter = new PurchaseCheckoutAdapter({
      StripePriceModel,
      getStripeApi: () => stripeApi,
      getPaymentsService: () => paymentsService,
    } as unknown as PurchaseCheckoutAdapterDeps);
  });

  afterEach(function () {
    sinon.restore();
  });

  describe('getOneTimePriceId', function () {
    it('reuses a stored one_time price that Stripe confirms', async function () {
      addRow({ stripe_price_id: 'price_stored' });
      stripePrices.set('price_stored', {
        id: 'price_stored',
        active: true,
        currency: 'usd',
        unit_amount: 9900,
        nickname: 'One-time',
        recurring: null,
      });

      const priceId = await adapter.getOneTimePriceId(buildTier());

      assert.equal(priceId, 'price_stored');
      sinon.assert.calledOnceWithExactly(paymentsService.getProductForTier, sinon.match.object);
      sinon.assert.calledOnceWithExactly(StripePriceModel.where, {
        stripe_product_id: 'prod_1',
        currency: 'usd',
        amount: 9900,
        active: true,
        type: 'one_time',
      });
      sinon.assert.notCalled(stripeApi.createPrice);
      sinon.assert.notCalled(StripePriceModel.edit);
    });

    it('creates a one-time price when none is stored', async function () {
      const priceId = await adapter.getOneTimePriceId(buildTier());

      assert.equal(priceId, 'price_created_1');
      sinon.assert.calledOnceWithExactly(stripeApi.createPrice, {
        product: 'prod_1',
        currency: 'usd',
        amount: 9900,
        nickname: 'One-time',
        type: 'one-time',
        active: true,
      });
      sinon.assert.calledOnceWithExactly(StripePriceModel.add, {
        stripe_price_id: 'price_created_1',
        stripe_product_id: 'prod_1',
        active: true,
        nickname: 'One-time',
        currency: 'usd',
        amount: 9900,
        type: 'one_time',
        interval: null,
      });
    });

    const mismatches: Array<[string, Partial<StripePriceFixture>]> = [
      ['inactive', { active: false }],
      ['a different amount', { unit_amount: 5000 }],
      ['a different currency', { currency: 'eur' }],
      ['recurring', { recurring: { interval: 'month' } }],
    ];

    for (const [label, change] of mismatches) {
      it(`deactivates a stored price that Stripe reports as ${label} and creates a new one`, async function () {
        addRow({ stripe_price_id: 'price_stale' });
        stripePrices.set('price_stale', {
          id: 'price_stale',
          active: true,
          currency: 'usd',
          unit_amount: 9900,
          nickname: 'One-time',
          recurring: null,
          ...change,
        });

        const priceId = await adapter.getOneTimePriceId(buildTier());

        assert.equal(priceId, 'price_created_1');
        sinon.assert.calledOnceWithExactly(
          StripePriceModel.edit,
          { active: false },
          { id: 'row_1' },
        );
        sinon.assert.calledOnce(stripeApi.createPrice);
      });
    }

    it('rethrows a Stripe fetch error without deactivating the stored price', async function () {
      addRow({ stripe_price_id: 'price_unreachable' });
      stripeApi.getPrice.rejects(new Error('Stripe is down'));

      await assert.rejects(adapter.getOneTimePriceId(buildTier()), /Stripe is down/);
      sinon.assert.notCalled(StripePriceModel.edit);
      sinon.assert.notCalled(stripeApi.createPrice);
      assert.equal(rows[0].active, true);
    });

    it('serialises concurrent first checkouts so only one price is created', async function () {
      const tier = buildTier();

      const priceIds = await Promise.all([
        adapter.getOneTimePriceId(tier),
        adapter.getOneTimePriceId(tier),
        adapter.getOneTimePriceId(tier),
      ]);

      assert.deepEqual(priceIds, ['price_created_1', 'price_created_1', 'price_created_1']);
      sinon.assert.calledOnce(stripeApi.createPrice);
    });

    it('does not let a failed resolution block the next one', async function () {
      paymentsService.getProductForTier.onFirstCall().rejects(new Error('Stripe is down'));
      const tier = buildTier();

      const [first, second] = await Promise.allSettled([
        adapter.getOneTimePriceId(tier),
        adapter.getOneTimePriceId(tier),
      ]);

      assert.equal(first.status, 'rejected');
      assert.deepEqual(second, { status: 'fulfilled', value: 'price_created_1' });
    });

    it('refuses a tier without a one-time price', async function () {
      await assert.rejects(adapter.getOneTimePriceId(buildTier({ oneTimePrice: null })));
      sinon.assert.notCalled(paymentsService.getProductForTier);
    });
  });

  it('returns the Stripe customer for an authenticated member', async function () {
    const member = buildMember();

    const customer = await adapter.getCustomerForMember(member);

    assert.deepEqual(customer, { id: 'cus_1' });
    sinon.assert.calledOnceWithExactly(paymentsService.getCustomerForMember, member);
  });

  it('passes every session option through to Stripe', async function () {
    const input = {
      priceId: 'price_1',
      metadata: { ghost_purchase_tier_id: 'tier_1', attribution_id: 'post_1' },
      successUrl: 'https://example.com/start/?stripe=purchase-success',
      cancelUrl: 'https://example.com/',
      customer: { id: 'cus_1' },
      customerEmail: null,
    };

    const session = await adapter.createSession(input);

    assert.deepEqual(session, { id: 'cs_1', url: 'https://checkout.stripe.com/c/cs_1' });
    sinon.assert.calledOnceWithExactly(stripeApi.createPurchaseCheckoutSession, input);
  });

  it('fails when Stripe returns a session without a URL', async function () {
    stripeApi.createPurchaseCheckoutSession.resolves({ id: 'cs_1', url: null });

    await assert.rejects(
      adapter.createSession({
        priceId: 'price_1',
        metadata: {},
        successUrl: 'https://example.com/',
        cancelUrl: 'https://example.com/',
        customer: null,
        customerEmail: 'new@example.com',
      }),
    );
  });
});
