import { InfiniteData } from '@tanstack/react-query';
import { Meta, createInfiniteQuery, createMutation } from '../utils/api/hooks';
import { updateQueryCache } from '../utils/api/update-queries';

// Types

export type Tier = {
  id: string;
  name: string;
  description: string | null;
  slug: string;
  active: boolean;
  type: string;
  welcome_page_url: string | null;
  created_at: string;
  updated_at: string;
  visibility: string;
  benefits: string[];
  currency?: string;
  monthly_price?: number;
  yearly_price?: number;
  one_time_price?: number | null; // fork(salvare): set on tiers sold as a one-time purchase
  trial_days: number;
};

export interface TiersResponseType {
  meta?: Meta;
  tiers: Tier[];
}

// Requests

const dataType = 'TiersResponseType';

export const useBrowseTiers = createInfiniteQuery<TiersResponseType & { isEnd: boolean }>({
  dataType,
  path: '/tiers/',
  defaultNextPageParams: (lastPage, otherParams) => {
    const nextPage = lastPage.meta?.pagination.next;
    if (!nextPage) {
      return undefined;
    }

    return {
      ...otherParams,
      page: nextPage.toString(),
    };
  },
  returnData: (originalData) => {
    const { pages } = originalData as InfiniteData<TiersResponseType>;
    const tiers = pages.flatMap((page) => page.tiers);
    const meta = pages[pages.length - 1].meta;

    return {
      tiers,
      meta,
      isEnd: meta ? meta.pagination.pages === meta.pagination.page : true,
    };
  },
});

export const useAddTier = createMutation<TiersResponseType, Partial<Tier>>({
  method: 'POST',
  path: () => '/tiers/',
  body: (tier) => ({ tiers: [tier] }),
  // We may have queries for paid/archived/etc, so we can't assume how to update the global store and need to reload queries from the server
  invalidateQueries: { dataType },
});

export const useEditTier = createMutation<TiersResponseType, Tier>({
  method: 'PUT',
  path: (tier) => `/tiers/${tier.id}/`,
  body: (tier) => ({ tiers: [tier] }),
  updateQueries: {
    dataType,
    emberUpdateType: 'createOrUpdate',
    update: updateQueryCache('tiers'),
  },
});

// Helpers

export function getPaidActiveTiers(tiers: Tier[]) {
  return tiers.filter((tier) => {
    return tier.type === 'paid' && tier.active;
  });
}

// fork(salvare): a tier sold only as a one-time purchase (a course). Its
// monthly and yearly prices are placeholders.
export const isPurchaseOnlyTier = (tier: Pick<Tier, 'one_time_price'>) =>
  typeof tier.one_time_price === 'number' && tier.one_time_price > 0;

// fork(salvare): paid active tiers that are sold as subscriptions, the only
// ones offers, signup links and Portal can use.
export const getPaidActiveSubscriptionTiers = (tiers: Tier[]) =>
  getPaidActiveTiers(tiers).filter((tier) => !isPurchaseOnlyTier(tier));

export function getActiveTiers(tiers: Tier[]) {
  return tiers.filter((tier) => {
    return tier.active;
  });
}

export function getArchivedTiers(tiers: Tier[]) {
  return tiers.filter((tier) => {
    return !tier.active;
  });
}
