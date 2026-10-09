import errors from '@tryghost/errors';
import logging from '@tryghost/logging';
import type { Knex } from 'knex';
import { z } from 'zod';
import type {
  CreatePurchaseSessionInput,
  PurchaseMemberModel,
  PurchaseTier,
} from './purchase-checkout-adapter';
import {
  DuplicatePurchaseError,
  isUniqueViolation,
  type PurchaseRepository,
} from './purchase-knex-repository';
import type { AccessEmailData } from './purchase-email-service';
import type { PurchaseMagicLinks } from './purchase-magic-links';
import {
  PurchaseAttributionTypeSchema,
  type NewPurchaseData,
  type PurchaseData,
} from './purchase-schema';

const EMAIL_MAX_LENGTH = 191;
const NAME_MAX_LENGTH = 191;
const TIER_SLUG_MAX_LENGTH = 191;
// Server-only metadata keys. The router strips them from client metadata too;
// this is defence in depth.
const RESERVED_METADATA_PREFIX = 'ghost_purchase_';

const errorMessages = {
  tierNotFound: 'This tier does not exist.',
  tierArchived: 'This tier is archived.',
  tierNotPurchasable: 'This tier is not available as a one-time purchase.',
  alreadyOwned: 'You already own this.',
  signInRequired: 'Please sign in to continue. We sent you a sign-in link.',
  authenticatedMemberMissing: 'You must be signed in to continue.',
};

export interface PurchaseMember extends PurchaseMemberModel {
  get(key: 'email'): string;
  get(key: 'name'): string | null;
  get(key: 'uuid'): string;
  get(key: string): unknown;
}

export interface PurchaseAttribution {
  id: string | null;
  url: string | null;
  type: string | null;
  referrerSource: string | null;
  referrerMedium: string | null;
  referrerUrl: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmTerm: string | null;
  utmContent: string | null;
}

interface MemberRepository {
  get(
    filter: { id?: string; uuid?: string; email?: string },
    options?: { transacting?: Knex.Transaction },
  ): Promise<PurchaseMember | null>;
  create(
    data: { email: string; name: string | null; attribution: PurchaseAttribution },
    options?: { transacting?: Knex.Transaction },
  ): Promise<PurchaseMember>;
  upsertCustomer(
    data: { customer_id: string; member_id: string; name: string | null; email: string | null },
    options?: { transacting?: Knex.Transaction },
  ): Promise<unknown>;
  grantPurchasedProduct(
    data: { memberId: string; productId: string; expiresAt: Date | null },
    options: { transacting: Knex.Transaction },
  ): Promise<unknown>;
  revokePurchasedProduct(
    data: { memberId: string; productId: string },
    options: { transacting: Knex.Transaction },
  ): Promise<unknown>;
}

interface TiersService {
  api: {
    read(idString: string): Promise<PurchaseTier | null>;
    // `filter` is a mongo-style query object, matched in memory with NQL.
    browse(options: { filter: Record<string, unknown> }): Promise<{ data: PurchaseTier[] }>;
  };
}

interface CheckoutAdapter {
  getCustomerForMember(member: PurchaseMemberModel): Promise<{ id: string }>;
  getOneTimePriceId(tier: PurchaseTier): Promise<string>;
  createSession(input: CreatePurchaseSessionInput): Promise<{ id: string; url: string }>;
}

interface PurchaseEmailService {
  sendAccessEmail(data: AccessEmailData): Promise<void>;
}

interface StaffServiceEmails {
  notifyPurchaseReceived(data: {
    name: string | null;
    email: string;
    memberId: string;
    amount: number;
    currency: string;
    tierName: string;
    possibleDuplicate: boolean;
  }): Promise<void>;
}

export interface PurchaseServiceDeps {
  purchaseRepository: PurchaseRepository;
  checkoutAdapter: CheckoutAdapter;
  memberRepository: MemberRepository;
  tiersService: TiersService;
  magicLinks: PurchaseMagicLinks;
  purchaseEmailService: PurchaseEmailService;
  staffServiceEmails: StaffServiceEmails;
  urlUtils: { getSiteUrl(): string };
}

export interface PurchaseBuyer {
  // Member resolved by the router (identity token, or customerEmail lookup).
  memberId: string | null;
  // Member email, or customerEmail.
  email: string | null;
  isAuthenticated: boolean;
}

