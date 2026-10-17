// fork(salvare): staff grant of a one-time purchase tier, modelled on
// `member-add-comp-modal.tsx`. Backdating access is API only (Thinkific
// migration script), so there's no date input here.
import React from 'react';
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  FieldError,
  FieldLabel,
  LoadingIndicator,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@tryghost/shade/components';
import { Stack } from '@tryghost/shade/primitives';
import { getApiErrorReason, getGrantTierError } from './member-purchase';
import { toast } from 'sonner';
import { useGrantMemberPurchase } from '@tryghost/admin-x-framework/api/member-purchases';
import type { Member } from '@tryghost/admin-x-framework/api/members';
import type { Tier } from '@tryghost/admin-x-framework/api/tiers';

interface MemberGrantPurchaseModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  member: Member;
  /** Tiers this member can be granted; see `getGrantableTiers`. */
  tiers: Tier[];
}

const MemberGrantPurchaseModal: React.FC<MemberGrantPurchaseModalProps> = ({
  open,
  onOpenChange,
  member,
  tiers,
}) => {
  const grant = useGrantMemberPurchase();
  const [selectedTierId, setSelectedTierId] = React.useState('');
  const [sendEmail, setSendEmail] = React.useState(false);
  const [tierError, setTierError] = React.useState<string | null>(null);

  // A reopened modal starts clean.
  React.useEffect(() => {
    if (open) {
      setSelectedTierId('');
      setSendEmail(false);
      setTierError(null);
    }
  }, [open]);

  const canSubmit = !!selectedTierId && !grant.isPending;

  const onSubmit = () => {
    if (!canSubmit) {
      return;
    }
    setTierError(null);
    grant.mutate(
      { memberId: member.id, tierId: selectedTierId, sendEmail },
      {
        onSuccess: () => {
          toast.success('Access granted');
          onOpenChange(false);
        },
        onError: (error) => {
          const message = getGrantTierError(error);
          if (message) {
            setTierError(message);
            return;
          }
          toast.error('Couldn’t grant access', {
            description: getApiErrorReason(error) ?? undefined,
          });
        },
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (grant.isPending) {
          return;
        }
        onOpenChange(next);
      }}
    >
      <DialogContent data-testid="grant-purchase-modal">
        <DialogHeader>
          <DialogTitle>Grant purchase</DialogTitle>
          <DialogDescription>
            Gives this member lifetime access to a course, recorded as a purchase with no payment.
          </DialogDescription>
        </DialogHeader>

        <Stack gap="lg">
          <Field data-invalid={tierError ? true : undefined}>
            <FieldLabel htmlFor="grant-purchase-tier">Tier</FieldLabel>
            <Select
              value={selectedTierId}
              onValueChange={(value) => {
                setSelectedTierId(value);
                setTierError(null);
              }}
            >
              <SelectTrigger
                aria-invalid={tierError ? true : undefined}
                data-testid="grant-purchase-tier-select"
                disabled={grant.isPending}
                id="grant-purchase-tier"
              >
                <SelectValue placeholder="Select a tier" />
              </SelectTrigger>
              <SelectContent>
                {tiers.map((tier) => (
                  <SelectItem key={tier.id} data-tier-id={tier.id} value={tier.id}>
                    {tier.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {tierError && (
              <FieldError data-testid="grant-purchase-tier-error">{tierError}</FieldError>
            )}
          </Field>

          <Field orientation="horizontal">
            <Checkbox
              checked={sendEmail}
              data-testid="grant-purchase-send-email"
              disabled={grant.isPending}
              id="grant-purchase-send-email"
              onCheckedChange={(checked) => setSendEmail(checked === true)}
            />
            <FieldLabel htmlFor="grant-purchase-send-email">
              Email the member a link to the course
            </FieldLabel>
          </Field>
        </Stack>

        <DialogFooter>
          <Button disabled={grant.isPending} variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button data-testid="grant-purchase-confirm" disabled={!canSubmit} onClick={onSubmit}>
            {grant.isPending ? (
              <>
                <LoadingIndicator size="sm" />
                <span className="sr-only">Granting</span>
              </>
            ) : (
              'Grant access'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default MemberGrantPurchaseModal;
