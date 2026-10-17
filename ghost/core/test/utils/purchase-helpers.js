// fork(salvare): shared helpers for the one-time tier purchase e2e suites
// (test/e2e-api/members/purchases.test.js and the Admin API member purchases suite).
//
// Callers must run `mockManager.mockStripe()` and `mockManager.mockMail()` in
// beforeEach: the checkout and webhook helpers drive the Stripe mocker, and the
// email helpers read the stubbed mailer.
const DomainEvents = require('@tryghost/domain-events');
const { stripeMocker } = require('./e2e-framework-mock-manager');
const models = require('../../core/server/models');
const db = require('../../core/server/data/db');
const mailService = require('../../core/server/services/mail');
const membersService = require('../../core/server/services/members');

const COURSE_PRICE = 9900;

let sequence = 0;

/** A process-wide counter for unique Stripe ids (`pi_purchase_<n>`, `cus_purchase_<n>`). */
function next() {
  sequence += 1;
  return sequence;
}

function getLatestCheckoutSession() {
  return stripeMocker.checkoutSessions[stripeMocker.checkoutSessions.length - 1];
}

// The mocker's qs decoder coerces metadata values; Stripe always sends strings.
function toWebhookMetadata(metadata) {
  const result = {};

  for (const [key, value] of Object.entries(metadata)) {
    result[key] = String(value);
  }

  return result;
}

function sentEmails() {
  return mailService.GhostMailer.prototype.sendMail.getCalls().map((call) => call.args[0]);
}

/** Buyer access emails (checkout fulfilment) sent to `email`. */
function accessEmailsTo(email) {
  return sentEmails().filter(
    (mail) => mail.to === email && /^You now have access to /.test(mail.subject),
  );
}

function staffPurchaseEmails() {
  return sentEmails().filter((mail) => /Purchase: /.test(mail.subject ?? ''));
}

async function getMember(email) {
  return await models.Member.findOne(
    { email },
    { require: true, withRelated: ['products', 'stripeCustomers'] },
  );
}

function productIds(member) {
  return member
    .related('products')
    .models.map((product) => product.id)
    .sort();
}

async function getMemberProductRows(memberId) {
  return await db.knex('members_products').where({ member_id: memberId });
}

async function getPurchases(filter) {
  return await db.knex('members_purchases').where(filter);
}

async function getProductEvents(memberId, productId) {
  return await db
    .knex('members_product_events')
    .where({ member_id: memberId, product_id: productId })
    // created_at has 1 s resolution; the ObjectId id breaks ties in insertion order
    .orderBy([
      { column: 'created_at', order: 'asc' },
      { column: 'id', order: 'asc' },
    ]);
}

/** POSTs a purchase checkout. `body` should carry `tierId` (or `tierSlug`). */
async function startCheckout(membersAgent, body, expectedStatus = 200) {
  return await membersAgent
    .post('/api/create-stripe-checkout-session/')
    .body({
      type: 'purchase',
      metadata: {},
      ...body,
    })
    .expectStatus(expectedStatus);
}

/** A paid `checkout.session.completed` webhook event for a purchase session. */
function buildCompletedEvent(
  checkoutSession,
  { email, name = 'Course Buyer', customer, paymentIntent, ...overrides },
  type = 'checkout.session.completed',
) {
  return {
    type,
    data: {
      object: {
        id: checkoutSession.id,
        mode: 'payment',
        payment_status: 'paid',
        amount_total: COURSE_PRICE,
        currency: 'usd',
        customer: customer ?? checkoutSession.customer ?? null,
        customer_details: { email, name },
        payment_intent: paymentIntent,
        metadata: toWebhookMetadata(checkoutSession.metadata),
        ...overrides,
      },
    },
  };
}

async function sendWebhook(event) {
  await stripeMocker.sendWebhook(event);
  await DomainEvents.allSettled();
}

async function sendRefund(paymentIntent, { refunded = true } = {}) {
  await sendWebhook({
    type: 'charge.refunded',
    data: {
      object: {
        id: `ch_${paymentIntent}`,
        payment_intent: paymentIntent,
        refunded,
        invoice: `in_${paymentIntent}`,
      },
    },
  });
}

/**
 * Runs an anonymous checkout plus its paid webhook for `email`.
 * @returns {Promise<{checkoutSession: any, paymentIntent: string, customer: string, member: any}>}
 */
async function purchaseAsGuest(membersAgent, { tierId, email, paymentIntent, customer }) {
  const n = next();
  paymentIntent = paymentIntent ?? `pi_purchase_${n}`;
  customer = customer ?? `cus_purchase_${n}`;

  await startCheckout(membersAgent, { tierId, customerEmail: email });
  const checkoutSession = getLatestCheckoutSession();

  await sendWebhook(buildCompletedEvent(checkoutSession, { email, customer, paymentIntent }));

  return { checkoutSession, paymentIntent, customer, member: await getMember(email) };
}

/**
 * Runs a signed-in checkout plus its paid webhook for an existing member.
 * @returns {Promise<{checkoutSession: any, paymentIntent: string, member: any}>}
 */
async function purchaseAsMember(membersAgent, { tierId, email }) {
  const n = next();
  const paymentIntent = `pi_purchase_${n}`;
  const existing = await getMember(email);
  const identity = await membersService.api.getMemberIdentityToken(existing.get('transient_id'));

  await startCheckout(membersAgent, { tierId, identity });
  const checkoutSession = getLatestCheckoutSession();

  await sendWebhook(
    buildCompletedEvent(checkoutSession, {
      email,
      customer: `cus_purchase_${n}`,
      paymentIntent,
    }),
  );

  return { checkoutSession, paymentIntent, member: await getMember(email) };
}

/**
 * Creates a purchase-only tier through the Admin API (signed-in `adminAgent`).
 * @returns {Promise<any>} the Admin API tier JSON
 */
async function createCourseTier(adminAgent, overrides = {}) {
  const { body } = await adminAgent
    .post('/tiers/')
    .body({
      tiers: [
        {
          name: 'Breaking Free',
          type: 'paid',
          currency: 'usd',
          monthly_price: 500,
          yearly_price: 5000,
          visibility: 'none',
          one_time_price: COURSE_PRICE,
          ...overrides,
        },
      ],
    })
    .expectStatus(201);

  await DomainEvents.allSettled();

  return body.tiers[0];
}

/** Creates a member with an active monthly Stripe subscription to the tier `tierSlug`. */
async function createSubscriber(email, tierSlug, { name = 'Library Subscriber' } = {}) {
  const member = await membersService.api.members.create({ email, name });
  const customer = stripeMocker.createCustomer({ email });
  const price = await stripeMocker.getPriceForTier(tierSlug, 'month');
  const subscription = await stripeMocker.createSubscription({ customer, price });
  await DomainEvents.allSettled();

  const identity = await membersService.api.getMemberIdentityToken(member.get('transient_id'));

  return { member, customer, subscription, identity };
}

module.exports = {
  COURSE_PRICE,
  next,
  getLatestCheckoutSession,
  toWebhookMetadata,
  sentEmails,
  accessEmailsTo,
  staffPurchaseEmails,
  getMember,
  productIds,
  getMemberProductRows,
  getPurchases,
  getProductEvents,
  startCheckout,
  buildCompletedEvent,
  sendWebhook,
  sendRefund,
  purchaseAsGuest,
  purchaseAsMember,
  createCourseTier,
  createSubscriber,
};
