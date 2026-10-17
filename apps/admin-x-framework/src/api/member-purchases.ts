// fork(salvare): one-time tier purchases on the member detail screen
// (core services/purchases/README.md). The wire shape mirrors core's
// serializers/output/member-purchases.ts.
import { createMutation, createQueryWithId } from '../utils/api/hooks';

export type MemberPurchaseStatus = 'paid' | 'refunded' | 'revoked';

/** `stripe` when the purchase came through Checkout; `manual` for a staff grant or an import. */
export type MemberPurchaseSource = 'stripe' | 'manual';

export type MemberPurchase = {
  id: string;
  member_id: string;
  tier: {
    id: string;
    name: string;
    slug: string;
  };
  status: MemberPurchaseStatus;
  source: MemberPurchaseSource;
  /** Smallest currency unit; 0 for a grant that recorded no payment. */
  amount: number;
  /** Lowercase ISO code. */
  currency: string;
  stripe_payment_intent_id: string | null;
  stripe_checkout_session_id: string | null;
  stripe_customer_id: string | null;
  expires_at: string | null;
  refunded_at: string | null;
  revoked_at: string | null;
  created_at: string;
  updated_at: string | null;
};

export interface MemberPurchasesResponseType {
  member_purchases: MemberPurchase[];
}

export type GrantMemberPurchasePayload = {
  memberId: string;
  tierId: string;
  /** ISO date-time with an explicit offset. Absent means now. API only; Admin doesn't backdate. */
  createdAt?: string;
  amount?: number;
  currency?: string;
  /** Sends the member the access email. Off unless set. */
  sendEmail?: boolean;
};

export type RevokeMemberPurchasePayload = {
  memberId: string;
  purchaseId: string;
};

const dataType = 'MemberPurchasesResponseType';

// A grant or revoke changes the member's tiers (members.ts keeps its data type
// private, so it is named by its literal) and adds an activity feed entry.
const invalidates = [dataType, 'MembersResponseType', 'MemberActivityFeedResponseType'];

export const useBrowseMemberPurchases = createQueryWithId<MemberPurchasesResponseType>({
  dataType,
  path: (memberId) => `/members/${memberId}/purchases/`,
});

export const useGrantMemberPurchase = createMutation<
  MemberPurchasesResponseType,
  GrantMemberPurchasePayload
>({
  method: 'POST',
  path: ({ memberId }) => `/members/${memberId}/purchases/`,
  searchParams: ({ sendEmail }): Record<string, string> =>
    sendEmail ? { send_email: 'true' } : {},
  body: ({ tierId, createdAt, amount, currency }) => ({
    member_purchases: [
      {
        tier_id: tierId,
        ...(createdAt ? { created_at: createdAt } : {}),
        ...(amount !== undefined ? { amount } : {}),
        ...(currency ? { currency } : {}),
      },
    ],
  }),
  invalidateQueries: { dataType: invalidates },
});

export const useRevokeMemberPurchase = createMutation<void, RevokeMemberPurchasePayload>({
  method: 'DELETE',
  path: ({ memberId, purchaseId }) => `/members/${memberId}/purchases/${purchaseId}/`,
  invalidateQueries: { dataType: invalidates },
});
