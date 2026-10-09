// English only for now (no t()): each sentence stays whole so that wrapping it
// in t() later is mechanical.

export interface PurchaseAccessEmailData {
  siteTitle: string;
  siteUrl: string;
  siteIconUrl: string | null;
  siteDomain: string;
  accentColor: string;
  toEmail: string;
  purchase: {
    tierName: string;
    isNewMember: boolean;
    accessUrl: string;
    amount: string;
  };
}

export function renderText(data: PurchaseAccessEmailData): string {
  const newMemberSentence = data.purchase.isNewMember
    ? `\n\nWe've created a ${data.siteTitle} account for ${data.toEmail}.`
    : '';

  // Whitespace is visible in plain-text email, so this stays unindented.
  return `You now have access to ${data.purchase.tierName}

Thank you for your purchase of ${data.purchase.tierName} (${data.purchase.amount}).${newMemberSentence}

Use this link to sign in and start:

${data.purchase.accessUrl}

The link is valid for 24 hours. After that, sign in at ${data.siteUrl} with this email address.

---
This message was sent from ${data.siteDomain} to ${data.toEmail}.`;
}
