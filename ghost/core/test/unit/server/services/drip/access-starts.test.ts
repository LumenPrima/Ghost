import assert from 'node:assert/strict';
import moment from 'moment';
import {
  computeAccessStarts,
  isAccessStarts,
  toDate,
} from '../../../../../core/server/services/drip/access-starts';

const COURSE = 'course_tier_000000000000';
const LIBRARY = 'library_tier_00000000000';
const OTHER = 'other_tier_0000000000000';

const SIGNUP = '2026-01-01T10:00:00.000Z';

function member(overrides: Record<string, unknown> = {}) {
  return {
    id: 'member_1',
    uuid: 'uuid-1',
    status: 'free',
    created_at: SIGNUP,
    products: [{ id: COURSE, slug: 'course', name: 'Course' }],
    productEvents: [] as unknown[],
    subscriptions: [] as unknown[],
    ...overrides,
  };
}

function added(productId: string, createdAt: unknown) {
  return { product_id: productId, action: 'added', created_at: createdAt };
}

function removed(productId: string, createdAt: unknown) {
  return { product_id: productId, action: 'removed', created_at: createdAt };
}

function subscription(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sub_123',
    status: 'active',
    start_date: '2026-02-01T00:00:00.000Z',
    tier: { id: COURSE },
    price: { product: { product_id: COURSE } },
    ...overrides,
  };
}

