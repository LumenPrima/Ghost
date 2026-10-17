// fork(salvare): keeps the comp flows away from purchased tiers.
//
// Core no longer builds a "Complimentary" row for a purchased tier
// (member-bread-service.js), so a purchased tier is in `member.tiers` with no
// row in `member.subscriptions`. These helpers read that difference from the
// member payload alone: no purchases request, and no dependency on a fork
// backend. On stock Core the tiers held outside subscriptions are the odd
// extra comp link on a `paid` member, which the hooks below treat the same way
// upstream does.
import type { Member, MemberTier } from '@tryghost/admin-x-framework/api/members';

// Core's `isActiveSubscriptionStatus`: the Stripe states that grant access.
const ACTIVE_SUBSCRIPTION_STATUSES = new Set(['active', 'trialing', 'past_due', 'unpaid']);

/**
 * Tier ids backed by a subscription row: an active Stripe subscription, or a
 * comp or gift row (`id: ''`). A canceled subscription doesn't count, so a
 * member who once subscribed to a tier isn't treated as still holding it.
 */
export function getSubscriptionTierIds(member: Pick<Member, 'subscriptions'>): Set<string> {
  const ids = new Set<string>();
  for (const sub of member.subscriptions ?? []) {
    const tierId = sub.tier?.id;
    if (!tierId) {
      continue;
    }
    if (!sub.id || ACTIVE_SUBSCRIPTION_STATUSES.has(sub.status)) {
      ids.add(tierId);
    }
  }
  return ids;
}

/** The member's tiers with no subscription row behind them: on the fork, the purchased tiers. */
export function getTiersHeldOutsideSubscriptions(
  member: Pick<Member, 'subscriptions' | 'tiers'>,
): MemberTier[] {
  const backed = getSubscriptionTierIds(member);
  return (member.tiers ?? []).filter((tier) => !backed.has(tier.id));
}

/** The member's tiers that do have a subscription row behind them. */
export function getSubscriptionBackedTiers(
  member: Pick<Member, 'subscriptions' | 'tiers'>,
): MemberTier[] {
  const backed = getSubscriptionTierIds(member);
  return (member.tiers ?? []).filter((tier) => backed.has(tier.id));
}
