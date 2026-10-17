// fork(salvare): one-time tier purchases.
import { act, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createTestQueryClient, renderHookWithProviders } from '../../../src/test/test-utils';
import {
  useBrowseMemberPurchases,
  useGrantMemberPurchase,
  useRevokeMemberPurchase,
} from '../../../src/api/member-purchases';
import type { MemberPurchase } from '../../../src/api/member-purchases';
import { withMockFetch } from '../../utils/mock-fetch';

const apiRoot = 'http://localhost:3000/ghost/api/admin';

const purchase: MemberPurchase = {
  id: 'purchase-1',
  member_id: 'member-1',
  tier: { id: 'tier-1', name: 'Breaking Free', slug: 'breaking-free' },
  status: 'paid',
  source: 'manual',
  amount: 0,
  currency: 'usd',
  stripe_payment_intent_id: null,
  stripe_checkout_session_id: null,
  stripe_customer_id: null,
  expires_at: null,
  refunded_at: null,
  revoked_at: null,
  created_at: '2026-10-01T00:00:00.000Z',
  updated_at: '2026-10-01T00:00:00.000Z',
};

// Queries the mutations must mark stale: the purchases list, the member (its
// tiers change) and the activity feed (a new entry).
const RELATED = [
  'MemberPurchasesResponseType',
  'MembersResponseType',
  'MemberActivityFeedResponseType',
];

function seedRelatedQueries(queryClient: ReturnType<typeof createTestQueryClient>) {
  for (const dataType of RELATED) {
    queryClient.setQueryDefaults([dataType], { gcTime: Infinity });
    queryClient.setQueryData([dataType, 'seed'], {});
  }
}

function expectInvalidated(queryClient: ReturnType<typeof createTestQueryClient>) {
  for (const dataType of RELATED) {
    const queries = queryClient
      .getQueryCache()
      .getAll()
      .filter((q) => q.queryKey[0] === dataType);
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.every((q) => q.state.isInvalidated)).toBe(true);
  }
}

describe('member purchases api', () => {
  it('browses a member’s purchases from the member sub-resource', async () => {
    const queryClient = createTestQueryClient();

    await withMockFetch({ json: { member_purchases: [purchase] } }, async (mock) => {
      const { result } = renderHookWithProviders(() => useBrowseMemberPurchases('member-1'), {
        queryClient,
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      // Queries read the current user first, so find the purchases request by URL.
      const urls = mock.calls.map((call: [unknown]) => String(call[0]));
      expect(urls).toContain(`${apiRoot}/members/member-1/purchases/`);
      expect(result.current.data?.member_purchases).toEqual([purchase]);
    });
  });

  it('grants a tier with the member_purchases envelope and no email by default', async () => {
    const queryClient = createTestQueryClient();
    seedRelatedQueries(queryClient);

    await withMockFetch({ json: { member_purchases: [purchase] }, status: 201 }, async (mock) => {
      const { result } = renderHookWithProviders(() => useGrantMemberPurchase(), { queryClient });

      await act(async () => {
        await result.current.mutateAsync({ memberId: 'member-1', tierId: 'tier-1' });
      });

      expect(mock.calls[0][0].toString()).toBe(`${apiRoot}/members/member-1/purchases/`);
      expect(mock.calls[0][1].method).toBe('POST');
      expect(JSON.parse(mock.calls[0][1].body)).toEqual({
        member_purchases: [{ tier_id: 'tier-1' }],
      });
      await waitFor(() => expectInvalidated(queryClient));
    });
  });

  it('asks for the access email with send_email=true', async () => {
    const queryClient = createTestQueryClient();

    await withMockFetch({ json: { member_purchases: [purchase] }, status: 201 }, async (mock) => {
      const { result } = renderHookWithProviders(() => useGrantMemberPurchase(), { queryClient });

      await act(async () => {
        await result.current.mutateAsync({
          memberId: 'member-1',
          tierId: 'tier-1',
          sendEmail: true,
        });
      });

      expect(mock.calls[0][0].toString()).toBe(
        `${apiRoot}/members/member-1/purchases/?send_email=true`,
      );
    });
  });

  it('passes the optional backdate, amount and currency through', async () => {
    const queryClient = createTestQueryClient();

    await withMockFetch({ json: { member_purchases: [purchase] }, status: 201 }, async (mock) => {
      const { result } = renderHookWithProviders(() => useGrantMemberPurchase(), { queryClient });

      await act(async () => {
        await result.current.mutateAsync({
          memberId: 'member-1',
          tierId: 'tier-1',
          createdAt: '2024-03-01T00:00:00.000Z',
          amount: 0,
          currency: 'usd',
        });
      });

      // An amount of 0 is a value, not an absence.
      expect(JSON.parse(mock.calls[0][1].body)).toEqual({
        member_purchases: [
          { tier_id: 'tier-1', created_at: '2024-03-01T00:00:00.000Z', amount: 0, currency: 'usd' },
        ],
      });
    });
  });

  it('revokes a purchase with a DELETE on the purchase', async () => {
    const queryClient = createTestQueryClient();
    seedRelatedQueries(queryClient);

    await withMockFetch({ json: {}, status: 204 }, async (mock) => {
      const { result } = renderHookWithProviders(() => useRevokeMemberPurchase(), {
        queryClient,
      });

      await act(async () => {
        await result.current.mutateAsync({ memberId: 'member-1', purchaseId: 'purchase-1' });
      });

      expect(mock.calls[0][0].toString()).toBe(`${apiRoot}/members/member-1/purchases/purchase-1/`);
      expect(mock.calls[0][1].method).toBe('DELETE');
      expect(mock.calls[0][1].body).toBeUndefined();
      await waitFor(() => expectInvalidated(queryClient));
    });
  });
});
