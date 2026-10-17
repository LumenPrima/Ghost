import type { Knex } from 'knex';
import { fromDatabaseDate, toDatabaseDate } from '../../lib/db-types/date';
import type { GetPurchaseSourcedProductIdsForMembers } from './purchase-views';

// Keeps each IN list well under SQLite's bound-parameter limit.
const MEMBER_ID_CHUNK_SIZE = 500;

export interface PurchaseSourcedProduct {
  id: string;
  expiry_at: Date | null;
}

interface ActivePurchaseRow {
  product_id: string;
  expires_at: Date | string | number | null;
}

/**
 * Products the member holds through a paid, unexpired purchase. One entry per product; expiry null if any purchase is lifetime, else latest.
 *
 * This is the single definition of an "active purchase". The member repository
 * uses it to leave purchase-sourced members_products links alone, and the
 * purchase repository uses it for the already-owned check.
 */
export async function getPurchaseSourcedProducts(
  knex: Knex,
  memberId: string,
  options: { transacting?: Knex.Transaction } = {},
): Promise<PurchaseSourcedProduct[]> {
  if (!memberId) {
    return [];
  }

  // Compare in the database date format: SQLite compares datetimes as text.
  const now = toDatabaseDate(new Date());
  const query = knex('members_purchases')
    .select('product_id', 'expires_at')
    .where({ member_id: memberId, status: 'paid' })
    .andWhere((qb) => {
      qb.whereNull('expires_at').orWhere('expires_at', '>', now);
    });

  if (options.transacting) {
    query.transacting(options.transacting);
  }

  const rows: ActivePurchaseRow[] = await query;
  const byProduct = new Map<string, Date | null>();

  for (const row of rows) {
    const expiry = row.expires_at === null ? null : fromDatabaseDate(row.expires_at);

    if (!byProduct.has(row.product_id)) {
      byProduct.set(row.product_id, expiry);
      continue;
    }

    const previous = byProduct.get(row.product_id) ?? null;
    if (previous === null || expiry === null) {
      byProduct.set(row.product_id, null);
    } else if (expiry.getTime() > previous.getTime()) {
      byProduct.set(row.product_id, expiry);
    }
  }

  return [...byProduct].map(([id, expiry]) => ({ id, expiry_at: expiry }));
}

/**
 * Batched form of getPurchaseSourcedProducts, with the same definition of an
 * active purchase. Returns product ids only. Members with no active purchase are
 * absent from the map; an empty memberIds runs no query.
 */
export const getPurchaseSourcedProductIdsForMembers: GetPurchaseSourcedProductIdsForMembers =
  async (knex, memberIds, options = {}) => {
    const byMember = new Map<string, Set<string>>();
    const ids = [...new Set(memberIds.filter(Boolean))];
    if (ids.length === 0) {
      return byMember;
    }

    const now = toDatabaseDate(new Date());
    for (let start = 0; start < ids.length; start += MEMBER_ID_CHUNK_SIZE) {
      const query = knex('members_purchases')
        .distinct('member_id', 'product_id')
        .whereIn('member_id', ids.slice(start, start + MEMBER_ID_CHUNK_SIZE))
        .andWhere({ status: 'paid' })
        .andWhere((qb) => {
          qb.whereNull('expires_at').orWhere('expires_at', '>', now);
        });

      if (options.transacting) {
        query.transacting(options.transacting);
      }

      const rows: Array<{ member_id: string; product_id: string }> = await query;
      for (const row of rows) {
        const products = byMember.get(row.member_id) ?? new Set<string>();
        products.add(row.product_id);
        byMember.set(row.member_id, products);
      }
    }

    return byMember;
  };
