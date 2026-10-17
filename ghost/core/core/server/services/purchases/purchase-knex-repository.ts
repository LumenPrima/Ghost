import errors from '@tryghost/errors';
import ObjectId from 'bson-objectid';
import type { Knex } from 'knex';
import { toDatabaseDate } from '../../lib/db-types/date';
import { decodePurchaseRow, encodeNewPurchase } from './purchase-codec';
import { getPurchaseSourcedProducts } from './purchase-links';
import type { NewPurchaseData, PurchaseData } from './purchase-schema';

const TABLE = 'members_purchases';

/** The tier columns the Admin and members API purchase views show. */
export interface PurchaseTierRow {
  id: string;
  name: string;
  slug: string;
  welcome_page_url: string | null;
}

export interface PurchaseWithTier {
  purchase: PurchaseData;
  tier: PurchaseTierRow;
}

export interface RepositoryTransactionOptions {
  transacting?: Knex.Transaction;
  forUpdate?: boolean;
}

export interface PurchaseRepository {
  getByCheckoutSessionId(
    sessionId: string,
    options?: RepositoryTransactionOptions,
  ): Promise<PurchaseData | null>;
  getByPaymentIntentId(
    paymentIntentId: string,
    options?: RepositoryTransactionOptions,
  ): Promise<PurchaseData | null>;
  /** paid and (expires_at null or in the future) */
  hasActivePurchase(
    memberId: string,
    productId: string,
    options?: RepositoryTransactionOptions,
  ): Promise<boolean>;
  getById(id: string, options?: RepositoryTransactionOptions): Promise<PurchaseData | null>;
  /** Every row of the member, newest first (created_at, then id). */
  browseByMember(memberId: string): Promise<PurchaseWithTier[]>;
  /** The member's paid, unexpired rows, newest first. */
  browseActiveByMember(memberId: string): Promise<PurchaseWithTier[]>;
  /**
   * created_at defaults to now. Throws DuplicatePurchaseError when the checkout
   * session or payment intent is already recorded.
   */
  create(data: NewPurchaseData, options?: RepositoryTransactionOptions): Promise<PurchaseData>;
  markRefunded(id: string, refundedAt: Date, options: RepositoryTransactionOptions): Promise<void>;
  markRevoked(id: string, revokedAt: Date, options: RepositoryTransactionOptions): Promise<void>;
  transaction<T>(callback: (transacting: Knex.Transaction) => Promise<T>): Promise<T>;
}

export class DuplicatePurchaseError extends Error {
  constructor(options: { cause?: unknown } = {}) {
    super('Purchase is already recorded', { cause: options.cause });
    this.name = 'DuplicatePurchaseError';
  }
}

type DatabaseError = {
  code?: unknown;
  message?: unknown;
};

/**
 * True only for a UNIQUE violation, never for a foreign key or other constraint.
 * MySQL raises ER_DUP_ENTRY. better-sqlite3 raises SQLITE_CONSTRAINT_UNIQUE, but
 * Ghost's driver patch (data/db/better-sqlite3-patches.js) reshapes it to the
 * primary SQLITE_CONSTRAINT code, so the message tells the two apart there.
 */
export function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false;
  }

  const { code, message } = err as DatabaseError;

  if (code === 'ER_DUP_ENTRY' || code === 'SQLITE_CONSTRAINT_UNIQUE') {
    return true;
  }

  return (
    typeof code === 'string' &&
    code.startsWith('SQLITE_CONSTRAINT') &&
    typeof message === 'string' &&
    /UNIQUE constraint failed/i.test(message)
  );
}

// Knex binds a raw Date as epoch milliseconds on SQLite, so every date written
// here goes through toDatabaseDate (see lib/db-types/date.ts).
function toDatabaseValues(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      value instanceof Date ? toDatabaseDate(value) : value,
    ]),
  );
}

export class PurchaseKnexRepository implements PurchaseRepository {
  private readonly knex: Knex;

  constructor({ knex }: { knex: Knex }) {
    this.knex = knex;
  }

  async getByCheckoutSessionId(
    sessionId: string,
    options: RepositoryTransactionOptions = {},
  ): Promise<PurchaseData | null> {
    return this.findOne({ stripe_checkout_session_id: sessionId }, options);
  }

  async getByPaymentIntentId(
    paymentIntentId: string,
    options: RepositoryTransactionOptions = {},
  ): Promise<PurchaseData | null> {
    return this.findOne({ stripe_payment_intent_id: paymentIntentId }, options);
  }

