// fork(salvare): row menu for a one-time purchase on the member detail screen.
import React from 'react';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  LoadingIndicator,
} from '@tryghost/shade/components';
import { LucideIcon } from '@tryghost/shade/utils';
import { Stack } from '@tryghost/shade/primitives';
import { formatMemberName } from '@/members/member-format';
import { getApiErrorReason } from './member-purchase';
import { toast } from 'sonner';
import { useRevokeMemberPurchase } from '@tryghost/admin-x-framework/api/member-purchases';
import type { Member } from '@tryghost/admin-x-framework/api/members';
import type { MemberPurchase } from '@tryghost/admin-x-framework/api/member-purchases';

interface MemberPurchaseActionsProps {
  member: Member;
  purchase: MemberPurchase;
  /** Another purchase or a subscription still grants the tier after the revoke. */
  tierKept?: boolean;
}

/**
 * Stripe deep links (when the purchase has the ids, in the same style as
 * `member-subscription-actions.tsx`) and "Revoke access" for a paid row.
 * Revoking removes access without refunding; the server keeps the tier when
 * something else still grants it.
 */
const MemberPurchaseActions: React.FC<MemberPurchaseActionsProps> = ({
  member,
  purchase,
  tierKept = false,
}) => {
  const revoke = useRevokeMemberPurchase();
  const [confirmOpen, setConfirmOpen] = React.useState(false);

  const paymentIntentId = purchase.stripe_payment_intent_id;
  const customerId = purchase.stripe_customer_id;
  const canRevoke = purchase.status === 'paid';
  const hasStripeLinks = !!paymentIntentId || !!customerId;

  if (!hasStripeLinks && !canRevoke) {
    return null;
  }

  const tierName = purchase.tier.name;
  const memberName = formatMemberName(member);

  const onConfirmRevoke = () => {
    revoke.mutate(
      { memberId: member.id, purchaseId: purchase.id },
      {
        onSuccess: () => {
          toast.success('Access revoked');
          setConfirmOpen(false);
        },
        onError: (error) =>
          toast.error('Couldn’t revoke access', {
            description: getApiErrorReason(error) ?? undefined,
          }),
      },
    );
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            aria-label="Purchase menu"
            data-testid="purchase-actions"
            disabled={revoke.isPending}
            size="sm"
            variant="outline"
          >
            {revoke.isPending ? <LoadingIndicator size="sm" /> : <LucideIcon.MoreHorizontal />}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {paymentIntentId && (
            <DropdownMenuItem asChild>
              <a
                href={`https://dashboard.stripe.com/payments/${paymentIntentId}`}
                rel="noopener noreferrer"
                target="_blank"
              >
                View Stripe payment
              </a>
            </DropdownMenuItem>
          )}
          {customerId && (
            <DropdownMenuItem asChild>
              <a
                href={`https://dashboard.stripe.com/customers/${customerId}`}
                rel="noopener noreferrer"
                target="_blank"
              >
                View Stripe customer
              </a>
            </DropdownMenuItem>
          )}
          {hasStripeLinks && canRevoke && <DropdownMenuSeparator />}
          {canRevoke && (
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              data-testid="revoke-purchase"
              onSelect={() => setConfirmOpen(true)}
            >
              Revoke access
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!revoke.isPending) {
            setConfirmOpen(open);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{`Revoke access to ${tierName}?`}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <Stack gap="sm">
                <span>
                  {tierKept
                    ? `${memberName} keeps access to ${tierName} through another purchase or subscription.`
                    : `${memberName} will lose access to ${tierName} right away.`}
                </span>
                {purchase.source === 'stripe' && (
                  <span>This doesn’t refund the payment in Stripe.</span>
                )}
              </Stack>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revoke.isPending}>Cancel</AlertDialogCancel>
            {/* Not `AlertDialogAction`: it closes the dialog when clicked, which
                would hide the loading state. `onSuccess` closes it instead. */}
            <Button
              data-testid="confirm-revoke-purchase"
              disabled={revoke.isPending}
              variant="destructive"
              onClick={onConfirmRevoke}
            >
              {revoke.isPending ? (
                <>
                  <LoadingIndicator size="sm" />
                  <span className="sr-only">Revoking</span>
                </>
              ) : (
                'Revoke access'
              )}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};

export default MemberPurchaseActions;
