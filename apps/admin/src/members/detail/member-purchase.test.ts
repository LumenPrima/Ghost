// fork(salvare): one-time tier purchases.
import { describe, expect, it } from 'vitest';
import { JSONError } from '@tryghost/admin-x-framework/errors';
import {
  formatPurchaseAmount,
  formatPurchaseDate,
  getApiErrorReason,
  getGrantTierError,
  getGrantableTiers,
  getPurchaseAccessLabel,
  getPurchaseSourceLabel,
  getPurchaseStatusLabel,
  isTierKeptAfterRevoke,
} from './member-purchase';
import type { ErrorResponse } from '@tryghost/admin-x-framework/errors';
import type { MemberSubscription } from '@tryghost/admin-x-framework/api/members';
import type { Tier } from '@tryghost/admin-x-framework/api/tiers';

function makeTier(overrides: Partial<Tier> = {}): Tier {
  return {
    id: 'tier-1',
    name: 'Breaking Free',
    slug: 'breaking-free',
    description: null,
    active: true,
    type: 'paid',
    welcome_page_url: null,
    visibility: 'none',
    benefits: [],
    currency: 'usd',
    monthly_price: 500,
    yearly_price: 5000,
    one_time_price: 9900,
    trial_days: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function apiError(
  code: string | null,
  message: string,
  context: string | null = null,
  property: string | null = null,
): JSONError {
  const data = {
    errors: [{ code, message, context, property, type: 'ValidationError' }],
  } as unknown as ErrorResponse;
  return new JSONError(undefined, data);
}

describe('getPurchaseStatusLabel', () => {
  it('labels each status', () => {
    expect(getPurchaseStatusLabel('paid')).toBe('Paid');
    expect(getPurchaseStatusLabel('refunded')).toBe('Refunded');
    expect(getPurchaseStatusLabel('revoked')).toBe('Revoked');
  });
});

describe('getPurchaseSourceLabel', () => {
  it('names Stripe purchases and staff grants', () => {
    expect(getPurchaseSourceLabel('stripe')).toBe('Stripe');
    expect(getPurchaseSourceLabel('manual')).toBe('Granted by staff');
  });
});

describe('formatPurchaseAmount', () => {
  it('formats whole and fractional amounts', () => {
    expect(formatPurchaseAmount({ amount: 9900, currency: 'usd' })).toBe('$99');
    expect(formatPurchaseAmount({ amount: 1050, currency: 'eur' })).toBe('€10.50');
  });

  it('does not divide zero-decimal currencies by 100', () => {
    expect(formatPurchaseAmount({ amount: 5000, currency: 'jpy' })).toBe('¥5,000');
  });

  it('returns null when no payment was recorded', () => {
    expect(formatPurchaseAmount({ amount: 0, currency: 'usd' })).toBeNull();
  });
});

describe('formatPurchaseDate', () => {
  it('formats in UTC so the day never shifts with the browser timezone', () => {
    expect(formatPurchaseDate('2026-03-01T23:30:00.000Z')).toBe('1 Mar 2026');
    expect(formatPurchaseDate(null)).toBe('');
  });
});

describe('getPurchaseAccessLabel', () => {
  const base = { status: 'paid' as const, expires_at: null, refunded_at: null, revoked_at: null };

  it('a paid purchase is lifetime access', () => {
    expect(getPurchaseAccessLabel(base)).toBe('Lifetime access');
  });

  it('says when access ended', () => {
    expect(
      getPurchaseAccessLabel({
        ...base,
        status: 'refunded',
        refunded_at: '2026-04-02T10:00:00.000Z',
      }),
    ).toBe('Refunded on 2 Apr 2026');
    expect(
      getPurchaseAccessLabel({
        ...base,
        status: 'revoked',
        revoked_at: '2026-04-03T10:00:00.000Z',
      }),
    ).toBe('Revoked on 3 Apr 2026');
  });
});

describe('getGrantableTiers', () => {
  it('keeps active paid purchase-only tiers the member does not hold', () => {
    const course = makeTier({ id: 'course' });
    const owned = makeTier({ id: 'owned' });
    const subscription = makeTier({ id: 'library', one_time_price: undefined });
    const archived = makeTier({ id: 'archived', active: false });
    const free = makeTier({ id: 'free', type: 'free' });

    const grantable = getGrantableTiers([course, owned, subscription, archived, free], {
      tiers: [{ id: 'owned', name: 'Owned', slug: 'owned', active: true, type: 'paid' }],
    });

    expect(grantable.map((tier) => tier.id)).toEqual(['course']);
  });
});

describe('getGrantTierError', () => {
  it('surfaces the server message for refusals about the tier', () => {
    expect(
      getGrantTierError(apiError('PURCHASE_ALREADY_OWNED', 'Member already owns this tier.')),
    ).toBe('Member already owns this tier.');
    expect(getGrantTierError(apiError('PURCHASE_COMP_EXISTS', 'Remove the comp first.'))).toBe(
      'Remove the comp first.',
    );
  });

  it('prefers the context, where core puts the service sentence behind a generic message', () => {
    expect(
      getGrantTierError(
        apiError(
          'PURCHASE_COMP_EXISTS',
          'Validation error, cannot save member_purchase.',
          'Member already has complimentary or gift access to this tier. Remove it before granting a purchase.',
        ),
      ),
    ).toBe(
      'Member already has complimentary or gift access to this tier. Remove it before granting a purchase.',
    );
  });

  it('surfaces uncoded refusals that name the tier field', () => {
    expect(
      getGrantTierError(
        apiError(
          null,
          'Validation error, cannot save member_purchase.',
          'This tier is archived.',
          'tier_id',
        ),
      ),
    ).toBe('This tier is archived.');
  });

  it('returns null for anything else', () => {
    expect(getGrantTierError(apiError('SOMETHING_ELSE', 'Nope.'))).toBeNull();
    expect(getGrantTierError(apiError(null, 'Nope.'))).toBeNull();
    expect(getGrantTierError(new Error('network'))).toBeNull();
  });
});

describe('getApiErrorReason', () => {
  it('returns the context, then the message, of the first error', () => {
    expect(getApiErrorReason(apiError(null, 'Generic.', 'Purchase not found.'))).toBe(
      'Purchase not found.',
    );
    expect(getApiErrorReason(apiError(null, 'Resource not found.'))).toBe('Resource not found.');
  });

  it('returns null when the server sent no reason', () => {
    expect(getApiErrorReason(new Error('network'))).toBeNull();
  });
});

describe('isTierKeptAfterRevoke', () => {
  const tierRef = { id: 'tier-1', name: 'Breaking Free', slug: 'breaking-free' };
  const purchase = { id: 'p1', tier: tierRef, status: 'paid' as const, expires_at: null };
  const now = new Date('2026-10-01T00:00:00.000Z');
  const noSubs = { subscriptions: [] };

  it('is false when nothing else grants the tier', () => {
    expect(isTierKeptAfterRevoke(purchase, [purchase], noSubs, now)).toBe(false);
  });

  it('is true for a duplicate active purchase of the same tier', () => {
    const duplicate = { ...purchase, id: 'p2' };
    expect(isTierKeptAfterRevoke(purchase, [purchase, duplicate], noSubs, now)).toBe(true);
  });

  it('ignores ended, expired and other-tier purchases', () => {
    const others = [
      { ...purchase, id: 'p2', status: 'refunded' as const },
      { ...purchase, id: 'p3', status: 'revoked' as const },
      { ...purchase, id: 'p4', expires_at: '2026-09-01T00:00:00.000Z' },
      { ...purchase, id: 'p5', tier: { ...tierRef, id: 'tier-2' } },
    ];
    expect(isTierKeptAfterRevoke(purchase, [purchase, ...others], noSubs, now)).toBe(false);
  });

  it('is true for an active subscription on the tier, but not a synthetic or canceled one', () => {
    const sub = (id: string, status: string) =>
      ({ id, status, tier: { id: 'tier-1' } }) as unknown as MemberSubscription;
    expect(
      isTierKeptAfterRevoke(purchase, [purchase], { subscriptions: [sub('sub_1', 'active')] }, now),
    ).toBe(true);
    expect(
      isTierKeptAfterRevoke(
        purchase,
        [purchase],
        { subscriptions: [sub('', 'active'), sub('sub_2', 'canceled')] },
        now,
      ),
    ).toBe(false);
  });
});
