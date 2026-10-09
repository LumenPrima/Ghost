const errors = require('@tryghost/errors'); // fork(salvare)
const logging = require('@tryghost/logging');

/**
 * Handles `charge.refunded` webhook events
 *
 * When a charge is refunded in Stripe, this service delegates to the
 * appropriate handler based on the type of charge.
 */
module.exports = class ChargeRefundedEventService {
  /**
   * @param {object} deps
   * @param {object} deps.giftService
   * @param {object} [deps.purchaseService] fork(salvare): the purchases module's service (lazy getter)
   */
  constructor(deps) {
    this.deps = deps;
  }

  /**
   * Handles a `charge.refunded` event
   *
   * Extracts the payment intent ID from the charge and delegates to
   * type-specific handlers.
   *
   * @param {import('stripe').Stripe.Charge} charge
   */
  async handleEvent(charge) {
    // payment_intent can be a string ID or an expanded PaymentIntent object
    const raw = charge.payment_intent;
    const paymentIntentId = typeof raw === 'string' ? raw : raw?.id;

    if (!paymentIntentId) {
      logging.info('charge.refunded: no payment_intent on charge, skipping');

      return;
    }

    // Gifts are identified by a payment_intent_id match in the gift
    // repository; non-matching charges (subscription renewals, donations,
    // unrelated one-time payments) are no-ops.
    await this.handleGiftRefundEvent(paymentIntentId);
    // fork(salvare): a payment intent matches at most one of gift or purchase, so order does not matter
    await this.handlePurchaseRefundEvent(charge, paymentIntentId);
  }

  /**
   * Handles a refund for a gift subscription purchase
   *
   * Looks up the gift by payment intent ID and marks it as refunded.
   * If no gift matches, the refund is for something else and is ignored.
   *
   * @param {string} paymentIntentId
   * @private
   */
  async handleGiftRefundEvent(paymentIntentId) {
    const refunded = await this.deps.giftService.handlePaymentRefund({ paymentIntentId });

    if (!refunded) {
      logging.info(
        `charge.refunded: no gift found for payment_intent ${paymentIntentId}, skipping`,
      );
    }
  }

  /**
   * fork(salvare): Handles a refund for a one-time tier purchase
   *
   * Purchases are matched by payment intent ID. Only a full refund revokes access.
   *
   * @param {import('stripe').Stripe.Charge} charge
   * @param {string} paymentIntentId
   * @private
   */
  async handlePurchaseRefundEvent(charge, paymentIntentId) {
    if (!('purchaseService' in this.deps)) {
      // Only constructions that predate purchases (old unit tests) lack the dependency
      return;
    }

    const purchaseService = this.deps.purchaseService;
    if (!purchaseService) {
      // A wiring fault must not answer 2xx, or Stripe never redelivers the refund
      throw new errors.InternalServerError({
        message: 'Purchase service is not initialised',
        context: `Unable to process refund for payment_intent ${paymentIntentId}`,
      });
    }

    const handled = await purchaseService.refund({
      paymentIntentId,
      fullyRefunded: charge.refunded === true,
    });

    if (!handled) {
      logging.info(
        `charge.refunded: no purchase found for payment_intent ${paymentIntentId}, skipping`,
      );
    }
  }
};
