import nql from '@tryghost/nql';
import { chainTransformers, mapKeys, replaceFilters } from '@tryghost/mongo-utils';
import type { Knex } from 'knex';
import { fromDatabaseDate } from '../../lib/db-types/date';
import type {
  ParsedNqlFilter,
  PurchaseEventBrowseOptions,
  PurchaseEventMember,
  PurchaseEventPage,
  PurchaseEventType,
} from './purchase-views';

const TABLE = 'members_purchases';

// Each event type is one date column of members_purchases.
const DATE_COLUMNS: Record<PurchaseEventType, 'created_at' | 'refunded_at' | 'revoked_at'> = {
  purchase_event: 'created_at',
  purchase_refunded_event: 'refunded_at',
  purchase_revoked_event: 'revoked_at',
};

interface PurchaseEventDbRow {
  id: string;
  member_id: string;
  product_id: string;
  stripe_checkout_session_id: string | null;
  amount: number;
  currency: string;
  event_at: Date | string | number;
}

/**
 * Activity feed lists over members_purchases, read with Knex (no model). The
 * member activity feed (members-api event-repository.js) merges them with its
 * other per-type lists, so the filter and paging contract is the same as the
 * gift event lists: the parsed NQL filter may use `data.created_at` (mapped to
 * the type's date column), `data.member_id` and `id`.
 *
 * A row recorded already refunded (the payment was refunded before the webhook
 * fulfilled it, PurchaseService.recordRefundedPurchase) never granted access,
 * so it is left out of `purchase_event`. Its marker is `refunded_at` equal to
 * `created_at`: that path writes both from one Date, and a refund through
 * PurchaseService.refund always comes after the row exists. At the database's
 * second precision, a fulfilled purchase refunded within the same second also
 * matches; that access lasted under a second, so leaving it out is fine. Its
 * `purchase_refunded_event` is still listed, because the payment was real.
 */
export interface PurchaseEventRepositoryDeps {
  knex: Knex;
  // members has no avatar column: the Member model computes a gravatar URL from
  // the email (or null when gravatar is disabled). Same rule here.
  getAvatarImage?: (email: string) => string | null;
}

export class PurchaseEventRepository {
  private readonly knex: Knex;
  private readonly getAvatarImage: (email: string) => string | null;

  constructor({ knex, getAvatarImage = () => null }: PurchaseEventRepositoryDeps) {
    this.knex = knex;
    this.getAvatarImage = getAvatarImage;
  }

  async browse(
    type: PurchaseEventType,
    options: PurchaseEventBrowseOptions = {},
    filter?: ParsedNqlFilter,
  ): Promise<PurchaseEventPage> {
    const dateColumn = DATE_COLUMNS[type];
    const applyFilter = (qb: Knex.QueryBuilder): void => {
      qb.whereNotNull(`${TABLE}.member_id`).whereNotNull(`${TABLE}.${dateColumn}`);

      if (type === 'purchase_event') {
        qb.where((inner) => {
          inner
            .whereNot(`${TABLE}.status`, 'refunded')
            .orWhereNull(`${TABLE}.refunded_at`)
            .orWhereRaw('?? <> ??', [`${TABLE}.refunded_at`, `${TABLE}.created_at`]);
        });
      }

      if (filter) {
        // custom:true is replaced by the caller's parsed filter, whose keys are
        // then mapped to columns. Unmapped keys (`id`) pass through unchanged.
        nql('custom:true', {
          transformer: chainTransformers(
            (existing: ParsedNqlFilter) => replaceFilters(existing, { custom: filter }),
            ...mapKeys({
              'data.created_at': dateColumn,
              'data.member_id': 'member_id',
            }),
          ),
        }).querySQL(qb);
      }
    };

    const countQuery = this.knex(TABLE).count({ total: `${TABLE}.id` });
    applyFilter(countQuery);
    const [countRow] = (await countQuery) as Array<{ total: number | string }>;
    const total = Number(countRow?.total ?? 0);

    const query = this.knex(TABLE)
      .select(
        `${TABLE}.id`,
        `${TABLE}.member_id`,
        `${TABLE}.product_id`,
        `${TABLE}.stripe_checkout_session_id`,
        `${TABLE}.amount`,
        `${TABLE}.currency`,
        { event_at: `${TABLE}.${dateColumn}` },
      )
      .orderBy([
        { column: `${TABLE}.${dateColumn}`, order: 'desc' },
        { column: `${TABLE}.id`, order: 'desc' },
      ]);
    applyFilter(query);

    const limit = options.limit === 'all' ? null : Number(options.limit ?? 15);
    if (limit !== null && Number.isSafeInteger(limit) && limit > 0) {
      query.limit(limit);
      const page = Number(options.page ?? 1);
      if (Number.isSafeInteger(page) && page > 1) {
        query.offset((page - 1) * limit);
      }
    }

    const rows: PurchaseEventDbRow[] = await query;
    const [members, tierNames] = await Promise.all([
      this.getMembers(rows.map((row) => row.member_id)),
      this.getTierNames(rows.map((row) => row.product_id)),
    ]);

    return {
      data: rows.map((row) => ({
        type,
        data: {
          id: row.id,
          member: members.get(row.member_id) ?? null,
          member_id: row.member_id,
          tier_id: row.product_id,
          tier_name: tierNames.get(row.product_id) ?? null,
          amount: row.amount,
          currency: row.currency,
          source: row.stripe_checkout_session_id ? 'stripe' : 'manual',
          created_at: fromDatabaseDate(row.event_at),
        },
      })),
      meta: { pagination: { total } },
    };
  }

  private async getMembers(ids: string[]): Promise<Map<string, PurchaseEventMember>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) {
      return new Map();
    }

    const members: Array<Omit<PurchaseEventMember, 'avatar_image'>> = await this.knex('members')
      .select('id', 'uuid', 'name', 'email')
      .whereIn('id', unique);

    return new Map(
      members.map((member) => [
        member.id,
        {
          ...member,
          avatar_image: member.email ? this.getAvatarImage(member.email) : null,
        },
      ]),
    );
  }

  private async getTierNames(ids: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) {
      return new Map();
    }

    const tiers: Array<{ id: string; name: string }> = await this.knex('products')
      .select('id', 'name')
      .whereIn('id', unique);

    return new Map(tiers.map((tier) => [tier.id, tier.name]));
  }
}