  async getById(
    id: string,
    options: RepositoryTransactionOptions = {},
  ): Promise<PurchaseData | null> {
    return this.findOne({ id }, options);
  }

  async browseByMember(memberId: string): Promise<PurchaseWithTier[]> {
    const rows: unknown[] = await this.knex(TABLE)
      .where({ member_id: memberId })
      .orderBy([
        { column: 'created_at', order: 'desc' },
        { column: 'id', order: 'desc' },
      ]);

    return this.withTiers(rows.map((row) => decodePurchaseRow(row)));
  }

  async browseActiveByMember(memberId: string): Promise<PurchaseWithTier[]> {
    // Same definition as getPurchaseSourcedProducts; dates compared as text on SQLite.
    const now = toDatabaseDate(new Date());
    const rows: unknown[] = await this.knex(TABLE)
      .where({ member_id: memberId, status: 'paid' })
      .andWhere((qb) => {
        qb.whereNull('expires_at').orWhere('expires_at', '>', now);
      })
      .orderBy([
        { column: 'created_at', order: 'desc' },
        { column: 'id', order: 'desc' },
      ]);

    return this.withTiers(rows.map((row) => decodePurchaseRow(row)));
  }

  async hasActivePurchase(
    memberId: string,
    productId: string,
    options: RepositoryTransactionOptions = {},
  ): Promise<boolean> {
    const products = await getPurchaseSourcedProducts(this.knex, memberId, {
      transacting: options.transacting,
    });

    return products.some((product) => product.id === productId);
  }

  async create(
    data: NewPurchaseData,
    options: RepositoryTransactionOptions = {},
  ): Promise<PurchaseData> {
    const id = ObjectId().toHexString();
    const now = new Date();
    const encoded = encodeNewPurchase(data);
    const row = {
      id,
      ...encoded,
      created_at: encoded.created_at ?? now,
      updated_at: now,
    };

    try {
      await this.query(options).insert(toDatabaseValues(row));
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new DuplicatePurchaseError({ cause: err });
      }
      throw err;
    }

    const created = await this.findOne({ id }, { transacting: options.transacting });
    if (!created) {
      throw new errors.InternalServerError({
        message: `Created purchase ${id} could not be read back`,
      });
    }

    return created;
  }

  async markRefunded(
    id: string,
    refundedAt: Date,
    options: RepositoryTransactionOptions,
  ): Promise<void> {
    await this.query(options)
      .where({ id })
      .update({
        status: 'refunded',
        refunded_at: toDatabaseDate(refundedAt),
        updated_at: toDatabaseDate(new Date()),
      });
  }

  async markRevoked(
    id: string,
    revokedAt: Date,
    options: RepositoryTransactionOptions,
  ): Promise<void> {
    await this.query(options)
      .where({ id })
      .update({
        status: 'revoked',
        revoked_at: toDatabaseDate(revokedAt),
        updated_at: toDatabaseDate(new Date()),
      });
  }

  async transaction<T>(callback: (transacting: Knex.Transaction) => Promise<T>): Promise<T> {
    return await this.knex.transaction(callback);
  }

  private query(options: RepositoryTransactionOptions): Knex.QueryBuilder {
    const query = this.knex(TABLE);

    if (options.transacting) {
      query.transacting(options.transacting);
    }

    return query;
  }

  // A second query rather than a join, so the purchase columns stay unambiguous.
  private async withTiers(purchases: PurchaseData[]): Promise<PurchaseWithTier[]> {
    const productIds = [...new Set(purchases.map((purchase) => purchase.productId))];
    if (productIds.length === 0) {
      return [];
    }

    const tiers: PurchaseTierRow[] = await this.knex('products')
      .select('id', 'name', 'slug', 'welcome_page_url')
      .whereIn('id', productIds);
    const byId = new Map(tiers.map((tier) => [tier.id, tier]));

    return purchases.map((purchase) => ({
      purchase,
      // products.id is a foreign key and tiers are never deleted; the fallback
      // only keeps a corrupt row from failing the whole list.
      tier: byId.get(purchase.productId) ?? {
        id: purchase.productId,
        name: '',
        slug: '',
        welcome_page_url: null,
      },
    }));
  }

  private async findOne(
    where: Record<string, string>,
    options: RepositoryTransactionOptions,
  ): Promise<PurchaseData | null> {
    const query = this.query(options).where(where).first();

    if (options.transacting && options.forUpdate) {
      query.forUpdate();
    }

    const row: unknown = await query;

    return row ? decodePurchaseRow(row) : null;
  }
}
