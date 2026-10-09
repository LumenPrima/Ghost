const _ = require('lodash');
const errors = require('@tryghost/errors');
const logging = require('@tryghost/logging');
const {
  SIGNUP_CONTEXTS,
  canWelcomeEmailReplaceSignupPaidEmail,
} = require('../../../lib/member-signup-contexts');
const { collectedByPort } = require('../checkout/completed-session');
/** @typedef {import('../../../lib/member-signup-contexts').SignupContext} SignupContext */

function isStripeMetadataTrue(value) {
  return value === true || value === 'true';
}

function hasStripeMetadataKey(metadata, key) {
  return Object.prototype.hasOwnProperty.call(metadata || {}, key);
}

function isGiftCheckoutSession(session) {
  return (
    hasStripeMetadataKey(session.metadata, 'ghost_gift_id') ||
    isStripeMetadataTrue(session.metadata?.ghost_gift)
  );
}

function isDonationCheckoutSession(session) {
  return isStripeMetadataTrue(session.metadata?.ghost_donation);
}

// fork(salvare): one-time tier purchases are marked by a server-set metadata key
function isPurchaseCheckoutSession(session) {
  return hasStripeMetadataKey(session.metadata, 'ghost_purchase_tier_id');
}

// Matches the donation marker on key presence, not truthiness, so an ill-formed
// donation marker alongside a true gift marker still counts as a conflict.
function hasConflictingCheckoutFlowMetadata(session) {
  // fork(salvare): more than one flow marker is a conflict (purchase added)
  const flows = [
    hasStripeMetadataKey(session.metadata, 'ghost_donation'),
    isGiftCheckoutSession(session),
    isPurchaseCheckoutSession(session),
  ];
  return flows.filter(Boolean).length > 1;
}

// fork(salvare): true when any charge on the PaymentIntent is fully refunded. The embedded
// `charges` list exists at the pinned STRIPE_API_VERSION (2020-08-27) and was removed in
// 2022-11-15; a missing list must fail the webhook (Stripe retries) rather than read as "not
// refunded" and grant access to a refunded payment.
function isPaymentIntentRefunded(paymentIntent) {
  const charges = paymentIntent?.charges?.data;
  if (Array.isArray(charges)) {
    return charges.some((charge) => charge?.refunded === true);
  }

  const latestCharge = paymentIntent?.latest_charge;
  if (latestCharge && typeof latestCharge === 'object' && 'refunded' in latestCharge) {
    return latestCharge.refunded === true;
  }

  throw new errors.InternalServerError({
    message: 'PaymentIntent has no charges list; refund state unknown',
    context: `PaymentIntent ${paymentIntent?.id ?? '(unknown)'}`,
  });
}

function getStripeResourceId(resource) {
  if (typeof resource === 'string') {
    return resource;
  }

  if (resource && typeof resource === 'object' && typeof resource.id === 'string') {
    return resource.id;
  }

  return null;
}

function getGiftBuyerEmailFromSession(session) {
  if (session.customer_details?.email) {
    return session.customer_details.email;
  }

  if (
    session.customer &&
    typeof session.customer === 'object' &&
    !session.customer.deleted &&
    session.customer.email
  ) {
    return session.customer.email;
  }

  return null;
}

/**
 * Handles `checkout.session.completed` webhook events
 *
 * The `checkout.session.completed` event is triggered when a customer completes a checkout session.
 *
 * It is triggered for the following scenarios:
 * - Subscription
 * - Donation
 * - Gift purchase
 * - Setup intent
 *
 * This service delegates the event to the appropriate handler based on the session mode and metadata.
 *
 * The `session` payload can be found here: https://docs.stripe.com/api/checkout/sessions/object
 */