export interface StartPurchaseCheckoutInput {
  // At least one of tierId and tierSlug. When tierId is present it wins, even
  // if it is invalid, and tierSlug is ignored.
  tierId?: string | null;
  tierSlug?: string | null;
  // Already sanitised by the router (sanitizeReturnUrl).
  successUrl?: string | null;
  cancelUrl?: string | null;
  // Attribution/referrer/utm keys; the router has already stripped reserved keys.
  metadata?: Record<string, unknown>;
  buyer: PurchaseBuyer;
}

export interface FulfilPurchaseInput {
  stripeCheckoutSessionId: string;
  stripePaymentIntentId: string | null;
  stripeCustomerId: string | null;
  // metadata.ghost_purchase_tier_id
  tierId: string;
  // metadata.ghost_purchase_member_uuid (only set for authenticated checkouts)
  memberUuid: string | null;
  email: string | null;
  name: string | null;
  // session.amount_total, which includes tax when automatic tax is on
  amount: number;
  currency: string;
  attribution: PurchaseAttribution;
  // The payment was refunded before the purchase was recorded.
  alreadyRefunded?: boolean;
}

export type FulfilResult =
  | { outcome: 'fulfilled'; purchaseId: string; memberId: string; newMember: boolean }
  | { outcome: 'refunded'; purchaseId: string }
  | { outcome: 'duplicate' }
  | { outcome: 'ignored'; reason: 'tier_not_found' };

export interface RefundPurchaseInput {
  paymentIntentId: string;
  fullyRefunded: boolean;
}

const NullableStringSchema = z
  .string()
  .nullish()
  .transform((value) => (value === undefined || value === '' ? null : value));

const OptionalEmailSchema = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? null : value),
  z.string().trim().email().max(EMAIL_MAX_LENGTH).nullish().default(null),
);

const StartCheckoutInputSchema = z.preprocess(
  // tierId wins strictly: once it is present, tierSlug is neither validated
  // nor used, so a stale id is reported instead of silently falling back.
  (value) => {
    const tierId =
      value && typeof value === 'object' ? (value as { tierId?: unknown }).tierId : null;
    if (tierId !== undefined && tierId !== null) {
      return { ...(value as object), tierSlug: null };
    }
    return value;
  },
  z
    .object({
      tierId: z
        .string()
        .trim()
        .min(1)
        .nullish()
        .transform((value) => value ?? null),
      tierSlug: z
        .string()
        .trim()
        .min(1)
        .max(TIER_SLUG_MAX_LENGTH)
        .nullish()
        .transform((value) => value ?? null),
      successUrl: NullableStringSchema,
      cancelUrl: NullableStringSchema,
      metadata: z.record(z.string(), z.unknown()).nullish(),
      buyer: z.object({
        memberId: NullableStringSchema,
        email: OptionalEmailSchema,
        isAuthenticated: z.boolean(),
      }),
    })
    .refine((data) => data.tierId !== null || data.tierSlug !== null, {
      message: 'tierId or tierSlug is required',
      path: ['tierId'],
    }),
);

const AttributionInputSchema = z.object({
  id: NullableStringSchema,
  url: NullableStringSchema,
  type: NullableStringSchema,
  referrerSource: NullableStringSchema,
  referrerMedium: NullableStringSchema,
  referrerUrl: NullableStringSchema,
  utmSource: NullableStringSchema,
  utmMedium: NullableStringSchema,
  utmCampaign: NullableStringSchema,
  utmTerm: NullableStringSchema,
  utmContent: NullableStringSchema,
});

const FulfilInputSchema = z.object({
  stripeCheckoutSessionId: z.string().min(1),
  stripePaymentIntentId: NullableStringSchema,
  stripeCustomerId: NullableStringSchema,
  tierId: z.string().min(1),
  memberUuid: NullableStringSchema,
  email: z.preprocess(
    (value) => (typeof value === 'string' ? value.trim() : value),
    NullableStringSchema,
  ),
  name: NullableStringSchema,
  amount: z.number().int().nonnegative(),
  currency: z
    .string()
    .min(1)
    .transform((value) => value.toLowerCase()),
  attribution: AttributionInputSchema.nullish().transform(
    (value) => value ?? AttributionInputSchema.parse({}),
  ),
  alreadyRefunded: z.boolean().nullish().default(false),
});

