// fork(salvare)
import {
  buildPricingPayload,
  formatOneTimePriceInput,
  initialPricingMode,
  parseOneTimePriceInput,
  checkoutEditsDiscardWarning,
  pricingModeChangeWarning,
  validateOneTimePrice,
} from './tier-one-time-price';

describe('tier one-time price', () => {
  it('starts in one-time mode only for a tier with a positive one-time price', () => {
    expect(initialPricingMode(undefined)).toBe('subscription');
    expect(initialPricingMode({})).toBe('subscription');
    expect(initialPricingMode({ one_time_price: null })).toBe('subscription');
    expect(initialPricingMode({ one_time_price: 0 })).toBe('subscription');
    expect(initialPricingMode({ one_time_price: 9900 })).toBe('one_time');
  });

  it('requires a one-time price of at least the currency minimum', () => {
    expect(validateOneTimePrice(null, 'USD')).toBe('Amount must be at least $1.');
    expect(validateOneTimePrice(undefined, 'USD')).toBe('Amount must be at least $1.');
    expect(validateOneTimePrice(0, 'USD')).toBe('Amount must be at least $1.');
    expect(validateOneTimePrice(50, 'USD')).toBe('Non-zero amount must be at least $1.');
    expect(validateOneTimePrice(100, 'USD')).toBeUndefined();
    expect(validateOneTimePrice(9900, 'USD')).toBeUndefined();
  });

  it('refuses a one-time price above what Core stores', () => {
    expect(validateOneTimePrice(4294967295, 'USD')).toBeUndefined();
    expect(validateOneTimePrice(4294967296, 'USD')).toBe('Amount is too large.');
  });

  it('parses an empty field as no price, not zero', () => {
    expect(parseOneTimePriceInput('')).toBeNull();
    expect(parseOneTimePriceInput('abc')).toBeNull();
    expect(parseOneTimePriceInput('0')).toBe(0);
    expect(parseOneTimePriceInput('99')).toBe(9900);
    expect(parseOneTimePriceInput('$99.5')).toBe(9950);
    expect(parseOneTimePriceInput('10.019')).toBe(1001);
  });

  it('formats cents for the field', () => {
    expect(formatOneTimePriceInput(null)).toBe('');
    expect(formatOneTimePriceInput(undefined)).toBe('');
    expect(formatOneTimePriceInput(9950)).toBe('99.5');
  });

  it('sends the price and hides the tier from Portal signup in one-time mode', () => {
    expect(buildPricingPayload('one_time', 9900, undefined)).toEqual({
      one_time_price: 9900,
      visibility: 'none',
    });
    expect(buildPricingPayload('one_time', 12000, { one_time_price: 9900 })).toEqual({
      one_time_price: 12000,
      visibility: 'none',
    });
  });

  it('clears the price explicitly when a priced tier goes back to subscription', () => {
    const payload = buildPricingPayload('subscription', 9900, { one_time_price: 9900 });
    expect(payload).toEqual({ one_time_price: null });
    expect(JSON.parse(JSON.stringify(payload))).toEqual({ one_time_price: null });
  });

  it('sends nothing for a subscription tier that never had a price', () => {
    const payload = buildPricingPayload('subscription', 9900, {});
    expect(payload.one_time_price).toBeUndefined();
    expect(JSON.parse(JSON.stringify(payload))).toEqual({});
    expect(JSON.parse(JSON.stringify(buildPricingPayload('subscription', null)))).toEqual({});
  });

  it('warns about subscribers when switching to one-time', () => {
    const warning = pricingModeChangeWarning('one_time', {});
    expect(warning.prompt).toBe(
      'Members who already subscribe to this tier keep their subscription, but nobody can start or switch to a subscription on it.',
    );
  });

  it('adds the checkout discard sentence when one-time mode would drop unsaved checkout edits', () => {
    expect(pricingModeChangeWarning('one_time', {}, true).prompt).toBe(
      'Members who already subscribe to this tier keep their subscription, but nobody can start or switch to a subscription on it. Your unsaved checkout field changes will be discarded.',
    );
    expect(checkoutEditsDiscardWarning()).toEqual({
      title: 'Discard checkout field changes?',
      prompt: 'Your unsaved checkout field changes will be discarded.',
      okLabel: 'Sell as one-time purchase',
    });
  });

  it('names the recurring prices when switching back to subscription', () => {
    expect(
      pricingModeChangeWarning('subscription', {
        currency: 'USD',
        monthly_price: 500,
        yearly_price: 5000,
      }).prompt,
    ).toBe('This tier will be sold as a subscription at $5 a month or $50 a year.');
    expect(
      pricingModeChangeWarning('subscription', {
        currency: 'EUR',
        monthly_price: 1050,
        yearly_price: 10000,
      }).prompt,
    ).toBe('This tier will be sold as a subscription at €10.5 a month or €100 a year.');
  });
});
