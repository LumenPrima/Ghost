// fork(salvare): the body of POST /members/:id/purchases/ (a staff grant of a one-time tier purchase).
import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import * as apiSchema from '../src/index.js';

const TIER_ID = '0123456789abcdef01234567';

const hasErrorType = (error: unknown, errorType: string): boolean => {
  return (
    typeof error === 'object' &&
    error !== null &&
    'errorType' in error &&
    error.errorType === errorType
  );
};

const validate = (data: unknown) => apiSchema.validate({ data, schema: 'member_purchases-add' });

const purchase = (fields: Record<string, unknown>) => ({
  member_purchases: [{ tier_id: TIER_ID, ...fields }],
});

describe('member_purchases-add', function () {
  it('is listed as an action schema', function () {
    assert.ok(apiSchema.list().includes('member_purchases-add'));
  });

  it('accepts a tier id alone', async function () {
    await assert.doesNotReject(() => validate(purchase({})));
  });

  it('accepts a backdated grant with an amount and a currency', async function () {
    for (const createdAt of [
      '2024-03-01T00:00:00Z',
      '2024-03-01T00:00:00.000z',
      '2024-03-01T09:30:00+01:00',
      '2024-03-01T09:30:00-05:00',
    ]) {
      await assert.doesNotReject(
        () => validate(purchase({ created_at: createdAt, amount: 9900, currency: 'USD' })),
        createdAt,
      );
    }
  });

  it('accepts null for created_at and currency, and the largest amount', async function () {
    await assert.doesNotReject(() =>
      validate(purchase({ created_at: null, currency: null, amount: 2147483647 })),
    );
    await assert.doesNotReject(() => validate(purchase({ amount: 0 })));
  });

  it('strips fields a grant cannot set rather than rejecting them', async function () {
    // removeAdditional: the service only ever reads the declared fields.
    const data = purchase({
      status: 'refunded',
      member_id: TIER_ID,
      stripe_payment_intent_id: 'pi_123',
      stripe_checkout_session_id: 'cs_123',
      stripe_customer_id: 'cus_123',
    });

    await validate(data);

    assert.deepEqual(data.member_purchases[0], { tier_id: TIER_ID });
  });

  const invalid: Array<[string, unknown]> = [
    ['a missing tier_id', { member_purchases: [{ amount: 0 }] }],
    ['a tier_id that is not an object id', purchase({ tier_id: 'breaking-free' })],
    ['an uppercase tier_id', purchase({ tier_id: TIER_ID.toUpperCase() })],
    ['a date with no time', purchase({ created_at: '2024-03-01' })],
    ['a date-time with no offset', purchase({ created_at: '2024-03-01T00:00:00' })],
    ['a created_at that is not a date', purchase({ created_at: 'last spring' })],
    ['a numeric created_at', purchase({ created_at: 1709251200000 })],
    ['a negative amount', purchase({ amount: -1 })],
    ['a fractional amount', purchase({ amount: 99.5 })],
    ['an amount over the column range', purchase({ amount: 2147483648 })],
    ['an amount as a string', purchase({ amount: '9900' })],
    ['a two-letter currency', purchase({ currency: 'us' })],
    ['a currency with digits', purchase({ currency: 'us1' })],
    ['an empty list', { member_purchases: [] }],
    ['two purchases at once', { member_purchases: [{ tier_id: TIER_ID }, { tier_id: TIER_ID }] }],
    ['a missing root key', { purchases: [{ tier_id: TIER_ID }] }],
  ];

  for (const [name, data] of invalid) {
    it(`rejects ${name}`, async function () {
      await assert.rejects(
        () => validate(data),
        (error) => hasErrorType(error, 'ValidationError'),
      );
    });
  }
});
