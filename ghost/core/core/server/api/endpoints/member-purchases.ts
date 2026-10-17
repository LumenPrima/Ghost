// fork(salvare): staff grants and revokes of one-time tier purchases. See services/purchases/README.md.
import errors from '@tryghost/errors';
import * as purchases from '../../services/purchases';
import type {
  GrantPurchaseInput,
  PurchaseAdminOperations,
} from '../../services/purchases/purchase-views';

/**
 * `/members/:id/purchases/`: list a member's purchases, grant one by hand (with
 * optional backdating, for migrated buyers), and revoke one.
 *
 * Permissions reuse the member ones, as member-commenting.ts does: reading the
 * list is `member.read`, granting and revoking are `member.edit`. That is the
 * same set of roles that can comp a member.
 *
 * The docName is `member_purchases`, not `purchases`: the members API
 * controller for a member's own purchases has that name, and the two must not
 * share a serializer, because this one includes Stripe ids.
 *
 * No method is called `edit`: the framework checks a body `id` against
 * `frame.options.id`, which here is the member id.
 */

const messages = {
  serviceUnavailable: 'The purchases service is not available.',
};

interface Context {
  user?: string | null;
  api_key?: { id: string; type: string } | null;
}

interface MemberFrame {
  options: { id: string; context: Context };
}

interface AddFrame {
  options: { id: string; send_email?: unknown; context: Context };
  data: {
    member_purchases: Array<{
      tier_id: string;
      created_at?: string | null;
      amount?: number;
      currency?: string | null;
    }>;
  };
}

interface DestroyFrame {
  options: { id: string; purchase_id: string; context: Context };
}

function service(): PurchaseAdminOperations {
  if (!purchases.service) {
    throw new errors.InternalServerError({ message: messages.serviceUnavailable });
  }
  return purchases.service;
}

/** Who did it, for the service's log line: the staff user, or the integration's API key. */
function actorOf(context: Context): string | null {
  return context.user ?? context.api_key?.id ?? null;
}

/**
 * `?send_email` arrives as a string: only `true` or `'true'` sends. The service
 * skips the email while the site needs email verification, as members.js does
 * for new members.
 */
function shouldSendEmail(sendEmail: unknown): boolean {
  return sendEmail === true || sendEmail === 'true';
}

function toGrantInput(frame: AddFrame, sendEmail: boolean): GrantPurchaseInput {
  const input = frame.data.member_purchases[0];

  return {
    memberId: frame.options.id,
    tierId: input.tier_id,
    createdAt: input.created_at ?? null,
    amount: input.amount,
    currency: input.currency ?? null,
    sendEmail,
    actor: actorOf(frame.options.context),
  };
}

const controller = {
  docName: 'member_purchases',

  browse: {
    headers: { cacheInvalidate: false },
    options: ['id'],
    validation: {
      options: {
        id: { required: true },
      },
    },
    permissions: {
      docName: 'member',
      method: 'read',
    },
    async query(frame: MemberFrame) {
      return { data: await service().browseForMember(frame.options.id) };
    },
  },

  add: {
    statusCode: 201,
    headers: { cacheInvalidate: false },
    options: ['id', 'send_email'],
    validation: {
      options: {
        id: { required: true },
      },
    },
    permissions: {
      docName: 'member',
      method: 'edit',
    },
    async query(frame: AddFrame) {
      return service().grant(toGrantInput(frame, shouldSendEmail(frame.options.send_email)));
    },
  },

  destroy: {
    statusCode: 204,
    headers: { cacheInvalidate: false },
    options: ['id', 'purchase_id'],
    validation: {
      options: {
        id: { required: true },
        purchase_id: { required: true },
      },
    },
    permissions: {
      docName: 'member',
      method: 'edit',
    },
    async query(frame: DestroyFrame) {
      await service().revoke({
        memberId: frame.options.id,
        purchaseId: frame.options.purchase_id,
        actor: actorOf(frame.options.context),
      });
    },
  },
};

// module.exports required - using `export` causes the module to fail to register
// with the web framework as it's loaded via require()
module.exports = controller;
