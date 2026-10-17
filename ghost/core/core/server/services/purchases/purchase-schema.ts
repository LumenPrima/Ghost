import type { OptionalKeysOf, SetOptional } from 'type-fest';
import { z } from 'zod';
import { DbDate } from '../../lib/db-types/date';
import type { CamelKeys } from '../../lib/case-keys';

// 'revoked': staff took the access away (Admin API). A Stripe refund can still mark it refunded later.
export const PurchaseStatusSchema = z.enum(['paid', 'refunded', 'revoked']);
export type PurchaseStatus = z.infer<typeof PurchaseStatusSchema>;

export const PurchaseAttributionTypeSchema = z.enum(['url', 'post', 'page', 'author', 'tag']);

// Attribution values from ghost-history (the member attribution tracking script),
// copied from the checkout session metadata.
const attributionColumns = {
  attribution_id: z.string().nullable().default(null),
  attribution_type: PurchaseAttributionTypeSchema.nullable().default(null),
  attribution_url: z.string().nullable().default(null),
  referrer_source: z.string().nullable().default(null),
  referrer_medium: z.string().nullable().default(null),
  referrer_url: z.string().nullable().default(null),
  utm_source: z.string().nullable().default(null),
  utm_medium: z.string().nullable().default(null),
  utm_campaign: z.string().nullable().default(null),
  utm_term: z.string().nullable().default(null),
  utm_content: z.string().nullable().default(null),
};

/**
 * The persisted members_purchases row. Rows are read with raw Knex, so they are
 * runtime data and are validated before they become trusted purchase values.
 */
export const DbPurchase = z.object({
  id: z.string(),
  member_id: z.string().nullable(),
  product_id: z.string(),
  stripe_checkout_session_id: z.string().nullable(),
  stripe_payment_intent_id: z.string().nullable(),
  stripe_customer_id: z.string().nullable(),
  amount: z.number().int().nonnegative(),
  currency: z.string(),
  status: PurchaseStatusSchema,
  expires_at: DbDate.nullable(),
  refunded_at: DbDate.nullable(),
  revoked_at: DbDate.nullable(),
  ...attributionColumns,
  created_at: DbDate,
  updated_at: DbDate.nullable(),
});

// The repository owns id and updated_at, and created_at unless the caller sets
// it (a staff grant backdated to the original order). Lifecycle columns default
// to a paid, lifetime purchase.
export const DbNewPurchase = DbPurchase.omit({
  id: true,
  created_at: true,
  updated_at: true,
}).extend({
  status: PurchaseStatusSchema.default('paid'),
  expires_at: DbDate.nullable().default(null),
  refunded_at: DbDate.nullable().default(null),
  revoked_at: DbDate.nullable().default(null),
  created_at: DbDate.optional(),
});

export type PurchaseRow = z.output<typeof DbPurchase>;
export type PurchaseData = CamelKeys<PurchaseRow>;
export type NewPurchaseRow = z.output<typeof DbNewPurchase>;
export type NewPurchaseData = SetOptional<
  CamelKeys<NewPurchaseRow>,
  OptionalKeysOf<CamelKeys<z.input<typeof DbNewPurchase>>>
>;
