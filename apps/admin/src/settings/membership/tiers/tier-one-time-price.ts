// fork(salvare): pricing-mode rules for tiers sold as a one-time purchase (a course).
import { formatNumber } from '@tryghost/shade/utils';
import { currencyToDecimal, getSymbol, validateCurrencyAmount } from '@tryghost/admin-x-framework';
import { type Tier, isPurchaseOnlyTier } from '@tryghost/admin-x-framework/api/tiers';

export type PricingMode = 'subscription' | 'one_time';

/** Core's upper bound for `one_time_price` (`services/tiers/tier.js`). */
const MAX_ONE_TIME_PRICE = 4294967295;

/** Shown dimmed in the input and the preview while no price is entered. */
export const ONE_TIME_PRICE_PLACEHOLDER = 9900;

export function initialPricingMode(tier?: Pick<Tier, 'one_time_price'>): PricingMode {
  return tier && isPurchaseOnlyTier(tier) ? 'one_time' : 'subscription';
}

/** An empty field is "no price", never 0. */
export function validateOneTimePrice(
  cents: number | null | undefined,
  currency: string | undefined,
): string | undefined {
  if (typeof cents === 'number' && cents > MAX_ONE_TIME_PRICE) {
    return 'Amount is too large.';
  }

  return validateCurrencyAmount(cents ?? 0, currency, { allowZero: false });
}

/** Parses the one-time price field into cents. An empty field gives `null`. */
export function parseOneTimePriceInput(input: string): number | null {
  const match = input.match(/\d+\.?\d{0,2}/)?.[0];

  if (!match) {
    return null;
  }

  return Math.round(parseFloat(match) * 100);
}

export function formatOneTimePriceInput(cents: number | null | undefined): string {
  return typeof cents === 'number' ? (cents / 100).toString() : '';
}

/**
 * The pricing fields to merge over the tier save payload.
 *
 * - One-time mode sets the price and hides the tier from Portal's subscription signup.
 * - Leaving one-time mode clears the price with an explicit `null`. An `undefined`
 *   value is dropped by `JSON.stringify`, and Core reads an absent field as "keep".
 * - A tier that never had a price gets `undefined`, which drops a price typed and
 *   then abandoned by switching back, so nothing is sent.
 */
export function buildPricingPayload(
  mode: PricingMode,
  oneTimePrice: number | null | undefined,
  tier?: Pick<Tier, 'one_time_price'>,
): Pick<Partial<Tier>, 'one_time_price' | 'visibility'> {
  if (mode === 'one_time') {
    return { one_time_price: oneTimePrice ?? null, visibility: 'none' };
  }

  if (tier && isPurchaseOnlyTier(tier)) {
    return { one_time_price: null };
  }

  return { one_time_price: undefined };
}

function formatAmount(cents: number, currency: string) {
  return `${getSymbol(currency)}${formatNumber(currencyToDecimal(cents), {
    maximumFractionDigits: 2,
  })}`;
}

export interface PricingModeChangeWarning {
  title: string;
  prompt: string;
  okLabel: string;
}

const DISCARD_CHECKOUT_EDITS = 'Your unsaved checkout field changes will be discarded.';

/**
 * Copy for the confirmation shown when an existing tier changes pricing mode.
 * One-time mode hides the checkout collection section, so a switch to it also
 * warns when that section has unsaved edits.
 */
export function pricingModeChangeWarning(
  to: PricingMode,
  tier: Pick<Partial<Tier>, 'currency' | 'monthly_price' | 'yearly_price'>,
  discardsCheckoutEdits = false,
): PricingModeChangeWarning {
  if (to === 'one_time') {
    const prompt =
      'Members who already subscribe to this tier keep their subscription, but nobody can start or switch to a subscription on it.';
    return {
      title: 'Sell as a one-time purchase?',
      prompt: discardsCheckoutEdits ? `${prompt} ${DISCARD_CHECKOUT_EDITS}` : prompt,
      okLabel: 'Sell as one-time purchase',
    };
  }

  const currency = tier.currency || 'USD';
  const monthly = formatAmount(tier.monthly_price || 500, currency);
  const yearly = formatAmount(tier.yearly_price || 5000, currency);

  return {
    title: 'Sell as a subscription?',
    prompt: `This tier will be sold as a subscription at ${monthly} a month or ${yearly} a year.`,
    okLabel: 'Sell as subscription',
  };
}

/**
 * Copy for the confirmation shown when a switch to one-time mode, with no other
 * warning (a new tier, or one already saved as one-time), would discard unsaved
 * checkout collection edits.
 */
export function checkoutEditsDiscardWarning(): PricingModeChangeWarning {
  return {
    title: 'Discard checkout field changes?',
    prompt: DISCARD_CHECKOUT_EDITS,
    okLabel: 'Sell as one-time purchase',
  };
}
