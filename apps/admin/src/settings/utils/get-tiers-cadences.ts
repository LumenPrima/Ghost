import { type Tier, isPurchaseOnlyTier } from '@tryghost/admin-x-framework/api/tiers'; // fork(salvare)

export interface TierCadenceOption {
  label: string;
  value: string;
}

export const getTiersCadences = (tiers: Tier[]): TierCadenceOption[] => {
  const cadences: TierCadenceOption[] = [];

  tiers.forEach((tier: Tier) => {
    // fork(salvare): offers on a purchase-only tier are refused at checkout
    if (isPurchaseOnlyTier(tier)) {
      return;
    }

    cadences.push({
      label: `${tier.name} - Monthly`,
      value: `${tier.id}-month-${tier.currency}`,
    });

    cadences.push({
      label: `${tier.name} - Yearly`,
      value: `${tier.id}-year-${tier.currency}`,
    });
  });

  return cadences;
};
