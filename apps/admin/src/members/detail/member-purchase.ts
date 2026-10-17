// fork(salvare): pure helpers for the member Purchases panel.
import moment from 'moment-timezone';
import { JSONError } from '@tryghost/admin-x-framework/errors';
import { formatEventAmount } from './member-event';
import { isPurchaseOnlyTier } from '@tryghost/admin-x-framework/api/tiers';
import type { Member } from '@tryghost/admin-x-framework/api/members';
import type {
  MemberPurchase,
  MemberPurchaseSource,
  MemberPurchaseStatus,
} from '@tryghost/admin-x-framework/api/member-purchases';
import type { Tier } from '@tryghost/admin-x-framework/api/tiers';

export function getPurchaseStatusLabel(status: MemberPurchaseStatus): string {
  switch (status) {
    case 'paid':
      return 'Paid';
    case 'refunded':
      return 'Refunded';
    case 'revoked':
      return 'Revoked';
  }
}

export function getPurchaseSourceLabel(source: MemberPurchaseSource): string {
  return source === 'stripe' ? 'Stripe' : 'Granted by staff';
}

/**
 * The amount as the member paid it, or `null` when the purchase recorded no
 * payment (a staff grant). Zero-decimal currencies aren't divided by 100.
 */
export function formatPurchaseAmount(
  purchase: Pick<MemberPurchase, 'amount' | 'currency'>,
): string | null {
  if (!(purchase.amount > 0) || !purchase.currency) {
    return null;
  }
  return formatEventAmount(purchase.amount, purchase.currency);
}

// UTC, like the Subscriptions section and the sidebar on the same screen.
export const formatPurchaseDate = (value?: string | null) =>
  value ? moment.utc(value).format('D MMM YYYY') : '';

/** The line under the tier name: how long access lasts, or when it ended. */
export function getPurchaseAccessLabel(
  purchase: Pick<MemberPurchase, 'status' | 'expires_at' | 'refunded_at' | 'revoked_at'>,
): string {
  if (purchase.status === 'revoked') {
    const date = formatPurchaseDate(purchase.revoked_at);
    return date ? `Revoked on ${date}` : 'Access revoked';
  }
  if (purchase.status === 'refunded') {
    const date = formatPurchaseDate(purchase.refunded_at);
    return date ? `Refunded on ${date}` : 'Payment refunded';
  }
  if (purchase.expires_at) {
    return `Access until ${formatPurchaseDate(purchase.expires_at)}`;
  }
  return 'Lifetime access';
}

/**
 * Tiers staff can grant this member: active, paid, sold as a one-time purchase,
 * and not already held. A held tier is refused by the server anyway, as owned
 * or as a comp to remove first.
 */
export function getGrantableTiers(tiers: Tier[], member: Pick<Member, 'tiers'>): Tier[] {
  const held = new Set((member.tiers ?? []).map((tier) => tier.id));
  return tiers.filter(
    (tier) => tier.active && tier.type === 'paid' && isPurchaseOnlyTier(tier) && !held.has(tier.id),
  );
}

// Server refusals that are about the chosen tier, shown under the tier field.
const TIER_ERROR_CODES = new Set(['PURCHASE_ALREADY_OWNED', 'PURCHASE_COMP_EXISTS']);

/**
 * The message to show under the tier field when the server refused the grant
 * because of the tier, or `null` for any other failure (shown as a toast).
 *
 * Core's error handler replaces `message` with a generic "Validation error,
 * cannot save member_purchase." and moves the service's sentence to `context`
 * (see `getErrorMessage`), so `context` is read first.
 */
export function getGrantTierError(error: unknown): string | null {
  if (!(error instanceof JSONError)) {
    return null;
  }
  const first = error.data?.errors?.[0];
  // Refusals without a code (the tier was archived, or switched back to a
  // subscription, after the modal opened) name the field instead.
  const isTierError =
    (first?.code && TIER_ERROR_CODES.has(first.code)) || first?.property === 'tier_id';
  if (!first || !isTierError) {
    return null;
  }
  return first.context || first.message || null;
}

/**
 * The server's own sentence for a failed request, for a toast's description,
 * or `null` when there isn't one (a network failure). `context` first, for the
 * reason given above.
 */
export function getApiErrorReason(error: unknown): string | null {
  if (!(error instanceof JSONError)) {
    return null;
  }
  const first = error.data?.errors?.[0];
  return first?.context || first?.message || null;
}

// Core's `isActiveSubscriptionStatus`, as in member-purchase-tiers.ts.
const ACTIVE_SUBSCRIPTION_STATUSES = new Set(['active', 'trialing', 'past_due', 'unpaid']);

/**
 * Whether revoking `purchase` leaves the member holding its tier, because the
 * server keeps the link for another active purchase of it (a duplicate
 * checkout) or an active Stripe subscription on it. Synthetic `id: ''` rows
 * don't count: Core also builds those for purchased tiers.
 */
export function isTierKeptAfterRevoke(
  purchase: Pick<MemberPurchase, 'id' | 'tier'>,
  purchases: Pick<MemberPurchase, 'id' | 'tier' | 'status' | 'expires_at'>[],
  member: Pick<Member, 'subscriptions'>,
  now: Date = new Date(),
): boolean {
  const tierId = purchase.tier.id;
  const otherPurchase = purchases.some(
    (other) =>
      other.id !== purchase.id &&
      other.tier.id === tierId &&
      other.status === 'paid' &&
      (!other.expires_at || new Date(other.expires_at) > now),
  );
  if (otherPurchase) {
    return true;
  }
  return (member.subscriptions ?? []).some(
    (sub) => !!sub.id && sub.tier?.id === tierId && ACTIVE_SUBSCRIPTION_STATUSES.has(sub.status),
  );
}
