import sinon from 'sinon';
import type { PurchaseTier } from '../../../../../core/server/services/purchases/purchase-checkout-adapter';
import type { PurchaseMember } from '../../../../../core/server/services/purchases/purchase-service';
import type { PurchaseData } from '../../../../../core/server/services/purchases/purchase-schema';

export const TIER_ID = '0123456789abcdef01234567';

export function buildTier(overrides: Partial<PurchaseTier> = {}): PurchaseTier {
  return {
    id: { toHexString: () => TIER_ID },
    slug: 'breaking-free',
    name: 'Breaking Free',
    type: 'paid',
    status: 'active',
    currency: 'USD',
    oneTimePrice: 9900,
    welcomePageURL: '/start/',
    ...overrides,
  };
}

export function buildMember({
  id = 'member_1',
  email = 'member@example.com',
  name = 'Member Name',
  uuid = 'member-uuid-1',
}: { id?: string; email?: string; name?: string | null; uuid?: string } = {}): PurchaseMember {
  const get = sinon.stub();
  get.withArgs('email').returns(email);
  get.withArgs('name').returns(name);
  get.withArgs('uuid').returns(uuid);

  return { id, get } as unknown as PurchaseMember;
}

export function buildPurchase(overrides: Partial<PurchaseData> = {}): PurchaseData {
  return {
    id: 'purchase_1',
    memberId: 'member_1',
    productId: TIER_ID,
    stripeCheckoutSessionId: 'cs_1',
    stripePaymentIntentId: 'pi_1',
    stripeCustomerId: 'cus_1',
    amount: 9900,
    currency: 'usd',
    status: 'paid',
    expiresAt: null,
    refundedAt: null,
    revokedAt: null,
    attributionId: null,
    attributionType: null,
    attributionUrl: null,
    referrerSource: null,
    referrerMedium: null,
    referrerUrl: null,
    utmSource: null,
    utmMedium: null,
    utmCampaign: null,
    utmTerm: null,
    utmContent: null,
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    updatedAt: new Date('2026-10-01T00:00:00.000Z'),
    ...overrides,
  };
}