type ParsedFulfilInput = z.output<typeof FulfilInputSchema>;

const RefundInputSchema = z.object({
  paymentIntentId: z.string().min(1),
  fullyRefunded: z.boolean(),
});

const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/i;

// Member creation lost a race with the pre-checkout magic link: the email now
// belongs to a member committed by another request. fulfil() retries once.
class MemberCreationRaceError extends Error {
  constructor({ cause }: { cause: unknown }) {
    super('Purchaser email was registered concurrently', { cause });
    this.name = 'MemberCreationRaceError';
  }
}

interface ResolvedMember {
  member: PurchaseMember;
  newMember: boolean;
  // True when the purchaser proved ownership of the member: an authenticated
  // checkout (uuid) or a member created from this payment.
  trusted: boolean;
}

interface FulfilledPurchase {
  purchaseId: string;
  member: PurchaseMember;
  newMember: boolean;
  possibleDuplicate: boolean;
}

function fit(value: string | null, maxLength: number): string | null {
  return value === null ? null : value.slice(0, maxLength);
}

export class PurchaseService {
  private readonly deps: PurchaseServiceDeps;

  constructor(deps: PurchaseServiceDeps) {
    this.deps = deps;
  }

  async startCheckout(input: StartPurchaseCheckoutInput): Promise<{ url: string }> {
    const parsed = StartCheckoutInputSchema.safeParse(input);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new errors.BadRequestError({
        message: 'Bad Request.',
        context: `Invalid purchase checkout data: ${issue.path.join('.')} ${issue.message}`,
      });
    }
    const data = parsed.data;
    const buyer = data.buyer;

    // Names the key the tier was requested by, for error contexts.
    const tierRef = data.tierId !== null ? `id "${data.tierId}"` : `slug "${data.tierSlug}"`;
    let tier: PurchaseTier | null;
    try {
      tier =
        data.tierId !== null
          ? await this.deps.tiersService.api.read(data.tierId)
          : ((await this.deps.tiersService.api.browse({ filter: { slug: data.tierSlug } }))
              .data[0] ?? null);
    } catch (err) {
      logging.error(err);
      tier = null;
    }

    if (!tier) {
      throw new errors.BadRequestError({
        message: errorMessages.tierNotFound,
        context: `Tier with ${tierRef} not found`,
      });
    }

    if (tier.status === 'archived') {
      throw new errors.NoPermissionError({ message: errorMessages.tierArchived });
    }

    // Price authority stays on the server: the client never sends an amount.
    // Visibility is not checked, because course tiers are hidden.
    if (
      tier.type !== 'paid' ||
      !tier.currency ||
      !Number.isSafeInteger(tier.oneTimePrice) ||
      (tier.oneTimePrice ?? 0) <= 0
    ) {
      throw new errors.BadRequestError({
        message: errorMessages.tierNotPurchasable,
        context: `Tier with ${tierRef} has no one-time price`,
      });
    }

    const tierId = tier.id.toHexString();
    // Resolve the member from the same normalised email that the signup link,
    // the Stripe customer_email and the sign-in email use. The caller's lookup
    // used the raw string, which " victim@example.com" would slip past.
    let member: PurchaseMember | null = null;
    if (buyer.memberId) {
      member = await this.deps.memberRepository.get({ id: buyer.memberId });
    } else if (buyer.email) {
      member = await this.deps.memberRepository.get({ email: buyer.email });
    }

    if (buyer.isAuthenticated && !member) {
      throw new errors.UnauthorizedError({ message: errorMessages.authenticatedMemberMissing });
    }

    // An existing member must sign in before buying. The answer is the same
    // whatever the member owns, so it reveals only that the account exists
    // (as upstream's subscription checkout does), and no signup link is ever
    // minted for an existing account.
    if (member && !buyer.isAuthenticated) {
      try {
        await this.deps.magicLinks.sendSigninEmail(member.get('email'));
      } catch (err) {
        logging.warn(err);
      }
      throw new errors.NoPermissionError({
        message: errorMessages.signInRequired,
        code: 'PURCHASE_SIGNIN_REQUIRED',
      });
    }

