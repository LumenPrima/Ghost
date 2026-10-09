import assert from 'node:assert/strict';
import type { Knex } from 'knex';
import { getPurchaseSourcedProducts } from '../../../../../core/server/services/purchases/purchase-links';
import { toDatabaseDate } from '../../../../../core/server/lib/db-types/date';
import { createPurchaseTables, createSqliteKnex } from './db';

const COURSE = 'course_tier_000000000000';
const LIBRARY = 'library_tier_00000000000';

describe('getPurchaseSourcedProducts', function () {
  let knex: Knex;
  let counter: number;

  async function insertPurchase(row: {
    member_id?: string;
    product_id: string;
    status?: 'paid' | 'refunded';
    expires_at?: Date | null;
  }) {
    counter += 1;
    await knex('members_purchases').insert({
      id: `purchase_${counter}`.padEnd(24, '0'),
      member_id: row.member_id ?? 'member_1',
      product_id: row.product_id,
      stripe_checkout_session_id: `cs_${counter}`,
      stripe_payment_intent_id: `pi_${counter}`,
      amount: 9900,
      currency: 'usd',
      status: row.status ?? 'paid',
      expires_at: row.expires_at ? toDatabaseDate(row.expires_at) : null,
      created_at: toDatabaseDate(new Date()),
    });
  }

  beforeEach(async function () {
    counter = 0;
    knex = createSqliteKnex();
    await createPurchaseTables(knex);
    await knex('members').insert([{ id: 'member_1' }, { id: 'member_2' }]);
    await knex('products').insert([{ id: COURSE }, { id: LIBRARY }]);
  });

  afterEach(async function () {
    await knex.destroy();
  });

  it('returns nothing without a member id', async function () {
    await insertPurchase({ product_id: COURSE });

    assert.deepEqual(await getPurchaseSourcedProducts(knex, ''), []);
  });

  it('returns paid, unexpired purchases of this member only', async function () {
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
    future.setMilliseconds(0);
    await insertPurchase({ product_id: COURSE });
    await insertPurchase({ product_id: LIBRARY, expires_at: future });
    await insertPurchase({ member_id: 'member_2', product_id: COURSE });

    const products = await getPurchaseSourcedProducts(knex, 'member_1');

    assert.deepEqual(
      products.sort((a, b) => a.id.localeCompare(b.id)),
      [
        { id: COURSE, expiry_at: null },
        { id: LIBRARY, expiry_at: future },
      ],
    );
  });

  it('ignores refunded and expired purchases', async function () {
    await insertPurchase({ product_id: COURSE, status: 'refunded' });
    await insertPurchase({ product_id: LIBRARY, expires_at: new Date(Date.now() - 1000 * 60) });

    assert.deepEqual(await getPurchaseSourcedProducts(knex, 'member_1'), []);
  });

  it('returns one entry per product, where a lifetime purchase wins', async function () {
    await insertPurchase({ product_id: COURSE, expires_at: new Date(Date.now() + 60_000_000) });
    await insertPurchase({ product_id: COURSE });
    await insertPurchase({ product_id: COURSE, expires_at: new Date(Date.now() + 90_000_000) });

    assert.deepEqual(await getPurchaseSourcedProducts(knex, 'member_1'), [
      { id: COURSE, expiry_at: null },
    ]);
  });

  it('otherwise keeps the latest expiry', async function () {
    const sooner = new Date('2099-01-01T00:00:00.000Z');
    const later = new Date('2099-06-01T00:00:00.000Z');
    await insertPurchase({ product_id: COURSE, expires_at: later });
    await insertPurchase({ product_id: COURSE, expires_at: sooner });

    assert.deepEqual(await getPurchaseSourcedProducts(knex, 'member_1'), [
      { id: COURSE, expiry_at: later },
    ]);
  });

  it('reads inside the given transaction', async function () {
    const products = await knex.transaction(async (transacting) => {
      await transacting('members_purchases').insert({
        id: 'purchase_in_trx_00000000',
        member_id: 'member_1',
        product_id: COURSE,
        amount: 9900,
        currency: 'usd',
        status: 'paid',
        created_at: toDatabaseDate(new Date()),
      });

      return getPurchaseSourcedProducts(knex, 'member_1', { transacting });
    });

    assert.deepEqual(products, [{ id: COURSE, expiry_at: null }]);
  });
});
