import assert from 'node:assert/strict';
import type { Knex } from 'knex';
import {
  DuplicatePurchaseError,
  PurchaseKnexRepository,
  isUniqueViolation,
} from '../../../../../core/server/services/purchases/purchase-knex-repository';
import type { NewPurchaseData } from '../../../../../core/server/services/purchases/purchase-schema';
import { createPurchaseTables, createSqliteKnex } from './db';
import { TIER_ID } from './utils';

function newPurchase(overrides: Partial<NewPurchaseData> = {}): NewPurchaseData {
  return {
    memberId: 'member_1',
    productId: TIER_ID,
    stripeCheckoutSessionId: 'cs_1',
    stripePaymentIntentId: 'pi_1',
    stripeCustomerId: 'cus_1',
    amount: 9900,
    currency: 'usd',
    ...overrides,
  };
}

describe('PurchaseKnexRepository', function () {
  let knex: Knex;
  let repository: PurchaseKnexRepository;

  beforeEach(async function () {
    knex = createSqliteKnex();
    await createPurchaseTables(knex);
    await knex('members').insert([{ id: 'member_1' }, { id: 'member_2' }]);
    await knex('products').insert([{ id: TIER_ID }, { id: 'other_tier_000000000000' }]);
    repository = new PurchaseKnexRepository({ knex });
  });

  afterEach(async function () {
    await knex.destroy();
  });

  it('creates a purchase and reads it back through the codec', async function () {
    const before = Date.now();
    const created = await repository.create(
      newPurchase({
        attributionId: 'post_1',
        attributionType: 'post',
        attributionUrl: '/course-intro/',
        utmCampaign: 'launch',
      }),
    );

    assert.match(created.id, /^[0-9a-f]{24}$/);
    assert.equal(created.memberId, 'member_1');
    assert.equal(created.productId, TIER_ID);
    assert.equal(created.stripeCheckoutSessionId, 'cs_1');
    assert.equal(created.stripePaymentIntentId, 'pi_1');
    assert.equal(created.stripeCustomerId, 'cus_1');
    assert.equal(created.amount, 9900);
    assert.equal(created.currency, 'usd');
    assert.equal(created.status, 'paid');
    assert.equal(created.expiresAt, null);
    assert.equal(created.refundedAt, null);
    assert.equal(created.attributionId, 'post_1');
    assert.equal(created.attributionType, 'post');
    assert.equal(created.attributionUrl, '/course-intro/');
    assert.equal(created.utmCampaign, 'launch');
    assert.equal(created.referrerSource, null);
    assert.ok(created.createdAt instanceof Date);
    // The database keeps second precision.
    assert.ok(created.createdAt.getTime() >= Math.floor(before / 1000) * 1000);

    assert.deepEqual(await repository.getByCheckoutSessionId('cs_1'), created);
    assert.deepEqual(await repository.getByPaymentIntentId('pi_1'), created);
  });

  it('writes dates in the database text format', async function () {
    const refundedAt = new Date('2026-10-02T03:04:05.000Z');
    await repository.create(newPurchase({ status: 'refunded', refundedAt }));

    const row = await knex('members_purchases').first();
    assert.equal(row.refunded_at, '2026-10-02 03:04:05');
    assert.match(row.created_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

    const purchase = await repository.getByCheckoutSessionId('cs_1');
    assert.equal(purchase?.status, 'refunded');
    assert.deepEqual(purchase?.refundedAt, refundedAt);
  });

  it('returns null when nothing matches', async function () {
    assert.equal(await repository.getByCheckoutSessionId('cs_missing'), null);
    assert.equal(await repository.getByPaymentIntentId('pi_missing'), null);
  });

  it('rejects a second purchase for the same checkout session', async function () {
    await repository.create(newPurchase());

    await assert.rejects(
      repository.create(newPurchase({ stripePaymentIntentId: 'pi_2' })),
      DuplicatePurchaseError,
    );
  });

  it('rejects a second purchase for the same payment intent', async function () {
    await repository.create(newPurchase());

    await assert.rejects(
      repository.create(newPurchase({ stripeCheckoutSessionId: 'cs_2' })),
      DuplicatePurchaseError,
    );
  });

  it('allows several purchases without Stripe ids', async function () {
    await repository.create(
      newPurchase({ stripeCheckoutSessionId: null, stripePaymentIntentId: null }),
    );
    await repository.create(
      newPurchase({ stripeCheckoutSessionId: null, stripePaymentIntentId: null }),
    );

    assert.equal((await knex('members_purchases').count({ count: '*' }))[0].count, 2);
  });

  it('does not report a foreign key failure as a duplicate', async function () {
    await assert.rejects(repository.create(newPurchase({ memberId: 'missing_member' })), (err) => {
      assert.equal(err instanceof DuplicatePurchaseError, false);
      return true;
    });
  });

  describe('hasActivePurchase', function () {
    it('is true for a paid lifetime purchase', async function () {
      await repository.create(newPurchase());

      assert.equal(await repository.hasActivePurchase('member_1', TIER_ID), true);
      assert.equal(await repository.hasActivePurchase('member_2', TIER_ID), false);
      assert.equal(
        await repository.hasActivePurchase('member_1', 'other_tier_000000000000'),
        false,
      );
    });

    it('is false for a refunded purchase', async function () {
      await repository.create(newPurchase({ status: 'refunded', refundedAt: new Date() }));

      assert.equal(await repository.hasActivePurchase('member_1', TIER_ID), false);
    });

    it('respects expires_at', async function () {
      await repository.create(newPurchase({ expiresAt: new Date(Date.now() - 60 * 60 * 1000) }));
      assert.equal(await repository.hasActivePurchase('member_1', TIER_ID), false);

      await repository.create(
        newPurchase({
          stripeCheckoutSessionId: 'cs_2',
          stripePaymentIntentId: 'pi_2',
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        }),
      );
      assert.equal(await repository.hasActivePurchase('member_1', TIER_ID), true);
    });
  });

  it('marks a purchase refunded', async function () {
    const created = await repository.create(newPurchase());
    const refundedAt = new Date('2026-10-03T10:00:00.000Z');

    await repository.transaction(async (transacting) => {
      await repository.markRefunded(created.id, refundedAt, { transacting });
    });

    const purchase = await repository.getByPaymentIntentId('pi_1');
    assert.equal(purchase?.status, 'refunded');
    assert.deepEqual(purchase?.refundedAt, refundedAt);
    assert.equal(await repository.hasActivePurchase('member_1', TIER_ID), false);
  });

  it('rolls back writes when the transaction fails', async function () {
    await assert.rejects(
      repository.transaction(async (transacting) => {
        await repository.create(newPurchase(), { transacting });
        assert.ok(await repository.getByCheckoutSessionId('cs_1', { transacting }));
        throw new Error('grant failed');
      }),
      /grant failed/,
    );

    assert.equal(await repository.getByCheckoutSessionId('cs_1'), null);
  });

  it('reads inside a transaction with forUpdate', async function () {
    await repository.create(newPurchase());

    const purchase = await repository.transaction((transacting) =>
      repository.getByPaymentIntentId('pi_1', { transacting, forUpdate: true }),
    );

    assert.equal(purchase?.stripePaymentIntentId, 'pi_1');
  });
});

describe('isUniqueViolation', function () {
  it('recognises unique violations', function () {
    assert.equal(isUniqueViolation({ code: 'ER_DUP_ENTRY' }), true);
    assert.equal(isUniqueViolation({ code: 'SQLITE_CONSTRAINT_UNIQUE' }), true);
    // Ghost's better-sqlite3 patch reshapes the code to the primary one.
    assert.equal(
      isUniqueViolation({
        code: 'SQLITE_CONSTRAINT',
        message: 'insert into `members` - UNIQUE constraint failed: members.email',
      }),
      true,
    );
  });

  it('rejects foreign key and other errors', function () {
    assert.equal(isUniqueViolation({ code: 'SQLITE_CONSTRAINT_FOREIGNKEY' }), false);
    assert.equal(
      isUniqueViolation({ code: 'SQLITE_CONSTRAINT', message: 'FOREIGN KEY constraint failed' }),
      false,
    );
    assert.equal(isUniqueViolation({ code: 'ER_NO_REFERENCED_ROW_2' }), false);
    assert.equal(isUniqueViolation(new Error('boom')), false);
    assert.equal(isUniqueViolation(null), false);
  });
});