    if (member && (await this.deps.purchaseRepository.hasActivePurchase(member.id, tierId))) {
      throw new errors.NoPermissionError({
        message: errorMessages.alreadyOwned,
        code: 'PURCHASE_ALREADY_OWNED',
      });
    }

    const metadata = this.buildClientMetadata(data.metadata ?? {});

    const successUrl = this.parseUrl(data.successUrl) ?? this.getWelcomeUrl(tier);
    successUrl.searchParams.set('stripe', 'purchase-success');
    successUrl.searchParams.set('purchase_tier', tier.slug);
    let successUrlString = successUrl.toString();

    if (!member && buyer.email) {
      // Pre-checkout magic link: the buyer comes back signed in to the account
      // the webhook creates.
      successUrlString = await this.deps.magicLinks.getSignupLink(
        buyer.email,
        {
          id: metadata.attribution_id ?? null,
          type: metadata.attribution_type ?? null,
          url: metadata.attribution_url ?? null,
        },
        successUrlString,
      );
    }

    const cancelUrl = data.cancelUrl ?? this.deps.urlUtils.getSiteUrl();
    // Only an authenticated buyer reaches this point with a member.
    const authenticatedMember = member;
    const customer = authenticatedMember
      ? await this.deps.checkoutAdapter.getCustomerForMember(authenticatedMember)
      : null;
    const priceId = await this.deps.checkoutAdapter.getOneTimePriceId(tier);

    metadata.ghost_purchase_tier_id = tierId;
    if (authenticatedMember) {
      metadata.ghost_purchase_member_uuid = authenticatedMember.get('uuid');
    }

    const session = await this.deps.checkoutAdapter.createSession({
      priceId,
      metadata,
      successUrl: successUrlString,
      cancelUrl,
      customer,
      customerEmail: customer ? null : buyer.email,
    });

