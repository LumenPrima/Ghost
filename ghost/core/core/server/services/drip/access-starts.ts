// fork(salvare): drip. Per-tier access starts from the member object. See README.md.
import { fromDatabaseDate } from '../../lib/db-types/date';

/** ISO 8601 UTC strings. `member` is signup (`member.created_at`); `products[tierId]` is the access start for each held tier. */
export interface AccessStarts {
  member: string | null;
  products: Record<string, string>;
}

// Stripe statuses that keep a subscription's tier (member-repository.js uses the same set).
const ACTIVE_SUBSCRIPTION_STATUSES = new Set(['active', 'trialing', 'unpaid', 'past_due']);

type DateLike = Date | string | number | { toDate(): Date } | null | undefined;

/**
 * Accepts a Date, SQL or ISO string, epoch number, or a moment (anything with
 * `toDate()`). Returns null for anything missing or unparseable.
 */
export function toDate(value: unknown): Date | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  try {
    let date: Date;
    if (value instanceof Date) {
      date = value;
    } else if (typeof value === 'string' || typeof value === 'number') {
      date = fromDatabaseDate(value);
    } else if (typeof (value as { toDate?: unknown }).toDate === 'function') {
      date = (value as { toDate(): Date }).toDate();
    } else {
      return null;
    }

    return date instanceof Date && !Number.isNaN(date.getTime()) ? date : null;
  } catch {
    return null;
  }
}

function earliest(dates: Array<Date | null>): Date | null {
  let min: Date | null = null;
  for (const date of dates) {
    if (date && (!min || date.getTime() < min.getTime())) {
      min = date;
    }
  }
  return min;
}

function latest(dates: Array<Date | null>): Date | null {
  let max: Date | null = null;
  for (const date of dates) {
    if (date && (!max || date.getTime() > max.getTime())) {
      max = date;
    }
  }
  return max;
}

interface ProductLike {
  id?: unknown;
}

interface ProductEventLike {
  product_id?: unknown;
  action?: unknown;
  created_at?: DateLike;
}

interface SubscriptionLike {
  id?: unknown;
  status?: unknown;
  start_date?: DateLike;
  tier?: { id?: unknown } | null;
  price?: { product?: { product_id?: unknown } | null } | null;
}

/** True when `value` looks like a precomputed AccessStarts (the trimmed theme-helper context carries one). */
export function isAccessStarts(value: unknown): value is AccessStarts {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const starts = value as Partial<AccessStarts>;
  return (
    (starts.member === null || typeof starts.member === 'string') &&
    !!starts.products &&
    typeof starts.products === 'object' &&
    !Array.isArray(starts.products)
  );
}

/**
 * Pure. Works from the session/bread member, which carries `products`,
 * `productEvents` and `subscriptions`.
 *
 * Per held tier the candidates are the latest `added` product event for that
 * tier (comp, gift, subscription or purchase grant: the start of the current
 * holding) and the `start_date` of an active, real Stripe subscription on that
 * tier. Synthetic Complimentary/Gift subscriptions (`id: ''`) are skipped:
 * their `start_date` falls back to "now" when no event exists. The start is the
 * earliest candidate, else signup.
 *
 * - A member that already carries `access_starts` (the trimmed theme-helper
 *   context) is returned as is.
 * - A member with neither `access_starts` nor a `productEvents` array gives
 *   null: the caller can't tell when access started.
 */
export function computeAccessStarts(member: unknown): AccessStarts | null {
  if (!member || typeof member !== 'object') {
    return null;
  }

  const m = member as {
    access_starts?: unknown;
    created_at?: DateLike;
    products?: ProductLike[] | null;
    productEvents?: ProductEventLike[] | null;
    subscriptions?: SubscriptionLike[] | null;
  };

  if (m.access_starts !== undefined && m.access_starts !== null) {
    return isAccessStarts(m.access_starts) ? m.access_starts : null;
  }

  if (!Array.isArray(m.productEvents)) {
    return null;
  }

  const signup = toDate(m.created_at);
  const events = m.productEvents;
  const subscriptions = Array.isArray(m.subscriptions) ? m.subscriptions : [];
  const products: Record<string, string> = {};

  for (const product of Array.isArray(m.products) ? m.products : []) {
    if (!product || typeof product.id !== 'string' || !product.id) {
      continue;
    }
    const productId = product.id;

    const lastAdded = latest(
      events
        .filter((event) => event?.product_id === productId && event.action === 'added')
        .map((event) => toDate(event.created_at)),
    );

    const subscriptionStart = earliest(
      subscriptions
        .filter((sub) => {
          if (!sub || typeof sub.id !== 'string' || sub.id === '') {
            return false;
          }
          if (typeof sub.status !== 'string' || !ACTIVE_SUBSCRIPTION_STATUSES.has(sub.status)) {
            return false;
          }
          return (sub.tier?.id ?? sub.price?.product?.product_id) === productId;
        })
        .map((sub) => toDate(sub.start_date)),
    );

    const start = earliest([lastAdded, subscriptionStart]) ?? signup;
    if (start) {
      products[productId] = start.toISOString();
    }
  }

  return {
    member: signup ? signup.toISOString() : null,
    products,
  };
}
