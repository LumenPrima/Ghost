import assert from 'node:assert/strict';
import nql from '@tryghost/nql';
import type { Knex } from 'knex';
import { PurchaseEventRepository } from '../../../../../core/server/services/purchases/purchase-event-repository';
import { toDatabaseDate } from '../../../../../core/server/lib/db-types/date';
import { createPurchaseTables, createSqliteKnex } from './db';

const COURSE = 'course_tier_000000000000';
const LIBRARY = 'library_tier_00000000000';

// What event-repository.js passes on: its own filter, parsed, without `type`.
function parse(filter: string): unknown {
  return nql(filter).parse();
}

describe('PurchaseEventRepository', function () {
  let knex: Knex;
  let repository: PurchaseEventRepository;

  async function insertPurchase(row: {
    id: string;
    member_id?: string | null;
    product_id?: string;
    status?: 'paid' | 'refunded' | 'revoked';
    stripe_checkout_session_id?: string | null;
    amount?: number;
    created_at: string;
    refunded_at?: string | null;
    revoked_at?: string | null;
  }) {
    await knex('members_purchases').insert({
      member_id: 'member_1',
      product_id: COURSE,
      status: 'paid',
      stripe_checkout_session_id: null,
      amount: 9900,
      currency: 'usd',
      refunded_at: null,
      revoked_at: null,
      ...row,
      id: row.id.padEnd(24, '0'),
    });
  }

  const at = (iso: string) => toDatabaseDate(new Date(iso));
  const ids = (page: { data: Array<{ data: { id: string } }> }) =>
    page.data.map((event) => event.data.id.replace(/0+$/, ''));

  beforeEach(async function () {
    knex = createSqliteKnex();
    await createPurchaseTables(knex);
    await knex('members').insert([
      {
        id: 'member_1',
        uuid: 'uuid-1',
        name: 'Ada',
        email: 'ada@example.com',
      },
      {
        id: 'member_2',
        uuid: 'uuid-2',
        name: null,
        email: 'bob@example.com',
      },
    ]);
    await knex('products').insert([
      { id: COURSE, name: 'Breaking Free', slug: 'breaking-free' },
      { id: LIBRARY, name: 'Library', slug: 'library' },
    ]);
    repository = new PurchaseEventRepository({
      knex,
      getAvatarImage: (email) =>
        email.startsWith('bob') ? `https://gravatar.test/${email}` : null,
    });

    // a: a Stripe purchase, later refunded
    await insertPurchase({
      id: 'a',
      stripe_checkout_session_id: 'cs_a',
      status: 'refunded',
      created_at: at('2026-10-01T10:00:00Z'),
      refunded_at: at('2026-10-03T10:00:00Z'),
    });
    // b: a staff grant, later revoked
    await insertPurchase({
      id: 'b',
      product_id: LIBRARY,
      amount: 0,
      status: 'revoked',
      created_at: at('2026-10-02T10:00:00Z'),
      revoked_at: at('2026-10-04T10:00:00Z'),
    });
    // c: another member's purchase
    await insertPurchase({
      id: 'c',
      member_id: 'member_2',
      stripe_checkout_session_id: 'cs_c',
      created_at: at('2026-10-05T10:00:00Z'),
    });
    // d: refunded before it was fulfilled: never granted access
    await insertPurchase({
      id: 'd',
      stripe_checkout_session_id: 'cs_d',
      status: 'refunded',
      created_at: at('2026-10-06T10:00:00Z'),
      refunded_at: at('2026-10-06T10:00:00Z'),
    });
    // e: the member was deleted
    await insertPurchase({
      id: 'e',
      member_id: null,
      stripe_checkout_session_id: 'cs_e',
      status: 'revoked',
      created_at: at('2026-10-07T10:00:00Z'),
      revoked_at: at('2026-10-07T11:00:00Z'),
    });
  });

  afterEach(async function () {
    await knex.destroy();
  });

  it('lists purchases by created_at, newest first, with the member and tier', async function () {
    const page = await repository.browse('purchase_event', { limit: 10 });

    assert.deepEqual(ids(page), ['c', 'b', 'a']);
    assert.equal(page.meta.pagination.total, 3);
    assert.deepEqual(page.data[2], {
      type: 'purchase_event',
      data: {
        id: 'a'.padEnd(24, '0'),
        member: {
          id: 'member_1',
          uuid: 'uuid-1',
          name: 'Ada',
          email: 'ada@example.com',
          avatar_image: null,
        },
        member_id: 'member_1',
        tier_id: COURSE,
        tier_name: 'Breaking Free',
        amount: 9900,
        currency: 'usd',
        source: 'stripe',
        created_at: new Date('2026-10-01T10:00:00Z'),
      },
    });
    assert.equal(page.data[1].data.source, 'manual');
    assert.equal(page.data[1].data.amount, 0);
    assert.equal(page.data[1].data.tier_name, 'Library');
  });

  it('lists refunds by refunded_at', async function () {
    const page = await repository.browse('purchase_refunded_event', { limit: 10 });

    // d never granted access, but the refund of a real payment is still listed.
    assert.deepEqual(ids(page), ['d', 'a']);
    assert.equal(page.meta.pagination.total, 2);
    assert.equal(page.data[0].type, 'purchase_refunded_event');
    assert.deepEqual(page.data[1].data.created_at, new Date('2026-10-03T10:00:00Z'));
  });

  it('lists revokes by revoked_at, leaving out rows whose member was deleted', async function () {
    const page = await repository.browse('purchase_revoked_event', { limit: 10 });

    assert.deepEqual(ids(page), ['b']);
    assert.equal(page.meta.pagination.total, 1);
    assert.equal(page.data[0].type, 'purchase_revoked_event');
    assert.deepEqual(page.data[0].data.created_at, new Date('2026-10-04T10:00:00Z'));
  });

  it('filters by data.member_id', async function () {
    const page = await repository.browse(
      'purchase_event',
      { limit: 10 },
      parse("data.member_id:'member_2'"),
    );

    assert.deepEqual(ids(page), ['c']);
    assert.equal(page.data[0].data.member?.avatar_image, 'https://gravatar.test/bob@example.com');
  });

  it("maps data.created_at to the type's own date column", async function () {
    const purchases = await repository.browse(
      'purchase_event',
      { limit: 10 },
      parse("data.created_at:<'2026-10-02 10:00:00'"),
    );
    assert.deepEqual(ids(purchases), ['a']);

    const refunds = await repository.browse(
      'purchase_refunded_event',
      { limit: 10 },
      parse("data.created_at:<'2026-10-04 00:00:00'"),
    );
    assert.deepEqual(ids(refunds), ['a']);
  });

  it('passes an id cursor through unchanged (Ember paging)', async function () {
    const cursor = 'b'.padEnd(24, '0');
    const page = await repository.browse(
      'purchase_event',
      { limit: 10 },
      parse(
        `(data.created_at:<'2026-10-02 10:00:00',(data.created_at:'2026-10-02 10:00:00'+id:<'${cursor}'))`,
      ),
    );

    assert.deepEqual(ids(page), ['a']);
  });

  it('applies the limit to the rows but not to the total', async function () {
    const page = await repository.browse('purchase_event', { limit: 2 });

    assert.deepEqual(ids(page), ['c', 'b']);
    assert.equal(page.meta.pagination.total, 3);

    const second = await repository.browse('purchase_event', { limit: 2, page: 2 });
    assert.deepEqual(ids(second), ['a']);

    const all = await repository.browse('purchase_event', { limit: 'all' });
    assert.deepEqual(ids(all), ['c', 'b', 'a']);
  });

  it('leaves avatar_image null without an avatar source', async function () {
    const page = await new PurchaseEventRepository({ knex }).browse('purchase_event', { limit: 1 });

    assert.equal(page.data[0].data.member?.avatar_image, null);
  });

  it('returns an empty page when nothing matches', async function () {
    const page = await repository.browse(
      'purchase_event',
      { limit: 10 },
      parse("data.member_id:'nobody'"),
    );

    assert.deepEqual(page, { data: [], meta: { pagination: { total: 0 } } });
  });
});
