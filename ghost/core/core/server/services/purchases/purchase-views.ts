// fork(salvare): Phase 4 contracts for the purchases Admin and members API surfaces. See README.md.
//
// The API layer, the activity feed and the members BREAD service code against
// these types. The wire shapes are frozen: the serializers map these views to
// JSON without renaming fields. Dates are Date objects here; the serializers
// format them.
import type { Knex } from 'knex';

export type PurchaseViewStatus = 'paid' | 'refunded' | 'revoked';

/** Derived: `stripe` when the row has a checkout session id, otherwise `manual` (a staff grant). */
export type PurchaseSource = 'stripe' | 'manual';

/** Error codes the grant and revoke paths raise (as `code` on a 422 ValidationError). */
export const PurchaseErrorCode = {
  alreadyOwned: 'PURCHASE_ALREADY_OWNED',
  backdateLinkExists: 'PURCHASE_BACKDATE_LINK_EXISTS',
  compExists: 'PURCHASE_COMP_EXISTS',
} as const;
export type PurchaseErrorCode = (typeof PurchaseErrorCode)[keyof typeof PurchaseErrorCode];

export interface PurchaseTierRef {
  id: string;
  name: string;
  slug: string;
}

/** One row of `GET /ghost/api/admin/members/:id/purchases/` (`member_purchases`). */
export interface AdminPurchaseView {
  id: string;
  member_id: string;
  tier: PurchaseTierRef;
  status: PurchaseViewStatus;
  source: PurchaseSource;
  amount: number;
  currency: string;
  stripe_payment_intent_id: string | null;
  stripe_checkout_session_id: string | null;
  stripe_customer_id: string | null;
  expires_at: Date | null;
  refunded_at: Date | null;
  revoked_at: Date | null;
  created_at: Date;
  updated_at: Date | null;
}

/** One row of `GET /members/api/purchases/` (`purchases`): active purchases only, never Stripe ids. */
export interface MemberPurchaseView {
  id: string;
  tier: PurchaseTierRef & { welcome_page_url: string | null };
  purchased_at: Date;
  amount: number;
  currency: string;
}

export type PurchaseEventType =
  | 'purchase_event'
  | 'purchase_refunded_event'
  | 'purchase_revoked_event';

/** The member as the activity feed embeds it. */
export interface PurchaseEventMember {
  id: string;
  uuid: string;
  name: string | null;
  email: string;
  avatar_image: string | null;
}

export interface PurchaseEventRow {
  type: PurchaseEventType;
  data: {
    id: string;
    member: PurchaseEventMember | null;
    member_id: string;
    tier_id: string;
    tier_name: string | null;
    amount: number;
    currency: string;
    source: PurchaseSource;
    /** The type's own date: created_at, refunded_at or revoked_at. */
    created_at: Date;
  };
}

/** `getEventTimeline` reads only `data` and `meta.pagination.total`. */
export interface PurchaseEventPage {
  data: PurchaseEventRow[];
  meta: { pagination: { total: number } };
}

/** What every purchase event list returns when the purchases service is unset. Never null. */
export function emptyPurchaseEventPage(): PurchaseEventPage {
  return { data: [], meta: { pagination: { total: 0 } } };
}

/** The options `event-repository.js` passes to each per-type list. */
export interface PurchaseEventBrowseOptions {
  limit?: number | 'all';
  order?: string;
  page?: number;
  filter?: string;
}

/** A parsed NQL (mongo-style) filter object, passed through from the event repository. */
export type ParsedNqlFilter = unknown;

export interface GrantPurchaseInput {
  memberId: string;
  tierId: string;
  /** ISO 8601 with an explicit offset, or a Date; null or absent means now. */
  createdAt?: string | Date | null;
  /** Minor units; defaults to 0. */
  amount?: number;
  /** Defaults to the tier currency. Stored lowercase. */
  currency?: string | null;
  /** Send the member the access email. Defaults to false. Never sends the staff email. */
  sendEmail?: boolean;
  /** Staff user id or API key id, for logging only. */
  actor?: string | null;
}

export interface RevokePurchaseInput {
  memberId: string;
  purchaseId: string;
  actor?: string | null;
}

/**
 * The methods PurchaseService adds in Phase 4. PurchaseService implements this
 * interface.
 *
 * Errors: an unknown member or purchase (or a purchase of another member) is a
 * NotFoundError (404). Grant refusals are 422 ValidationErrors carrying a
 * `PurchaseErrorCode` or the tier messages (not found, archived, not
 * purchasable).
 */
export interface PurchaseAdminOperations {
  /** Creates a manual purchase and links the tier. Returns the new row. */
  grant(input: GrantPurchaseInput): Promise<AdminPurchaseView>;
  /** Marks a paid row revoked and unlinks the tier unless something else grants it. Idempotent. */
  revoke(input: RevokePurchaseInput): Promise<void>;
  /** Every row of the member, newest first. */
  browseForMember(memberId: string): Promise<AdminPurchaseView[]>;
  /** Paid, unexpired rows of the member, newest first. */
  browseActiveForMember(memberId: string): Promise<MemberPurchaseView[]>;
  browseEvents(
    type: PurchaseEventType,
    options?: PurchaseEventBrowseOptions,
    filter?: ParsedNqlFilter,
  ): Promise<PurchaseEventPage>;
}

/**
 * Batched form of `getPurchaseSourcedProducts` (purchase-links.ts), with the
 * same "active purchase" definition. Members with no active purchase are absent
 * from the map. An empty `memberIds` runs no query.
 */
export type GetPurchaseSourcedProductIdsForMembers = (
  knex: Knex,
  memberIds: string[],
  options?: { transacting?: Knex.Transaction },
) => Promise<Map<string, Set<string>>>;

// Implemented in purchase-links.ts. At runtime, callers outside this module use
// `purchaseLinks.getPurchaseSourcedProductIdsForMembers` from services/members/api.js.
export { getPurchaseSourcedProductIdsForMembers } from './purchase-links';
