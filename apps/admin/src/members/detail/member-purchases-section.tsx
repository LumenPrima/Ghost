// fork(salvare): the member's one-time purchases (core services/purchases/README.md).
import MemberGrantPurchaseModal from './member-grant-purchase-modal';
import MemberPurchaseActions from './member-purchase-actions';
import React from 'react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  EmptyIndicator,
  Skeleton,
} from '@tryghost/shade/components';
import { Inline, Stack, Text } from '@tryghost/shade/primitives';
import { LucideIcon, cn } from '@tryghost/shade/utils';
import {
  formatPurchaseAmount,
  formatPurchaseDate,
  getGrantableTiers,
  getPurchaseAccessLabel,
  getPurchaseSourceLabel,
  getPurchaseStatusLabel,
  isTierKeptAfterRevoke,
} from './member-purchase';
import { useBrowseMemberPurchases } from '@tryghost/admin-x-framework/api/member-purchases';
import { useBrowseTiers } from '@tryghost/admin-x-framework/api/tiers';
import { useSalvareCapabilities } from '@/salvare/use-salvare-capabilities';
import type { Member } from '@tryghost/admin-x-framework/api/members';
import type { MemberPurchase } from '@tryghost/admin-x-framework/api/member-purchases';

const PurchaseRow: React.FC<{
  member: Member;
  purchase: MemberPurchase;
  purchases: MemberPurchase[];
  showDivider: boolean;
}> = ({ member, purchase, purchases, showDivider }) => {
  const amount = formatPurchaseAmount(purchase);
  const details = [
    amount,
    formatPurchaseDate(purchase.created_at),
    getPurchaseSourceLabel(purchase.source),
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <Inline
      align="start"
      className={cn('py-4 first:pt-0 last:pb-0', showDivider && 'border-t border-border')}
      data-testid="member-purchase"
      gap="lg"
      justify="between"
    >
      <Stack className="min-w-0" gap="xs">
        <Inline gap="sm">
          <Text data-testid="member-purchase-tier" weight="semibold" truncate>
            {purchase.tier.name}
          </Text>
          <Badge
            data-testid="member-purchase-status"
            variant={purchase.status === 'paid' ? 'success' : 'secondary'}
          >
            {getPurchaseStatusLabel(purchase.status)}
          </Badge>
        </Inline>
        <Text data-testid="member-purchase-access" size="sm">
          {getPurchaseAccessLabel(purchase)}
        </Text>
        <Text data-testid="member-purchase-details" size="sm" tone="secondary">
          {details}
        </Text>
      </Stack>
      <MemberPurchaseActions
        member={member}
        purchase={purchase}
        tierKept={isTierKeptAfterRevoke(purchase, purchases, member)}
      />
    </Inline>
  );
};

interface MemberPurchasesSectionProps {
  member: Member;
}

/**
 * Purchases panel for a saved member. Renders only against a backend that
 * reports `config.salvare.purchases`, and needs no Stripe connection: grants
 * and revokes don't touch Stripe, only the row links do.
 */
const MemberPurchasesSection: React.FC<MemberPurchasesSectionProps> = ({ member }) => {
  const { purchases: supported } = useSalvareCapabilities();
  const [showGrant, setShowGrant] = React.useState(false);

  const { data, isLoading, isError, refetch } = useBrowseMemberPurchases(member.id, {
    enabled: supported,
    defaultErrorHandler: false,
  });
  // Same query as the member screen and the comp modal, so react-query shares it.
  const { data: tiersData } = useBrowseTiers({
    searchParams: { filter: 'type:paid+active:true', limit: 'all' },
    enabled: supported,
  });

  if (!supported) {
    return null;
  }

  const purchases = data?.member_purchases ?? [];
  const grantableTiers = getGrantableTiers(tiersData?.tiers ?? [], member);

  const grantButton =
    grantableTiers.length > 0 ? (
      <Button data-testid="grant-purchase" variant="outline" onClick={() => setShowGrant(true)}>
        <LucideIcon.Plus className="mr-1" size={16} />
        Grant purchase
      </Button>
    ) : null;

  let body: React.ReactNode;
  if (isLoading) {
    body = (
      <Stack gap="md">
        <Skeleton className="h-10" />
        <Skeleton className="h-10" />
      </Stack>
    );
  } else if (isError) {
    body = (
      <Stack align="center" className="py-4" gap="md">
        <Text tone="secondary">Couldn’t load purchases.</Text>
        <Button variant="outline" onClick={() => void refetch()}>
          Retry
        </Button>
      </Stack>
    );
  } else if (purchases.length === 0) {
    body = (
      <Stack align="center" className="py-4" gap="md">
        <EmptyIndicator title="No purchases">
          <LucideIcon.ShoppingBag />
        </EmptyIndicator>
        {grantButton}
      </Stack>
    );
  } else {
    body = (
      <>
        <Stack gap="none">
          {purchases.map((purchase, i) => (
            <PurchaseRow
              key={purchase.id}
              member={member}
              purchase={purchase}
              purchases={purchases}
              showDivider={i > 0}
            />
          ))}
        </Stack>
        {grantButton && (
          <Inline className="mt-4 border-t border-border pt-4" justify="center">
            {grantButton}
          </Inline>
        )}
      </>
    );
  }

  return (
    <section aria-labelledby="member-purchases-heading">
      <Stack gap="md">
        <h3 className="text-base font-semibold" id="member-purchases-heading">
          Purchases
        </h3>
        <Card data-testid="member-purchases">
          <CardContent className="pt-6">{body}</CardContent>
        </Card>
      </Stack>
      <MemberGrantPurchaseModal
        member={member}
        open={showGrant}
        tiers={grantableTiers}
        onOpenChange={setShowGrant}
      />
    </section>
  );
};

export default MemberPurchasesSection;
