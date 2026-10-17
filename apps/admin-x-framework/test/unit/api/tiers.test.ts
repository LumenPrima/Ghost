// fork(salvare): one-time tier purchases.
import { describe, expect, it } from 'vitest';

import {
  type Tier,
  getPaidActiveSubscriptionTiers,
  isPurchaseOnlyTier,
} from '../../../src/api/tiers';

describe('isPurchaseOnlyTier', () => {
  it('is true for a positive one-time price', () => {
    expect(isPurchaseOnlyTier({ one_time_price: 9900 })).toBe(true);
  });

  it('is false when the one-time price is missing, null or zero', () => {
    expect(isPurchaseOnlyTier({})).toBe(false);
    expect(isPurchaseOnlyTier({ one_time_price: null })).toBe(false);
    expect(isPurchaseOnlyTier({ one_time_price: 0 })).toBe(false);
  });
});

describe('getPaidActiveSubscriptionTiers', () => {
  const tier = (overrides: Partial<Tier>): Tier => ({
    id: 'tier',
    name: 'Tier',
    description: null,
    slug: 'tier',
    active: true,
    type: 'paid',
    welcome_page_url: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    visibility: 'public',
    benefits: [],
    trial_days: 0,
    ...overrides,
  });

  it('leaves out free, archived and purchase-only tiers', () => {
    const tiers = [
      tier({ id: 'free', type: 'free' }),
      tier({ id: 'archived', active: false }),
      tier({ id: 'course', one_time_price: 9900 }),
      tier({ id: 'sub', one_time_price: null }),
    ];

    expect(getPaidActiveSubscriptionTiers(tiers).map((t) => t.id)).toEqual(['sub']);
  });

  it('is empty when every paid tier is purchase-only', () => {
    expect(getPaidActiveSubscriptionTiers([tier({ one_time_price: 9900 })])).toEqual([]);
  });
});