describe('drip access starts', function () {
  describe('toDate', function () {
    const iso = '2026-10-06T21:00:00.000Z';

    it('accepts a Date, SQL string, ISO string, epoch number and moment', function () {
      assert.equal(toDate(new Date(iso))?.toISOString(), iso);
      assert.equal(toDate('2026-10-06 21:00:00')?.toISOString(), iso);
      assert.equal(toDate(iso)?.toISOString(), iso);
      assert.equal(toDate('2026-10-06T23:00:00+02:00')?.toISOString(), iso);
      assert.equal(toDate(Date.parse(iso))?.toISOString(), iso);
      assert.equal(toDate(moment(iso))?.toISOString(), iso);
    });

    it('returns null for missing or unparseable input', function () {
      for (const value of [null, undefined, '', 'not a date', new Date('nope'), {}, true]) {
        assert.equal(toDate(value), null, String(value));
      }
    });
  });

  describe('computeAccessStarts', function () {
    it('uses the latest added event for a held tier', function () {
      const starts = computeAccessStarts(
        member({ productEvents: [added(COURSE, '2026-03-01 12:00:00')] }),
      );

      assert.deepEqual(starts, {
        member: SIGNUP,
        products: { [COURSE]: '2026-03-01T12:00:00.000Z' },
      });
    });

    it('takes the latest added event after a lapse and resubscribe, whatever the order', function () {
      const starts = computeAccessStarts(
        member({
          // Deliberately not newest-first.
          productEvents: [
            added(COURSE, '2026-02-01T00:00:00.000Z'),
            added(COURSE, '2026-05-01T00:00:00.000Z'),
            removed(COURSE, '2026-03-01T00:00:00.000Z'),
          ],
        }),
      );

      assert.equal(starts?.products[COURSE], '2026-05-01T00:00:00.000Z');
    });

    it('keeps an earlier comp event when a purchase while comped writes no new event', function () {
      // grantPurchasedProduct only writes `added` for a new link, so the comp date stays.
      const starts = computeAccessStarts(
        member({ status: 'comped', productEvents: [added(COURSE, '2026-02-10T00:00:00.000Z')] }),
      );

      assert.equal(starts?.products[COURSE], '2026-02-10T00:00:00.000Z');
    });

    it('lets an active Stripe subscription with an earlier start_date win', function () {
      const starts = computeAccessStarts(
        member({
          status: 'paid',
          productEvents: [added(COURSE, '2026-04-01T00:00:00.000Z')],
          subscriptions: [subscription({ start_date: '2026-02-01T00:00:00.000Z' })],
        }),
      );

      assert.equal(starts?.products[COURSE], '2026-02-01T00:00:00.000Z');
    });

    it('matches a subscription by price product when it has no tier', function () {
      const starts = computeAccessStarts(
        member({
          productEvents: [added(COURSE, '2026-04-01T00:00:00.000Z')],
          subscriptions: [
            subscription({ tier: null, start_date: moment('2026-02-01T00:00:00.000Z') }),
          ],
        }),
      );

      assert.equal(starts?.products[COURSE], '2026-02-01T00:00:00.000Z');
    });

    it('counts trialing, unpaid and past_due subscriptions but not canceled ones', function () {
      for (const status of ['trialing', 'unpaid', 'past_due']) {
        const starts = computeAccessStarts(
          member({
            productEvents: [added(COURSE, '2026-04-01T00:00:00.000Z')],
            subscriptions: [subscription({ status })],
          }),
        );
        assert.equal(starts?.products[COURSE], '2026-02-01T00:00:00.000Z', status);
      }

      for (const status of ['canceled', 'incomplete', 'incomplete_expired']) {
        const starts = computeAccessStarts(
          member({
            productEvents: [added(COURSE, '2026-04-01T00:00:00.000Z')],
            subscriptions: [subscription({ status })],
          }),
        );
        assert.equal(starts?.products[COURSE], '2026-04-01T00:00:00.000Z', status);
      }
    });

    it('skips synthetic Complimentary/Gift subscriptions (id "")', function () {
      // The bread service dates these "now" when no event exists; using it would lock everything.
      const starts = computeAccessStarts(
        member({
          status: 'comped',
          productEvents: [added(COURSE, '2026-04-01T00:00:00.000Z')],
          subscriptions: [subscription({ id: '', start_date: moment('2025-01-01T00:00:00.000Z') })],
        }),
      );

      assert.equal(starts?.products[COURSE], '2026-04-01T00:00:00.000Z');
    });

    it('ignores subscriptions on another tier', function () {
      const starts = computeAccessStarts(
        member({
          productEvents: [added(COURSE, '2026-04-01T00:00:00.000Z')],
          subscriptions: [
            subscription({ tier: { id: OTHER }, price: { product: { product_id: OTHER } } }),
          ],
        }),
      );

      assert.equal(starts?.products[COURSE], '2026-04-01T00:00:00.000Z');
    });

    it('falls back to signup when a held tier has no source', function () {
      const starts = computeAccessStarts(member({ productEvents: [] }));

      assert.deepEqual(starts, { member: SIGNUP, products: { [COURSE]: SIGNUP } });
    });

    it('only lists tiers the member holds', function () {
      const starts = computeAccessStarts(
        member({
          products: [{ id: COURSE }, { id: LIBRARY }],
          productEvents: [
            added(COURSE, '2026-03-01T00:00:00.000Z'),
            added(OTHER, '2026-01-15T00:00:00.000Z'), // no longer held
          ],
        }),
      );

      assert.deepEqual(Object.keys(starts!.products).sort(), [COURSE, LIBRARY].sort());
      assert.equal(starts?.products[COURSE], '2026-03-01T00:00:00.000Z');
      assert.equal(starts?.products[LIBRARY], SIGNUP);
    });

    it('accepts Date, SQL, epoch and moment dates and outputs ISO UTC', function () {
      const starts = computeAccessStarts(
        member({
          created_at: new Date('2026-01-01T10:00:00.000Z'),
          products: [{ id: COURSE }, { id: LIBRARY }, { id: OTHER }],
          productEvents: [
            added(COURSE, new Date('2026-03-01T00:00:00.000Z')),
            added(LIBRARY, Date.parse('2026-03-02T00:00:00.000Z')),
            added(OTHER, moment('2026-03-03T00:00:00.000Z')),
          ],
        }),
      );

      assert.deepEqual(starts, {
        member: SIGNUP,
        products: {
          [COURSE]: '2026-03-01T00:00:00.000Z',
          [LIBRARY]: '2026-03-02T00:00:00.000Z',
          [OTHER]: '2026-03-03T00:00:00.000Z',
        },
      });
    });

    it('ignores unparseable event dates', function () {
      const starts = computeAccessStarts(
        member({
          productEvents: [added(COURSE, 'garbage'), added(COURSE, '2026-03-01T00:00:00.000Z')],
        }),
      );

      assert.equal(starts?.products[COURSE], '2026-03-01T00:00:00.000Z');
    });

    it('returns a precomputed access_starts as is (trimmed theme-helper context)', function () {
      const accessStarts = { member: SIGNUP, products: { [COURSE]: '2026-03-01T00:00:00.000Z' } };
      // @member + products + access_starts: no productEvents.
      const context = {
        uuid: 'uuid-1',
        status: 'free',
        products: [{ id: COURSE, slug: 'course' }],
        access_starts: accessStarts,
      };

      assert.equal(computeAccessStarts(context), accessStarts);
    });

    it('returns null for a malformed access_starts', function () {
      assert.equal(computeAccessStarts({ uuid: 'u', access_starts: { member: 1 } }), null);
      assert.equal(computeAccessStarts({ uuid: 'u', access_starts: 'yesterday' }), null);
    });

    it('returns null without access_starts or a productEvents array', function () {
      // The plain @member template object.
      assert.equal(
        computeAccessStarts({ uuid: 'uuid-1', status: 'paid', subscriptions: [] }),
        null,
      );
      assert.equal(computeAccessStarts(member({ productEvents: undefined })), null);
      assert.equal(computeAccessStarts(null), null);
      assert.equal(computeAccessStarts('member'), null);
    });

    it('gives member null when signup is unknown, and leaves sourceless tiers out', function () {
      const starts = computeAccessStarts(member({ created_at: null, productEvents: [] }));

      assert.deepEqual(starts, { member: null, products: {} });
    });
  });

  describe('isAccessStarts', function () {
    it('recognises the shape', function () {
      assert.equal(isAccessStarts({ member: null, products: {} }), true);
      assert.equal(isAccessStarts({ member: SIGNUP, products: { a: SIGNUP } }), true);
      assert.equal(isAccessStarts({ member: SIGNUP, products: [] }), false);
      assert.equal(isAccessStarts({ member: SIGNUP }), false);
      assert.equal(isAccessStarts(null), false);
    });
  });
});
