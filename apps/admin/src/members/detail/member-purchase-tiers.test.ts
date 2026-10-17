// fork(salvare): one-time tier purchases.
import { describe, expect, it } from 'vitest';
import {
  getSubscriptionBackedTiers,
  getSubscriptionTierIds,
  getTiersHeldOutsideSubscriptions,
} from './member-purchase-tiers';
import type { MemberSubscription, MemberTier } from '@tryghost/admin-x-framework/api/members';

function makeTier(id: string): MemberTier {
  return { id, name: id, slug: id, active: true, type: 'paid' };
}

function makeSub(tierId: string, overrides: Partial<MemberSubscription> = {}): MemberSubscription {
  return {
    id: `sub_${tierId}`,
    customer: { id: 'cus_1', name: null, email: 'x@x.co' },
    plan: { id: 'plan_1', nickname: 'Monthly', interval: 'month', currency: 'usd', amount: 500 },
    status: 'active',
    start_date: '2026-01-01T12:00:00.000Z',
    current_period_end: '2026-02-01T12:00:00.000Z',
    cancel_at_period_end: false,
    price: {
      id: 'price_1',
      price_id: 'price_1',
      nickname: 'Monthly',
      amount: 500,
      currency: 'usd',
      type: 'recurring',
      interval: 'month',
    },
    tier: makeTier(tierId),
    offer: null,
    ...overrides,
  };
}

function compRow(tierId: string): MemberSubscription {
  return makeSub(tierId, {
    id: '',
    plan: { id: '', nickname: 'Complimentary', interval: 'year', currency: 'usd', amount: 0 },
  });
}

describe('getSubscriptionTierIds', () => {
  it('counts subscriptions in a state that grants access', () => {
    const subscriptions = ['active', 'trialing', 'past_due', 'unpaid'].map((status) =>
      makeSub(status, { status }),
    );
    expect([...getSubscriptionTierIds({ subscriptions })].sort()).toEqual(
      ['active', 'past_due', 'trialing', 'unpaid'].sort(),
    );
  });

  it('leaves out canceled and incomplete subscriptions', () => {
    const subscriptions = [
      makeSub('gone', { status: 'canceled' }),
      makeSub('pending', { status: 'incomplete_expired' }),
    ];
    expect(getSubscriptionTierIds({ subscriptions }).size).toBe(0);
  });

  it('counts the synthetic comp and gift rows (id "")', () => {
    expect([...getSubscriptionTierIds({ subscriptions: [compRow('comp')] })]).toEqual(['comp']);
  });

  it('copes with a member that has no subscriptions key', () => {
    expect(getSubscriptionTierIds({}).size).toBe(0);
  });
});

describe('getTiersHeldOutsideSubscriptions', () => {
  it('a free purchaser holds the course outside any subscription', () => {
    const member = { tiers: [makeTier('course')], subscriptions: [] };
    expect(getTiersHeldOutsideSubscriptions(member).map((t) => t.id)).toEqual(['course']);
    expect(getSubscriptionBackedTiers(member)).toEqual([]);
  });

  it('a comped purchaser: the comp is backed, the course is not', () => {
    const member = {
      tiers: [makeTier('library'), makeTier('course')],
      subscriptions: [compRow('library')],
    };
    expect(getTiersHeldOutsideSubscriptions(member).map((t) => t.id)).toEqual(['course']);
    expect(getSubscriptionBackedTiers(member).map((t) => t.id)).toEqual(['library']);
  });

  it('a past subscriber of the same tier still holds the purchase outside it', () => {
    const member = {
      tiers: [makeTier('course')],
      subscriptions: [makeSub('course', { status: 'canceled' })],
    };
    expect(getTiersHeldOutsideSubscriptions(member).map((t) => t.id)).toEqual(['course']);
  });

  it('stock Core: a paid member with an extra comp link holds it outside subscriptions', () => {
    // Core builds comp rows only for comped and gift members, so this link has
    // no row. The hooks still refuse a comp, because the paid tier is backed.
    const member = {
      tiers: [makeTier('gold'), makeTier('extra')],
      subscriptions: [makeSub('gold')],
    };
    expect(getTiersHeldOutsideSubscriptions(member).map((t) => t.id)).toEqual(['extra']);
    expect(getSubscriptionBackedTiers(member).map((t) => t.id)).toEqual(['gold']);
  });
});
