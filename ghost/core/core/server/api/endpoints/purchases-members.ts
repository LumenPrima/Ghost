// fork(salvare): a member's own one-time purchases. See services/purchases/README.md.
import errors from '@tryghost/errors';
import { z } from 'zod';
import * as purchases from '../../services/purchases';
import type { MemberPurchaseView } from '../../services/purchases/purchase-views';

/**
 * `GET /members/api/purchases/`: the signed-in member's active purchases, for a
 * theme's "Your purchases" list. (A Portal page for it is deferred: Phase 4 record.)
 *
 * The route refuses an anonymous caller before this runs, so there is always a
 * member here. The default output serializer turns `{data: rows}` into
 * `{purchases: rows}`. Parsing each row here is the allowlist that keeps Stripe
 * ids and staff-only fields out of the member-facing response.
 */

const messages = {
  serviceUnavailable: 'The purchases service is not available.',
};

const MemberPurchase = z.object({
  id: z.string(),
  tier: z.object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    welcome_page_url: z.string().nullable(),
  }),
  purchased_at: z.date(),
  amount: z.number().int(),
  currency: z.string(),
}) satisfies z.ZodType<MemberPurchaseView>;

interface Frame {
  options: Record<string, unknown> & {
    context?: { member?: { id: string } | null };
  };
}

const controller = {
  docName: 'purchases',

  browse: {
    headers: { cacheInvalidate: false },
    permissions: false,
    async query(frame: Frame) {
      if (!purchases.service) {
        throw new errors.InternalServerError({ message: messages.serviceUnavailable });
      }

      const memberId = frame.options.context!.member!.id;
      const views = await purchases.service.browseActiveForMember(memberId);

      return { data: views.map((view) => MemberPurchase.parse(view)) };
    },
  },
};

export default controller;
module.exports = controller;