module.exports = class CheckoutSessionEventService {
  /**
   * @param {object} deps
   * @param {import('../../stripe-api')} deps.api
   * @param {object} deps.memberRepository
   * @param {object} deps.donationRepository
   * @param {object} deps.giftService
   * @param {object} deps.staffServiceEmails
   * @param {function} deps.sendSignupEmail
   * @param {function} deps.isPaidWelcomeEmailActive
   * @param {object} [deps.purchaseService] fork(salvare): the purchases module's service (lazy getter)
   */
  constructor(deps) {
    this.api = deps.api;
    this.deps = deps;
  }

  /**
   * Handles a `checkout.session.completed` event
   * Delegates to the appropriate handler based on the session mode and metadata
   * @param {import('stripe').Stripe.Checkout.Session} session
   * @param {import('stripe').Stripe.Event.Type} [eventType]
   */
  async handleEvent(session, eventType = 'checkout.session.completed') {
    if (eventType === 'checkout.session.async_payment_failed') {
      return;
    }

    if (eventType === 'checkout.session.async_payment_succeeded') {
      // fork(salvare): purchases may also complete asynchronously
      if (
        session.mode === 'payment' &&
        (isGiftCheckoutSession(session) || isPurchaseCheckoutSession(session))
      ) {
        await this.handlePaymentEvent(session);
      }
      return;
    }

    // fork(salvare): purchases are only fulfilled from payment-mode sessions. The marker is
    // server-set, so seeing it on any other mode is unexpected; the purchase is ignored and the
    // session is handled as its mode dictates.
    if (session.mode !== 'payment' && isPurchaseCheckoutSession(session)) {
      logging.warn(
        `Ignoring purchase metadata on checkout session ${session.id} with mode ${session.mode}`,
      );
    }

    if (session.mode === 'setup') {
      await this.handleSetupEvent(session);
    }

    if (session.mode === 'subscription') {
      await this.handleSubscriptionEvent(session);
    }

    if (session.mode === 'payment') {
      await this.handlePaymentEvent(session);
    }
  }

  /**
   * Routes a `payment` mode session to the donation or gift handler. Gift purchases
   * may complete asynchronously, so their handler only runs once Stripe reports the
   * session as paid, whichever event carried it.
   *
   * @param {import('stripe').Stripe.Checkout.Session} session
   */
  async handlePaymentEvent(session) {
    if (hasConflictingCheckoutFlowMetadata(session)) {
      logging.warn('Ignoring checkout session with conflicting payment flow metadata');
      return;
    }

    if (isGiftCheckoutSession(session)) {
      if (session.payment_status !== 'paid') {
        return;
      }
      await this.handleGiftEvent(session);
      return;
    }

    // fork(salvare): one-time tier purchase; async payment methods wait for async_payment_succeeded
    if (isPurchaseCheckoutSession(session)) {
      if (session.payment_status !== 'paid') {
        return;
      }
      await this.handlePurchaseEvent(session);
      return;
    }

    if (isDonationCheckoutSession(session)) {
      await this.handleDonationEvent(session);
    }
  }

  /**
   * Handles a `checkout.session.completed` event for a gift subscription purchase
   *
   * @param {import('stripe').Stripe.Checkout.Session} session
   */
  async handleGiftEvent(session) {
    const stripeCustomerId = getStripeResourceId(session.customer);

    if (session.metadata?.ghost_gift_id) {
      await this.deps.giftService.completePurchase({
        giftId: session.metadata.ghost_gift_id,
        buyerEmail: getGiftBuyerEmailFromSession(session),
        stripeCustomerId,
        stripeCheckoutSessionId: session.id,
        stripePaymentIntentId: getStripeResourceId(session.payment_intent),
      });
      return;
    }

    const buyerEmail = await this.getGiftBuyerEmail(session, stripeCustomerId);
    await this.deps.giftService.completePurchase({
      token: session.metadata?.gift_token,
      buyerEmail,
      stripeCustomerId,
      tierId: session.metadata?.tier_id,
      cadence: session.metadata?.cadence,
      duration: Number(session.metadata?.duration),
      currency: session.currency,
      amount: session.amount_total,
      stripeCheckoutSessionId: session.id,
      stripePaymentIntentId: getStripeResourceId(session.payment_intent),
    });
  }

  /**
   * fork(salvare): Handles a paid checkout session for a one-time tier purchase
   *
   * Parses the session into the purchases module's Stripe-free input. The PaymentIntent is
   * fetched so a refund that landed before fulfilment is not lost. Any throw answers non-2xx,
   * so Stripe retries.
   *
   * @param {import('stripe').Stripe.Checkout.Session} session
   */
  async handlePurchaseEvent(session) {
    if (!('purchaseService' in this.deps)) {
      // Only constructions that predate purchases (old unit tests) lack the dependency
      logging.error(`Purchase checkout session ${session.id} received without a purchase service`);
      return;
    }

    const purchaseService = this.deps.purchaseService;
    if (!purchaseService) {
      throw new errors.InternalServerError({
        message: 'Purchase service is not initialised',
        context: `Unable to fulfil purchase checkout session ${session.id}`,
      });
    }

    const metadata = session.metadata || {};
    const stripeCustomerId = getStripeResourceId(session.customer);
    const stripePaymentIntentId = getStripeResourceId(session.payment_intent);

    let alreadyRefunded = false;
    if (stripePaymentIntentId) {
      alreadyRefunded = isPaymentIntentRefunded(
        await this.api.getPaymentIntent(stripePaymentIntentId),
      );
    }

    const result = await purchaseService.fulfil({
      stripeCheckoutSessionId: session.id,
      stripePaymentIntentId,
      stripeCustomerId,
      tierId: metadata.ghost_purchase_tier_id,
      memberUuid: metadata.ghost_purchase_member_uuid ?? null,
      email: await this.getGiftBuyerEmail(session, stripeCustomerId),
      name: session.customer_details?.name ?? null,
      amount: session.amount_total,
      currency: session.currency,
      alreadyRefunded,
      attribution: {
        id: metadata.attribution_id ?? null,
        url: metadata.attribution_url ?? null,
        type: metadata.attribution_type ?? null,
        referrerSource: metadata.referrer_source ?? null,
        referrerMedium: metadata.referrer_medium ?? null,
        referrerUrl: metadata.referrer_url ?? null,
        utmSource: metadata.utm_source ?? null,
        utmMedium: metadata.utm_medium ?? null,
        utmCampaign: metadata.utm_campaign ?? null,
        utmTerm: metadata.utm_term ?? null,
        utmContent: metadata.utm_content ?? null,
      },
    });

    // A refund made while fulfilment was in flight finds no committed row, so its
    // charge.refunded webhook is acknowledged and lost. Stripe stores the refund before
    // emitting that event, so re-reading the PaymentIntent after commit closes the window.
    // Errors propagate so Stripe retries this event; refund() and the duplicate path are
    // idempotent and reconcile on redelivery.
    if (result?.outcome === 'fulfilled' && stripePaymentIntentId) {
      const refundedDuringFulfilment = isPaymentIntentRefunded(
        await this.api.getPaymentIntent(stripePaymentIntentId),
      );
      if (refundedDuringFulfilment) {
        logging.warn(
          {
            event: { name: 'purchase.refunded_during_fulfilment' },
            stripeCheckoutSessionId: session.id,
            stripePaymentIntentId,
          },
          'Purchase was fully refunded while it was being fulfilled; revoking access',
        );
        await purchaseService.refund({
          paymentIntentId: stripePaymentIntentId,
          fullyRefunded: true,
        });
      }
    }
  }

  /**
   * Legacy gift Checkout sessions predate persisted buyer details. If their
   * webhook snapshot has no customer details, recover the required buyer email
   * from the Customer associated with the session.
   *
   * @param {import('stripe').Stripe.Checkout.Session} session
   * @param {string|null} stripeCustomerId
   * @returns {Promise<string|null>}
   */
  async getGiftBuyerEmail(session, stripeCustomerId) {
    const sessionEmail = getGiftBuyerEmailFromSession(session);
    if (sessionEmail) {
      return sessionEmail;
    }

    if (!stripeCustomerId) {
      return null;
    }

    const customer = await this.api.getCustomer(stripeCustomerId);
    return customer.deleted ? null : (customer.email ?? null);
  }

  /**
   * Handles a `checkout.session.completed` event for a donation
   * @param {import('stripe').Stripe.Checkout.Session} session
   */
  async handleDonationEvent(session) {
    const donationField = session.custom_fields?.find((obj) => obj?.key === 'donation_message');
    const donationMessage = donationField?.text?.value ? donationField.text.value : null;
    const amount = session.amount_total;
    const currency = session.currency;

    const memberRepository = this.deps.memberRepository;
    const member = session.customer
      ? await memberRepository.get({ customer_id: session.customer })
      : null;

    const { DonationPaymentEvent } = require('../../../donations/donation-payment-event');
    const data = DonationPaymentEvent.create({
      name: member?.get('name') ?? session.customer_details.name,
      email: member?.get('email') ?? session.customer_details.email,
      memberId: member?.id ?? null,
      amount,
      currency,
      donationMessage,
      attributionId: session.metadata?.attribution_id ?? null,
      attributionUrl: session.metadata?.attribution_url ?? null,
      attributionType: session.metadata?.attribution_type ?? null,
      referrerSource: session.metadata?.referrer_source ?? null,
      referrerMedium: session.metadata?.referrer_medium ?? null,
      referrerUrl: session.metadata?.referrer_url ?? null,
      utmSource: session.metadata?.utm_source ?? null,
      utmMedium: session.metadata?.utm_medium ?? null,
      utmCampaign: session.metadata?.utm_campaign ?? null,
      utmTerm: session.metadata?.utm_term ?? null,
      utmContent: session.metadata?.utm_content ?? null,
    });

    const donationRepository = this.deps.donationRepository;
    await donationRepository.save(data);

    const staffServiceEmails = this.deps.staffServiceEmails;
    await staffServiceEmails.notifyDonationReceived({ donationPaymentEvent: data });
  }

  /**
   * Handles a `checkout.session.completed` event for a setup intent
   *
   * This is used when a customer adds or changes their payment method outside
   * of the normal subscription flow.
   * @param {import('stripe').Stripe.Checkout.Session} session
   */
  async handleSetupEvent(session) {
    const setupIntent = await this.api.getSetupIntent(session.setup_intent);

    const memberRepository = this.deps.memberRepository;
    const member = await memberRepository.get({
      customer_id: setupIntent.metadata.customer_id,
    });

    if (!member) {
      return;
    }

    await this.api.attachPaymentMethodToCustomer(
      setupIntent.metadata.customer_id,
      setupIntent.payment_method,
    );

    if (setupIntent.metadata.subscription_id) {
      const updatedSubscription = await this.api.updateSubscriptionDefaultPaymentMethod(
        setupIntent.metadata.subscription_id,
        setupIntent.payment_method,
      );
      try {
        await memberRepository.linkSubscription({
          id: member.id,
          subscription: updatedSubscription,
        });
      } catch (err) {
        if (err.code !== 'ER_DUP_ENTRY' && err.code !== 'SQLITE_CONSTRAINT') {
          throw err;
        }
        throw new errors.ConflictError({
          err,
        });
      }
      return;
    }

    const subscriptions = await member.related('stripeSubscriptions').fetch();
    const activeSubscriptions = subscriptions.models.filter((subscription) =>
      ['active', 'trialing', 'unpaid', 'past_due'].includes(subscription.get('status')),
    );

    for (const subscription of activeSubscriptions) {
      if (subscription.get('customer_id') === setupIntent.metadata.customer_id) {
        const updatedSubscription = await this.api.updateSubscriptionDefaultPaymentMethod(
          subscription.get('subscription_id'),
          setupIntent.payment_method,
        );
        try {
          await memberRepository.linkSubscription({
            id: member.id,
            subscription: updatedSubscription,
          });
        } catch (err) {
          if (err.code !== 'ER_DUP_ENTRY' && err.code !== 'SQLITE_CONSTRAINT') {
            throw err;
          }
          throw new errors.ConflictError({
            err,
          });
        }
      }
    }
  }

  /**
   * Handles a `checkout.session.completed` event for a subscription
   * @param {import('stripe').Stripe.Checkout.Session} session
   */
  async handleSubscriptionEvent(session) {
    const customer = await this.api.getCustomer(session.customer, {
      expand: ['subscriptions.data.default_payment_method'],
    });

    const memberRepository = this.deps.memberRepository;

    let member = await memberRepository.get({
      email: customer.email,
    });

    const memberPreexisted = Boolean(member);
    const checkoutType = _.get(session, 'metadata.checkoutType');

    if (!member) {
      const metadataName = _.get(session, 'metadata.name');
      const metadataNewsletters = _.get(session, 'metadata.newsletters');
      const attribution = {
        id: session.metadata?.attribution_id ?? null,
        url: session.metadata?.attribution_url ?? null,
        type: session.metadata?.attribution_type ?? null,
        referrerSource: session.metadata?.referrer_source ?? null,
        referrerMedium: session.metadata?.referrer_medium ?? null,
        referrerUrl: session.metadata?.referrer_url ?? null,
      };

      const payerName = _.get(
        customer,
        'subscriptions.data[0].default_payment_method.billing_details.name',
      );
      const name = metadataName || payerName || null;

      const memberData = { email: customer.email, name, attribution };
      if (metadataNewsletters) {
        try {
          memberData.newsletters = JSON.parse(metadataNewsletters);
        } catch (e) {
          logging.error(`Ignoring invalid newsletters data - ${metadataNewsletters}.`);
        }
      }

      const offerId = session.metadata?.offer;
      const memberDataWithStripeCustomer = {
        ...memberData,
        stripeCustomer: customer,
        offerId,
      };
      member = await memberRepository.create(memberDataWithStripeCustomer);
    } else {
      const payerName = _.get(
        customer,
        'subscriptions.data[0].default_payment_method.billing_details.name',
      );
      const attribution = {
        id: session.metadata?.attribution_id ?? null,
        url: session.metadata?.attribution_url ?? null,
        type: session.metadata?.attribution_type ?? null,
        referrerSource: session.metadata?.referrer_source ?? null,
        referrerMedium: session.metadata?.referrer_medium ?? null,
        referrerUrl: session.metadata?.referrer_url ?? null,
      };

      if (payerName && !member.get('name')) {
        await memberRepository.update({ name: payerName }, { id: member.get('id') });
      }

      await memberRepository.upsertCustomer({
        customer_id: customer.id,
        member_id: member.id,
        name: customer.name,
        email: customer.email,
      });

      for (const subscription of customer.subscriptions.data) {
        try {
          const offerId = session.metadata?.offer;

          await memberRepository.linkSubscription({
            id: member.id,
            subscription,
            offerId,
            attribution,
          });
        } catch (err) {
          if (err.code !== 'ER_DUP_ENTRY' && err.code !== 'SQLITE_CONSTRAINT') {
            throw err;
          }
          throw new errors.ConflictError({
            err,
          });
        }
      }

      // If member is now paid, remove any complimentary access
      const updatedMember = await memberRepository.get({ id: member.id });
      if (updatedMember && updatedMember.get('status') === 'paid') {
        await memberRepository.removeComplimentarySubscription({ id: member.id });
      }
    }

    // After the subscription work, and deliberately not part of it: a value the member
    // gave us for free must never be able to fail the webhook. A throw here would make
    // Stripe retry the event and risk doing the payment work twice.
    await this.writeCollectedFields(member.id, session, { memberPreexisted });

    if (checkoutType !== 'upgrade') {
      const ghostSignupContext = /** @type {SignupContext | undefined} */ (
        session.metadata?.ghostSignupContext
      );
      const shouldSkipSignupEmailWhenWelcomeEmailActive =
        canWelcomeEmailReplaceSignupPaidEmail(ghostSignupContext);

      if (shouldSkipSignupEmailWhenWelcomeEmailActive) {
        const isPaidWelcomeEmailActive = await this.deps.isPaidWelcomeEmailActive();
        if (!isPaidWelcomeEmailActive) {
          this.deps.sendSignupEmail(customer.email);
        }
      } else {
        // Direct checkout flows do not have a pre-checkout sign-in path.
        this.deps.sendSignupEmail(customer.email);
      }
    }
  }

  /**
   * This service knows how to read a completed Stripe session. It does not know, and must
   * not know, which metafield any of those values belongs in — that is what a binding
   * decides, so no field key appears anywhere in this code.
   *
   * Nothing here may be fatal: a throw fails the webhook, which makes Stripe retry it and
   * risks doing the payment work twice.
   *
   * @param {string} memberId
   * @param {import('stripe').Stripe.Checkout.Session} session
   * @param {object} options
   * @param {boolean} options.memberPreexisted Whether the member's record existed before this event resolved it
   */
  async writeCollectedFields(memberId, session, { memberPreexisted }) {
    // Stamped at create time. A session predating this feature carries none. Read
    // outside the try so a failure below can name the tier whose answers were lost.
    const tierId = session.metadata?.ghostTierId;

    try {
      if (!tierId) {
        return;
      }

      // A checkout can be started with nothing but an email address, and typing an
      // email is not proof of owning it. Values may land on the member this event just
      // created — that record holds nothing the buyer didn't supply — but a record
      // that existed before the checkout belongs to whoever verified that email, so it
      // is only written when the session was created by a signed-in member.
      const wasAuthenticated =
        session.metadata?.ghostSignupContext === SIGNUP_CONTEXTS.ALREADY_AUTHENTICATED;
      if (memberPreexisted && !wasAuthenticated) {
        logging.warn(
          {
            event: { name: 'stripe_checkout.collected_fields.write_skipped' },
            memberId,
            tierId,
          },
          'Skipped storing the fields an unverified checkout collected for an existing member',
        );
        return;
      }

      await this.deps.metafieldBindings.writeCollected(
        memberId,
        tierId,
        collectedByPort.parse(session),
      );
    } catch (err) {
      logging.error(
        {
          event: { name: 'stripe_checkout.collected_fields.write_failed' },
          err,
          memberId,
          tierId,
        },
        'Failed to store the fields a checkout collected',
      );
    }
  }
};
