import errors from '@tryghost/errors';

/**
 * Stripe and Bookshelf adapter used only by the purchases module.
 *
 * The purchase service deals in tiers, member models and price ids. Stripe
 * objects and the stripe_prices model stay on this side of the seam.
 */

export interface PurchaseTier {
  // An ObjectID: PaymentsService.getProductForTier calls tier.id.toHexString().
  id: { toHexString(): string };
  slug: string;
  name: string;
  type: 'paid' | 'free';
  status: 'active' | 'archived';
  currency: string | null;
  oneTimePrice: number | null;
  welcomePageURL: string | null;
}

export interface PurchaseMemberModel {
  id: string;
  get(key: string): unknown;
}

export interface CreatePurchaseSessionInput {
  priceId: string;
  metadata: Record<string, string>;
  successUrl: string;
  cancelUrl: string;
  customer: { id: string } | null;
  customerEmail: string | null;
}

interface StripePrice {
  id: string;
  active: boolean;
  currency: string;
  unit_amount: number | null;
  nickname: string | null;
  recurring: unknown;
}

interface StripeApi {
  getPrice(id: string): Promise<StripePrice>;
  createPrice(options: {
    product: string;
    active: boolean;
    nickname: string;
    currency: string;
    amount: number;
    type: 'one-time';
  }): Promise<StripePrice>;
  createPurchaseCheckoutSession(options: CreatePurchaseSessionInput): Promise<{
    id: string;
    url: string | null;
  }>;
}

interface PaymentsService {
  getCustomerForMember(member: PurchaseMemberModel): Promise<{ id: string }>;
  getProductForTier(tier: PurchaseTier): Promise<{ id: string }>;
}

interface StripePriceRow {
  id: string;
  stripe_price_id: string;
}

interface StripePriceModel {
  where(filter: Record<string, unknown>): {
    query(): { select(...columns: string[]): Promise<StripePriceRow[]> };
  };
  edit(data: { active: boolean }, options: { id: string }): Promise<unknown>;
  add(data: {
    stripe_price_id: string;
    stripe_product_id: string;
    active: boolean;
    nickname: string | null;
    currency: string;
    amount: number;
    type: 'one_time';
    interval: null;
  }): Promise<unknown>;
}

export interface PurchaseCheckoutAdapterDeps {
  StripePriceModel: StripePriceModel;
  // Lazy: the Stripe API is reconfigured when keys change.
  getStripeApi: () => StripeApi;
  getPaymentsService: () => PaymentsService;
}

export class PurchaseCheckoutAdapter {
  private readonly deps: PurchaseCheckoutAdapterDeps;
  // Serialises price resolution per tier, so concurrent first checkouts don't
  // each create a Stripe price. In-process only.
  private readonly priceResolutions = new Map<string, Promise<string>>();

  constructor(deps: PurchaseCheckoutAdapterDeps) {
    this.deps = deps;
  }

  /** Only for authenticated buyers; reuses or creates their members_stripe_customers row. */
  async getCustomerForMember(member: PurchaseMemberModel): Promise<{ id: string }> {
    const customer = await this.deps.getPaymentsService().getCustomerForMember(member);

    return { id: customer.id };
  }

  /** Find an active one_time stripe_prices row for this tier/amount/currency (checked against Stripe), else create one. */
  async getOneTimePriceId(tier: PurchaseTier): Promise<string> {
    const key = tier.id.toHexString();
    const previous = this.priceResolutions.get(key);
    const resolution = (previous ?? Promise.resolve(''))
      .catch(() => '')
      .then(() => this.resolveOneTimePriceId(tier));

    this.priceResolutions.set(key, resolution);
    try {
      return await resolution;
    } finally {
      if (this.priceResolutions.get(key) === resolution) {
        this.priceResolutions.delete(key);
      }
    }
  }

  async createSession(input: CreatePurchaseSessionInput): Promise<{ id: string; url: string }> {
    const session = await this.deps.getStripeApi().createPurchaseCheckoutSession(input);

    if (!session.url) {
      throw new errors.InternalServerError({
        message: `Stripe checkout session ${session.id} has no URL`,
      });
    }

    return { id: session.id, url: session.url };
  }

  private async resolveOneTimePriceId(tier: PurchaseTier): Promise<string> {
    const amount = tier.oneTimePrice;
    if (!tier.currency || !Number.isSafeInteger(amount) || amount === null || amount <= 0) {
      throw new errors.IncorrectUsageError({
        message: `Tier ${tier.id.toHexString()} has no one-time price`,
      });
    }

    const currency = tier.currency.toLowerCase();
    const stripeApi = this.deps.getStripeApi();
    const product = await this.deps.getPaymentsService().getProductForTier(tier);
    const rows = await this.deps.StripePriceModel.where({
      stripe_product_id: product.id,
      currency,
      amount,
      active: true,
      type: 'one_time',
    })
      .query()
      .select('id', 'stripe_price_id');

    for (const row of rows) {
      // A fetch error is rethrown rather than treated as a mismatch, so a
      // Stripe outage never deactivates a valid price.
      const price = await stripeApi.getPrice(row.stripe_price_id);
      if (
        price.active &&
        !price.recurring &&
        price.currency.toLowerCase() === currency &&
        price.unit_amount === amount
      ) {
        return price.id;
      }

      // Stop future checkouts from fetching a price Stripe no longer matches.
      await this.deps.StripePriceModel.edit({ active: false }, { id: row.id });
    }

    const price = await stripeApi.createPrice({
      product: product.id,
      currency,
      amount,
      nickname: 'One-time',
      type: 'one-time',
      active: true,
    });

    await this.deps.StripePriceModel.add({
      stripe_price_id: price.id,
      stripe_product_id: product.id,
      active: price.active,
      nickname: price.nickname,
      currency: price.currency,
      amount: price.unit_amount ?? amount,
      type: 'one_time',
      interval: null,
    });

    return price.id;
  }
}