    return { url: session.url };
  }

  async fulfil(input: FulfilPurchaseInput): Promise<FulfilResult> {
    const parsed = FulfilInputSchema.safeParse(input);
    if (!parsed.success) {
      // A programming error in the webhook parsing. Any non-2xx makes Stripe retry.
      const issue = parsed.error.issues[0];
      throw new errors.ValidationError({
        message: 'Invalid purchase data.',
        property: issue.path.join('.'),
        context: issue.message,
      });
    }
    const data = parsed.data;

    const existing = await this.deps.purchaseRepository.getByCheckoutSessionId(
      data.stripeCheckoutSessionId,
    );
    if (existing) {
      await this.reconcileRefundedDuplicate(existing, data);
      return { outcome: 'duplicate' };
    }

    // Tiers are never deleted, so a tier that doesn't exist won't appear on a
    // retry. A read error on a well-formed id propagates so Stripe retries.
    const tier = OBJECT_ID_PATTERN.test(data.tierId)
      ? await this.deps.tiersService.api.read(data.tierId)
      : null;
    if (!tier) {
      logging.error(
        {
          event: { name: 'purchase.fulfil_tier_missing' },
          tierId: data.tierId,
          stripeCheckoutSessionId: data.stripeCheckoutSessionId,
          stripePaymentIntentId: data.stripePaymentIntentId,
        },
        'Paid purchase checkout has no matching tier',
      );
      return { outcome: 'ignored', reason: 'tier_not_found' };
    }
    const tierId = tier.id.toHexString();

    if (!data.stripePaymentIntentId) {
      logging.error(
        {
          event: { name: 'purchase.fulfil_payment_intent_missing' },
          stripeCheckoutSessionId: data.stripeCheckoutSessionId,
        },
        'Purchase checkout has no payment intent; a refund cannot be matched to it',
      );
    }

    if (data.alreadyRefunded) {
      return this.recordRefundedPurchase(data, tierId);
    }

    let fulfilled: FulfilledPurchase | null;
    try {
      fulfilled = await this.fulfilInTransaction(data, tierId);
    } catch (err) {
      if (!(err instanceof MemberCreationRaceError)) {
        throw err;
      }
      logging.warn(
        {
          event: { name: 'purchase.fulfil_member_race' },
          stripeCheckoutSessionId: data.stripeCheckoutSessionId,
        },
        'Purchaser email was registered concurrently, retrying purchase fulfilment',
      );
      fulfilled = await this.fulfilInTransaction(data, tierId);
    }

    if (!fulfilled) {
      return { outcome: 'duplicate' };
    }

    if (fulfilled.possibleDuplicate) {
      logging.warn(
        {
          event: { name: 'purchase.possible_duplicate' },
          memberId: fulfilled.member.id,
          tierId,
          purchaseId: fulfilled.purchaseId,
        },
        'Member already had an active purchase for this tier; the payment was recorded',
      );
    }

    await this.sendPurchaseNotifications(fulfilled, tier, data);

    return {
      outcome: 'fulfilled',
      purchaseId: fulfilled.purchaseId,
      memberId: fulfilled.member.id,
      newMember: fulfilled.newMember,
    };
  }

  /** true when the payment intent belongs to a purchase (handled or already refunded), false otherwise */
  async refund(input: RefundPurchaseInput): Promise<boolean> {
    const parsed = RefundInputSchema.safeParse(input);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new errors.ValidationError({
        message: 'Invalid purchase refund data.',
        property: issue.path.join('.'),
        context: issue.message,
      });
    }
    const { paymentIntentId, fullyRefunded } = parsed.data;

    const purchase = await this.deps.purchaseRepository.getByPaymentIntentId(paymentIntentId);
    if (!purchase) {
      return false;
    }

    if (!fullyRefunded) {
      logging.info(
        `Partial refund on payment intent ${paymentIntentId} ignored; purchase ${purchase.id} keeps its access`,
      );
      return true;
    }

    if (purchase.status === 'refunded') {
      return true;
    }

    await this.deps.purchaseRepository.transaction(async (transacting) => {
      const locked = await this.deps.purchaseRepository.getByPaymentIntentId(paymentIntentId, {
        transacting,
        forUpdate: true,
      });
      if (!locked || locked.status === 'refunded') {
        return;
      }

      // Mark first: the purchase then no longer counts as a purchase-sourced
      // link when the revoke decides what to keep.
      await this.deps.purchaseRepository.markRefunded(locked.id, new Date(), { transacting });

      if (locked.memberId) {
        await this.deps.memberRepository.revokePurchasedProduct(
          { memberId: locked.memberId, productId: locked.productId },
          { transacting },
        );
      }
    });

    return true;
  }

  // Lock order: grantPurchasedProduct is the first statement to lock the
  // member row (forUpdate), before anything inserts a row referencing it.
  // A duplicate-key error on the insert rolls back the grant and any member
  // created here.
  private async fulfilInTransaction(
    data: ParsedFulfilInput,
    tierId: string,
  ): Promise<FulfilledPurchase | null> {
    try {
      return await this.deps.purchaseRepository.transaction(async (transacting) => {
        const { member, newMember, trusted } = await this.findOrCreateMember(data, transacting);

        await this.deps.memberRepository.grantPurchasedProduct(
          { memberId: member.id, productId: tierId, expiresAt: null },
          { transacting },
        );

        // A guest's Stripe customer is never attached to an existing member
        // who did not authenticate.
        if (trusted && data.stripeCustomerId) {
          await this.deps.memberRepository.upsertCustomer(
            {
              customer_id: data.stripeCustomerId,
              member_id: member.id,
              name: data.name,
              email: data.email,
            },
            { transacting },
          );
        }

        const possibleDuplicate = await this.deps.purchaseRepository.hasActivePurchase(
          member.id,
          tierId,
          { transacting },
        );

        const purchase = await this.deps.purchaseRepository.create(
          this.toNewPurchase(data, tierId, member.id),
          { transacting },
        );

        return { purchaseId: purchase.id, member, newMember, possibleDuplicate };
      });
    } catch (err) {
      if (err instanceof DuplicatePurchaseError) {
        return this.confirmDuplicate(data, err);
      }
      throw err;
    }
  }

  // A refund arrived before the purchase was recorded: keep the payment on
  // record, but grant nothing and send nothing. No member is created for it.
  private async recordRefundedPurchase(
    data: ParsedFulfilInput,
    tierId: string,
  ): Promise<FulfilResult> {
    const member = (await this.lookupMember(data))?.member ?? null;

    let purchaseId: string;
    try {
      const purchase = await this.deps.purchaseRepository.create({
        ...this.toNewPurchase(data, tierId, member?.id ?? null),
        status: 'refunded',
        refundedAt: new Date(),
      });
      purchaseId = purchase.id;
    } catch (err) {
      if (err instanceof DuplicatePurchaseError) {
        await this.confirmDuplicate(data, err);
        const recorded = await this.deps.purchaseRepository.getByCheckoutSessionId(
          data.stripeCheckoutSessionId,
        );
        if (recorded) {
          await this.reconcileRefundedDuplicate(recorded, data);
        }
        return { outcome: 'duplicate' };
      }
      throw err;
    }

    logging.warn(
      {
        event: { name: 'purchase.fulfil_already_refunded' },
        purchaseId,
        stripeCheckoutSessionId: data.stripeCheckoutSessionId,
        stripePaymentIntentId: data.stripePaymentIntentId,
      },
      'Purchase was refunded before it was fulfilled; recorded as refunded without granting access',
    );

    return { outcome: 'refunded', purchaseId };
  }

  // A redelivered session can carry proof (alreadyRefunded) that a payment
  // recorded as paid was fully refunded, when that refund's own webhook found no
  // row yet and was dropped. Revoke it now, using the recorded payment intent.
  private async reconcileRefundedDuplicate(
    existing: PurchaseData,
    data: ParsedFulfilInput,
  ): Promise<void> {
    if (!data.alreadyRefunded || existing.status !== 'paid' || !existing.stripePaymentIntentId) {
      return;
    }

    logging.warn(
      {
        event: { name: 'purchase.duplicate_refund_reconciled' },
        purchaseId: existing.id,
        stripeCheckoutSessionId: data.stripeCheckoutSessionId,
        stripePaymentIntentId: existing.stripePaymentIntentId,
      },
      'Redelivered purchase checkout shows a full refund; revoking the recorded purchase',
    );
    await this.refund({ paymentIntentId: existing.stripePaymentIntentId, fullyRefunded: true });
  }

  // A unique violation means "duplicate" only when this checkout session is
  // really recorded. Otherwise (for example a payment intent recorded under a
  // different session) it is a fault, and rethrowing makes Stripe retry.
  private async confirmDuplicate(
    data: ParsedFulfilInput,
    err: DuplicatePurchaseError,
  ): Promise<null> {
    const existing = await this.deps.purchaseRepository.getByCheckoutSessionId(
      data.stripeCheckoutSessionId,
    );
    if (existing) {
      return null;
    }
    throw err;
  }

  private async lookupMember(
    data: ParsedFulfilInput,
    transacting?: Knex.Transaction,
  ): Promise<{ member: PurchaseMember; trusted: boolean } | null> {
    const options = transacting ? { transacting } : {};

    if (data.memberUuid) {
      const member = await this.deps.memberRepository.get({ uuid: data.memberUuid }, options);
      if (member) {
        return { member, trusted: true };
      }
      // Deleted after checkout: fall back to the email path, untrusted.
      logging.warn(
        {
          event: { name: 'purchase.fulfil_member_uuid_missing' },
          stripeCheckoutSessionId: data.stripeCheckoutSessionId,
        },
        'Purchasing member no longer exists, falling back to the checkout email',
      );
    }

    if (data.email) {
      const member = await this.deps.memberRepository.get({ email: data.email }, options);
      if (member) {
        return { member, trusted: false };
      }
    }

    return null;
  }

  private async findOrCreateMember(
    data: ParsedFulfilInput,
    transacting: Knex.Transaction,
  ): Promise<ResolvedMember> {
    const existing = await this.lookupMember(data, transacting);
    if (existing) {
      return { ...existing, newMember: false };
    }

    if (!data.email) {
      // Payment-mode Checkout always collects an email, so this is a fault.
      // Throwing makes Stripe retry and shows the failure in its dashboard.
      throw new errors.InternalServerError({
        message: 'Cannot fulfil a purchase without a member or an email address',
        context: `Checkout session ${data.stripeCheckoutSessionId}`,
      });
    }

    try {
      // A normal free signup: no stripeCustomer (create() would walk its
      // subscriptions), default newsletters, MemberCreatedEvent with attribution.
      const member = await this.deps.memberRepository.create(
        {
          email: data.email,
          name: fit(data.name, NAME_MAX_LENGTH),
          attribution: data.attribution,
        },
        { transacting },
      );
      return { member, newMember: true, trusted: true };
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new MemberCreationRaceError({ cause: err });
      }
      throw err;
    }
  }

  private toNewPurchase(
    data: ParsedFulfilInput,
    tierId: string,
    memberId: string | null,
  ): NewPurchaseData {
    const attribution = data.attribution;
    const attributionType = PurchaseAttributionTypeSchema.safeParse(attribution.type);

    return {
      memberId,
      productId: tierId,
      stripeCheckoutSessionId: data.stripeCheckoutSessionId,
      stripePaymentIntentId: data.stripePaymentIntentId,
      stripeCustomerId: data.stripeCustomerId,
      amount: data.amount,
      currency: data.currency,
      status: 'paid',
      expiresAt: null,
      attributionId: attribution.id && attribution.id.length <= 24 ? attribution.id : null,
      attributionType: attributionType.success ? attributionType.data : null,
      attributionUrl: fit(attribution.url, 2000),
      referrerSource: fit(attribution.referrerSource, 191),
      referrerMedium: fit(attribution.referrerMedium, 191),
      referrerUrl: fit(attribution.referrerUrl, 2000),
      utmSource: fit(attribution.utmSource, 191),
      utmMedium: fit(attribution.utmMedium, 191),
      utmCampaign: fit(attribution.utmCampaign, 191),
      utmTerm: fit(attribution.utmTerm, 191),
      utmContent: fit(attribution.utmContent, 191),
    };
  }

  // Runs only after a real insert has committed, so each email goes out once.
  private async sendPurchaseNotifications(
    fulfilled: FulfilledPurchase,
    tier: PurchaseTier,
    data: ParsedFulfilInput,
  ): Promise<void> {
    const memberEmail = fulfilled.member.get('email');

    try {
      const accessUrl = await this.deps.magicLinks.getSigninLink(
        memberEmail,
        this.getWelcomeUrl(tier).toString(),
      );
      await this.deps.purchaseEmailService.sendAccessEmail({
        toEmail: memberEmail,
        tierName: tier.name,
        isNewMember: fulfilled.newMember,
        accessUrl,
        amount: data.amount,
        currency: data.currency,
      });
    } catch (err) {
      logging.error(
        {
          event: { name: 'purchase.access_email_failed' },
          err,
          purchaseId: fulfilled.purchaseId,
        },
        'Failed to send purchase access email',
      );
    }

    try {
      await this.deps.staffServiceEmails.notifyPurchaseReceived({
        name: fulfilled.member.get('name') ?? data.name,
        email: memberEmail,
        memberId: fulfilled.member.id,
        amount: data.amount,
        currency: data.currency,
        tierName: tier.name,
        possibleDuplicate: fulfilled.possibleDuplicate,
      });
    } catch (err) {
      logging.error(
        {
          event: { name: 'purchase.staff_email_failed' },
          err,
          purchaseId: fulfilled.purchaseId,
        },
        'Failed to notify staff of purchase',
      );
    }
  }

  // Stripe metadata values must be strings. Server-only keys are dropped here
  // and set by startCheckout itself.
  private buildClientMetadata(input: Record<string, unknown>): Record<string, string> {
    const metadata: Record<string, string> = {};

    for (const [key, value] of Object.entries(input)) {
      if (typeof value === 'string' && !key.startsWith(RESERVED_METADATA_PREFIX)) {
        metadata[key] = value;
      }
    }

    return metadata;
  }

  private parseUrl(value: string | null): URL | null {
    if (!value) {
      return null;
    }

    try {
      return new URL(value);
    } catch {
      throw new errors.BadRequestError({
        message: 'Bad Request.',
        context: `Invalid purchase return URL: ${value}`,
      });
    }
  }

  // The tier welcome page (where a course starts), else the site URL.
  private getWelcomeUrl(tier: PurchaseTier): URL {
    const siteUrl = this.deps.urlUtils.getSiteUrl();

    if (tier.welcomePageURL) {
      try {
        return new URL(tier.welcomePageURL, siteUrl);
      } catch (err) {
        logging.warn(`Invalid welcome page URL "${tier.welcomePageURL}", using the site URL`, err);
      }
    }

    return new URL(siteUrl);
  }
}
