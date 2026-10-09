// fork(salvare): staff email for a one-time tier purchase, adapted from gift.txt.ts
import type { ReadonlyDeep } from 'type-fest';
import type { StaffTextBaseData } from './types';

type PurchaseTextData = StaffTextBaseData &
  ReadonlyDeep<{
    purchase: {
      name: string;
      tierName: string;
      amount: string;
      possibleDuplicate: boolean;
    };
  }>;

export function renderText(data: PurchaseTextData): string {
  const duplicateNotice = data.purchase.possibleDuplicate
    ? `
POSSIBLE DUPLICATE PURCHASE — CONSIDER A REFUND
This member already had access to ${data.purchase.tierName} through an earlier purchase. The payment was recorded; check it in Stripe and refund it if it was made by mistake.
`
    : '';

  // Be careful when you indent the email, because whitespaces are visible in emails!
  return `
A tier was purchased
${duplicateNotice}
From: ${data.purchase.name}
Tier: ${data.purchase.tierName}
Amount received: ${data.purchase.amount}

---

Sent to ${data.toEmail} from ${data.siteDomain}.
If you would no longer like to receive these notifications you can adjust your settings at ${data.staffUrl}.
    `;
}
