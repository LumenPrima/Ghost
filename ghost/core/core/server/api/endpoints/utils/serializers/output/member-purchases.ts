// fork(salvare): staff view of a member's one-time purchases. See services/purchases/README.md.
import { z } from 'zod';
import type { AdminPurchaseView } from '../../../../../services/purchases/purchase-views';

// The views already carry the wire field names (purchase-views.ts). Parsing is
// an allowlist: anything else on a view never reaches the response.
const Tier = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
});

const AdminPurchase = z.object({
  id: z.string(),
  member_id: z.string(),
  tier: Tier,
  status: z.enum(['paid', 'refunded', 'revoked']),
  source: z.enum(['stripe', 'manual']),
  amount: z.number().int(),
  currency: z.string(),
  stripe_payment_intent_id: z.string().nullable(),
  stripe_checkout_session_id: z.string().nullable(),
  stripe_customer_id: z.string().nullable(),
  expires_at: z.date().nullable(),
  refunded_at: z.date().nullable(),
  revoked_at: z.date().nullable(),
  created_at: z.date(),
  updated_at: z.date().nullable(),
}) satisfies z.ZodType<AdminPurchaseView>;

const MemberPurchasesResponse = z.object({ member_purchases: z.array(AdminPurchase) });

interface Frame {
  response?: unknown;
}

const respond = (views: AdminPurchaseView[], frame: Frame): void => {
  frame.response = MemberPurchasesResponse.parse({ member_purchases: views });
};

// module.exports (not export): the API framework loads serializers via require().
// `destroy` falls back to the default serializer (204, empty body).
module.exports = {
  browse(result: { data: AdminPurchaseView[] }, _apiConfig: unknown, frame: Frame): void {
    respond(result.data, frame);
  },
  add(view: AdminPurchaseView, _apiConfig: unknown, frame: Frame): void {
    respond([view], frame);
  },
};
