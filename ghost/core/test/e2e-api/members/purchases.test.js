// fork(salvare): one-time tier purchases (members_purchases), end to end against the database.
const assert = require('node:assert/strict');
const sinon = require('sinon');
const DomainEvents = require('@tryghost/domain-events');
const {
  agentProvider,
  mockManager,
  fixtureManager,
  configUtils,
} = require('../../utils/e2e-framework');
const { stripeMocker } = require('../../utils/e2e-framework-mock-manager');
const models = require('../../../core/server/models');
const db = require('../../../core/server/data/db');
const membersService = require('../../../core/server/services/members');
const tiersService = require('../../../core/server/services/tiers');
const giftService = require('../../../core/server/services/gifts');
const purchasesModule = require('../../../core/server/services/purchases');
const urlServiceUtils = require('../../utils/url-service-utils');
const urlUtils = require('../../../core/shared/url-utils').default;
const purchaseHelpers = require('../../utils/purchase-helpers');

const {
  COURSE_PRICE,
  next,
  getLatestCheckoutSession,
  accessEmailsTo,
  staffPurchaseEmails,
  getMember,
  productIds,
  getMemberProductRows,
  getPurchases,
  getProductEvents,
  buildCompletedEvent,
  sendWebhook,
  sendRefund,
} = purchaseHelpers;

let membersAgent, adminAgent;
let courseTier; // Admin API JSON of the purchase-only tier
let libraryProduct; // the fixture's paid tier, sold as a subscription

async function getPostUrl() {
  const post = await models.Post.where('id', fixtureManager.get('posts', 0).id).fetch({
    require: true,
  });
  return { post, url: urlServiceUtils.urlFor(post, 'posts', { absolute: false }) };
}

// The shared helpers, bound to this suite's agents and course tier.
async function startCheckout(body, expectedStatus = 200) {
  return await purchaseHelpers.startCheckout(
    membersAgent,
    { tierId: courseTier.id, ...body },
    expectedStatus,
  );
}

async function purchaseAsGuest(email, { paymentIntent, customer } = {}) {
  return await purchaseHelpers.purchaseAsGuest(membersAgent, {
    tierId: courseTier.id,
    email,
    paymentIntent,
    customer,
  });
}

async function purchaseAsMember(email) {
  return await purchaseHelpers.purchaseAsMember(membersAgent, { tierId: courseTier.id, email });
}

async function createCourseTier() {
  return await purchaseHelpers.createCourseTier(adminAgent);
}

async function createLibrarySubscriber(email) {
  return await purchaseHelpers.createSubscriber(email, libraryProduct.get('slug'));
}

describe('One-time tier purchases', function () {
  beforeAll(async function () {
    const agents = await agentProvider.getAgentsForMembers();
    membersAgent = agents.membersAgent;
    adminAgent = agents.adminAgent;

    await fixtureManager.init('posts', 'members');
    await adminAgent.loginAsOwner();

    libraryProduct = await models.Product.findOne(
      { type: 'paid', slug: 'default-product' },
      { require: true },
    );
  });

  beforeEach(async function () {
    mockManager.mockStripe();
    mockManager.mockMail();

    if (!courseTier) {
      courseTier = await createCourseTier();
    }
  });

  afterEach(async function () {
    await configUtils.restore();
    mockManager.restore();
  });

  it('creates the purchase-only tier with its one-time price', async function () {
    assert.equal(courseTier.one_time_price, COURSE_PRICE);
    assert.equal(courseTier.visibility, 'none');

    const { body } = await adminAgent.get(`/tiers/${courseTier.id}/`).expectStatus(200);
    assert.equal(body.tiers[0].one_time_price, COURSE_PRICE);

    // A7: the Stripe one-time price is created lazily at the first checkout, not on tier events
    const product = await models.Product.findOne({ id: courseTier.id }, { require: true });
    assert.equal(product.get('one_time_price'), COURSE_PRICE);
  });

  it('1. sells the course to a new visitor and creates a free member', async function () {
    const email = 'purchase-new-visitor@example.com';
    const { url } = await getPostUrl();

    await membersAgent
      .post('/api/create-stripe-checkout-session/')
      .body({
        type: 'purchase',
        tierId: courseTier.id,
        customerEmail: email,
        metadata: {
          urlHistory: [
            {
              path: url,
              time: Date.now(),
              referrerMedium: null,
              referrerSource: 'google',
              referrerUrl: 'https://google.com',
              utmSource: 'newsletter',
              utmMedium: 'email',
              utmCampaign: 'launch',
              utmTerm: 'course',
              utmContent: 'footer',
            },
          ],
        },
      })
      .expectStatus(200)
      .matchBodySnapshot();

    const checkoutSession = getLatestCheckoutSession();
    assert.equal(checkoutSession.mode, 'payment');
    assert.equal(checkoutSession.metadata.ghost_purchase_tier_id, courseTier.id);
    assert.equal(checkoutSession.metadata.ghost_purchase_member_uuid, undefined);
    assert.equal(checkoutSession.customer_email, email);
    assert.equal(checkoutSession.customer, undefined);
    assert.equal(
      checkoutSession.payment_intent_data.metadata.ghost_purchase_tier_id,
      courseTier.id,
    );

    // A7: the one-time price exists after the checkout POST
    const priceRows = await db
      .knex('stripe_prices')
      .where({ type: 'one_time', amount: COURSE_PRICE, currency: 'usd', active: true });
    assert.equal(priceRows.length, 1);
    assert.equal(checkoutSession.line_items[0].price, priceRows[0].stripe_price_id);
    assert.equal(checkoutSession.line_items[0].quantity, 1);

    // Pre-checkout magic link: the buyer comes back signed in
    const successUrl = new URL(checkoutSession.success_url);
    assert.match(successUrl.pathname, /\/members\/$/);
    assert.ok(successUrl.searchParams.get('token'), 'success URL carries a magic link token');
    assert.equal(successUrl.searchParams.get('action'), 'signup');
    assert.match(successUrl.searchParams.get('r'), /stripe=purchase-success/);

    await sendWebhook(
      buildCompletedEvent(checkoutSession, {
        email,
        name: 'New Visitor',
        customer: 'cus_purchase_new_visitor',
        paymentIntent: 'pi_purchase_new_visitor',
      }),
    );

    const member = await getMember(email);
    assert.equal(member.get('status'), 'free');
    assert.equal(member.get('name'), 'New Visitor');
    assert.deepEqual(productIds(member), [courseTier.id]);

    const links = await getMemberProductRows(member.id);
    assert.equal(links.length, 1);
    assert.equal(links[0].expiry_at, null);

    const [purchase] = await getPurchases({ member_id: member.id });
    assert.ok(purchase);
    assert.equal(purchase.product_id, courseTier.id);
    assert.equal(purchase.stripe_checkout_session_id, checkoutSession.id);
    assert.equal(purchase.stripe_payment_intent_id, 'pi_purchase_new_visitor');
    assert.equal(purchase.stripe_customer_id, 'cus_purchase_new_visitor');
    assert.equal(purchase.amount, COURSE_PRICE);
    assert.equal(purchase.currency, 'usd');
    assert.equal(purchase.status, 'paid');
    assert.equal(purchase.expires_at, null);
    assert.equal(purchase.refunded_at, null);
    assert.ok(purchase.created_at);
    assert.equal(purchase.attribution_id, fixtureManager.get('posts', 0).id);
    assert.equal(purchase.attribution_type, 'post');
    assert.equal(purchase.attribution_url, url);
    assert.equal(purchase.referrer_source, 'Google');
    assert.equal(purchase.referrer_medium, 'unknown');
    assert.equal(purchase.referrer_url, 'google.com');
    assert.equal(purchase.utm_source, 'newsletter');
    assert.equal(purchase.utm_medium, 'email');
    assert.equal(purchase.utm_campaign, 'launch');
    assert.equal(purchase.utm_term, 'course');
    assert.equal(purchase.utm_content, 'footer');

    const customers = member.related('stripeCustomers').models.map((c) => c.get('customer_id'));
    assert.deepEqual(customers, ['cus_purchase_new_visitor']);

    const events = await getProductEvents(member.id, courseTier.id);
    assert.deepEqual(
      events.map((e) => e.action),
      ['added'],
    );

    assert.equal(accessEmailsTo(email).length, 1);
    assert.equal(accessEmailsTo(email)[0].subject, 'You now have access to Breaking Free');
    const staffEmails = staffPurchaseEmails();
    assert.equal(staffEmails.length, 1);
    assert.equal(staffEmails[0].to, 'jbloggs@example.com');
    assert.match(staffEmails[0].subject, /^💳 Purchase: Breaking Free/);
  });

  it('1b. lets the purchaser read the course content, and takes it away on refund', async function () {
    const email = 'purchase-content-access@example.com';
    const { checkPostAccess } = membersService.contentGating;

    const { body } = await adminAgent
      .post('/posts/')
      .body({
        posts: [
          {
            title: 'Course lesson one',
            status: 'published',
            visibility: 'tiers',
            tiers: [{ id: courseTier.id }],
            lexical: JSON.stringify({
              root: {
                children: [
                  {
                    children: [{ text: 'Paywalled lesson body', type: 'text', version: 1 }],
                    type: 'paragraph',
                    version: 1,
                  },
                ],
                type: 'root',
                version: 1,
              },
            }),
          },
        ],
      })
      .expectStatus(201);
    const post = body.posts[0];
    assert.equal(post.visibility, 'tiers');
    assert.deepEqual(
      post.tiers.map((tier) => tier.slug),
      [courseTier.slug],
    );

    const { paymentIntent } = await purchaseAsGuest(email);

    // req.member as members-ssr builds it for the site
    let memberData = await membersService.api.getMemberIdentityData(email);
    assert.equal(memberData.status, 'free');
    assert.equal(checkPostAccess(post, memberData), true, 'the purchaser can read the course');

    await sendRefund(paymentIntent);

    memberData = await membersService.api.getMemberIdentityData(email);
    assert.equal(checkPostAccess(post, memberData), false, 'a refund removes access');
  });

  it('2. fulfils a redelivered webhook only once', async function () {
    const email = 'purchase-idempotent@example.com';

    await startCheckout({ customerEmail: email });
    const checkoutSession = getLatestCheckoutSession();
    const event = buildCompletedEvent(checkoutSession, {
      email,
      customer: 'cus_purchase_idempotent',
      paymentIntent: 'pi_purchase_idempotent',
    });

    await sendWebhook(event);
    await sendWebhook(event);

    const member = await getMember(email);
    const purchases = await getPurchases({ stripe_checkout_session_id: checkoutSession.id });
    assert.equal(purchases.length, 1);
    assert.equal((await getMemberProductRows(member.id)).length, 1);
    assert.equal((await getProductEvents(member.id, courseTier.id)).length, 1);
    assert.equal(accessEmailsTo(email).length, 1);
    assert.equal(staffPurchaseEmails().length, 1);
  });

  it('3. waits for delayed payment success and ignores a failed one', async function () {
    const email = 'purchase-delayed@example.com';

    await startCheckout({ customerEmail: email });
    const checkoutSession = getLatestCheckoutSession();
    const base = {
      email,
      customer: 'cus_purchase_delayed',
      paymentIntent: 'pi_purchase_delayed',
    };

    await sendWebhook(buildCompletedEvent(checkoutSession, { ...base, payment_status: 'unpaid' }));
    assert.equal(
      (await getPurchases({ stripe_checkout_session_id: checkoutSession.id })).length,
      0,
    );
    assert.equal(await models.Member.findOne({ email }), null);

    await sendWebhook(
      buildCompletedEvent(
        checkoutSession,
        { ...base, payment_status: 'unpaid' },
        'checkout.session.async_payment_failed',
      ),
    );
    assert.equal(
      (await getPurchases({ stripe_checkout_session_id: checkoutSession.id })).length,
      0,
    );

    const succeeded = buildCompletedEvent(
      checkoutSession,
      base,
      'checkout.session.async_payment_succeeded',
    );
    await sendWebhook(succeeded);
    await sendWebhook(succeeded);

    const member = await getMember(email);
    assert.equal(member.get('status'), 'free');
    assert.deepEqual(productIds(member), [courseTier.id]);
    assert.equal(
      (await getPurchases({ stripe_checkout_session_id: checkoutSession.id })).length,
      1,
    );
    assert.equal(accessEmailsTo(email).length, 1);
  });

  it('4. sells the course to a signed-in Library subscriber and keeps it across renewals', async function () {
    const email = 'purchase-library-subscriber@example.com';
    const { member, customer, subscription, identity } = await createLibrarySubscriber(email);

    let subscriber = await getMember(email);
    assert.equal(subscriber.get('status'), 'paid');
    assert.deepEqual(productIds(subscriber), [libraryProduct.id]);

    await startCheckout({ identity });
    const checkoutSession = getLatestCheckoutSession();
    assert.equal(checkoutSession.customer, customer.id);
    assert.equal(checkoutSession.customer_email, undefined);
    assert.equal(checkoutSession.metadata.ghost_purchase_member_uuid, member.get('uuid'));
    // Signed in already: no magic link in the success URL
    assert.equal(new URL(checkoutSession.success_url).searchParams.get('token'), null);

    await sendWebhook(
      buildCompletedEvent(checkoutSession, {
        email,
        customer: customer.id,
        paymentIntent: 'pi_purchase_library_subscriber',
      }),
    );

    subscriber = await getMember(email);
    assert.equal(subscriber.get('status'), 'paid');
    assert.deepEqual(productIds(subscriber), [courseTier.id, libraryProduct.id].sort());
    const [purchase] = await getPurchases({ member_id: member.id });
    assert.equal(purchase.stripe_customer_id, customer.id);

    // A renewal runs removeComplimentarySubscription and linkSubscription for a paid member
    await stripeMocker.updateSubscription({
      id: subscription.id,
      current_period_end: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 62,
    });

    subscriber = await getMember(email);
    assert.equal(subscriber.get('status'), 'paid');
    assert.deepEqual(productIds(subscriber), [courseTier.id, libraryProduct.id].sort());
    const courseLink = (await getMemberProductRows(member.id)).find(
      (row) => row.product_id === courseTier.id,
    );
    assert.equal(courseLink.expiry_at, null);
  });

  it('5. asks an existing member to sign in, whatever whitespace pads the email', async function () {
    const email = 'purchase-existing-unauthenticated@example.com';
    await membersService.api.members.create({ email, name: 'Existing Member' });
    await DomainEvents.allSettled();
    const sessionsBefore = stripeMocker.checkoutSessions.length;
    // The page that started checkout: the sign-in link brings the member back to it
    const cancelUrl = new URL('courses/breaking-free/', urlUtils.urlFor('home', true)).href;

    // The padded variants miss the router's raw-string lookup; the service resolves the member
    // from the trimmed email, so none of them can mint a signup link for this account
    for (const customerEmail of [email, ` ${email}`, `\t${email}`, `${email} `]) {
      const { body } = await startCheckout({ customerEmail, cancelUrl }, 403);
      assert.equal(body.errors[0].code, 'PURCHASE_SIGNIN_REQUIRED');
    }

    assert.equal(stripeMocker.checkoutSessions.length, sessionsBefore);
    const mail = await mockManager.assert.sentEmailEventually({ to: email, subject: /sign in/i });
    const magicLink = (mail.text ?? '').match(/https?:\/\/\S+token=\S+/)?.[0];
    assert.ok(magicLink, 'expected a magic link in the sign-in email');
    assert.equal(new URL(magicLink).searchParams.get('r'), cancelUrl);
  });

  it('5b. grants the course to a member who signed up after a guest checkout, without attaching the guest customer', async function () {
    const email = 'purchase-existing-after-checkout@example.com';

    await startCheckout({ customerEmail: email });
    const checkoutSession = getLatestCheckoutSession();
    assert.equal(checkoutSession.metadata.ghost_purchase_member_uuid, undefined);
    assert.equal(checkoutSession.customer, undefined);
    assert.equal(checkoutSession.customer_email, email);

    // The member is created by another route before the webhook arrives
    const member = await membersService.api.members.create({ email, name: 'Existing Member' });
    await DomainEvents.allSettled();

    await sendWebhook(
      buildCompletedEvent(checkoutSession, {
        email,
        customer: 'cus_purchase_guest',
        paymentIntent: 'pi_purchase_guest',
      }),
    );

    const updated = await getMember(email);
    assert.equal(updated.id, member.id);
    assert.equal(updated.get('status'), 'free');
    assert.deepEqual(productIds(updated), [courseTier.id]);

    const [purchase] = await getPurchases({ member_id: member.id });
    assert.equal(purchase.stripe_customer_id, 'cus_purchase_guest');
    const customerRows = await db
      .knex('members_stripe_customers')
      .where({ customer_id: 'cus_purchase_guest' });
    assert.equal(customerRows.length, 0);
    assert.equal(updated.related('stripeCustomers').length, 0);
  });

  it('6. refuses a second checkout for a course the member already owns', async function () {
    const email = 'purchase-already-owned@example.com';
    const { member } = await purchaseAsGuest(email);
    const identity = await membersService.api.getMemberIdentityToken(member.get('transient_id'));
    const sessionsBefore = stripeMocker.checkoutSessions.length;

    const { body } = await startCheckout({ identity }, 403);
    assert.equal(body.errors[0].code, 'PURCHASE_ALREADY_OWNED');
    assert.equal(body.errors[0].message, 'You already own this.');

    // Unauthenticated with the owner's email: the same sign-in answer any member gets, so
    // ownership is not revealed, and a sign-in link is emailed
    const { body: guestBody } = await startCheckout({ customerEmail: email }, 403);
    assert.equal(guestBody.errors[0].code, 'PURCHASE_SIGNIN_REQUIRED');
    await mockManager.assert.sentEmailEventually({ to: email, subject: /sign in/i });

    assert.equal(stripeMocker.checkoutSessions.length, sessionsBefore);
  });

  it('7. revokes the course on a full refund and ignores partial or unknown refunds', async function () {
    const email = 'purchase-refund@example.com';
    const { member, paymentIntent } = await purchaseAsGuest(email);
    assert.deepEqual(productIds(member), [courseTier.id]);

    // Partial refund: no change
    await sendRefund(paymentIntent, { refunded: false });
    let [purchase] = await getPurchases({ stripe_payment_intent_id: paymentIntent });
    assert.equal(purchase.status, 'paid');
    assert.deepEqual(productIds(await getMember(email)), [courseTier.id]);

    // Unknown payment intent: no change
    await sendRefund('pi_purchase_unknown');
    [purchase] = await getPurchases({ stripe_payment_intent_id: paymentIntent });
    assert.equal(purchase.status, 'paid');

    // Full refund
    await sendRefund(paymentIntent);
    [purchase] = await getPurchases({ stripe_payment_intent_id: paymentIntent });
    assert.equal(purchase.status, 'refunded');
    assert.ok(purchase.refunded_at);

    const refunded = await getMember(email);
    assert.equal(refunded.get('status'), 'free');
    assert.deepEqual(productIds(refunded), []);
    assert.deepEqual(
      (await getProductEvents(member.id, courseTier.id)).map((e) => e.action),
      ['added', 'removed'],
    );

    // Redelivered refund: idempotent
    await sendRefund(paymentIntent);
    assert.deepEqual(
      (await getProductEvents(member.id, courseTier.id)).map((e) => e.action),
      ['added', 'removed'],
    );
  });

  it('A4. records a purchase refunded before fulfilment without granting access', async function () {
    const email = 'purchase-refunded-first@example.com';
    const paymentIntent = 'pi_purchase_refunded_first';

    await startCheckout({ customerEmail: email });
    const checkoutSession = getLatestCheckoutSession();

    // The refund landed (and its charge.refunded webhook found nothing) before fulfilment
    stripeMocker.refundPaymentIntent(paymentIntent);
    await sendRefund(paymentIntent);

    await sendWebhook(
      buildCompletedEvent(checkoutSession, {
        email,
        customer: 'cus_purchase_refunded_first',
        paymentIntent,
      }),
    );

    const [purchase] = await getPurchases({ stripe_checkout_session_id: checkoutSession.id });
    assert.equal(purchase.status, 'refunded');
    assert.ok(purchase.refunded_at);
    assert.equal(purchase.member_id, null);
    assert.equal(await models.Member.findOne({ email }), null);
    assert.equal(accessEmailsTo(email).length, 0);
    assert.equal(staffPurchaseEmails().length, 0);

    // A later redelivery of either webhook changes nothing
    await sendRefund(paymentIntent);
    await sendWebhook(
      buildCompletedEvent(checkoutSession, {
        email,
        customer: 'cus_purchase_refunded_first',
        paymentIntent,
      }),
    );
    assert.equal(
      (await getPurchases({ stripe_checkout_session_id: checkoutSession.id })).length,
      1,
    );
    assert.equal(await models.Member.findOne({ email }), null);
  });

  it('A4b. revokes a purchase refunded while its fulfilment was in flight', async function () {
    const email = 'purchase-refunded-during-fulfilment@example.com';
    const paymentIntent = 'pi_purchase_refunded_during';

    await startCheckout({ customerEmail: email });
    const checkoutSession = getLatestCheckoutSession();

    // The refund lands after the pre-fulfil PaymentIntent check but before the row commits,
    // so its charge.refunded webhook found nothing and was acknowledged (lost)
    const instance = purchasesModule.service;
    const originalFulfil = instance.fulfil.bind(instance);
    const fulfil = sinon.stub(instance, 'fulfil').callsFake(async (input) => {
      const result = await originalFulfil(input);
      stripeMocker.refundPaymentIntent(paymentIntent);
      return result;
    });

    try {
      await sendWebhook(
        buildCompletedEvent(checkoutSession, {
          email,
          customer: 'cus_purchase_refunded_during',
          paymentIntent,
        }),
      );
    } finally {
      fulfil.restore();
    }

    const [purchase] = await getPurchases({ stripe_checkout_session_id: checkoutSession.id });
    assert.equal(purchase.status, 'refunded');
    const member = await getMember(email);
    assert.equal(member.get('status'), 'free');
    assert.deepEqual(productIds(member), []);
  });

  it('8. lets an admin comp a purchaser and remove the comp without touching the course', async function () {
    const email = 'purchase-comped@example.com';
    const { member } = await purchaseAsGuest(email);

    const { body: compBody } = await adminAgent
      .put(`/members/${member.id}/`)
      .body({ members: [{ id: member.id, email, tiers: [{ id: libraryProduct.id }] }] })
      .expectStatus(200);

    assert.equal(compBody.members[0].status, 'comped');
    assert.deepEqual(
      compBody.members[0].tiers.map((t) => t.id).sort(),
      [courseTier.id, libraryProduct.id].sort(),
    );

    // The React "remove comp" shape sends the tiers that remain
    const { body: removeBody } = await adminAgent
      .put(`/members/${member.id}/`)
      .body({ members: [{ id: member.id, email, tiers: [{ id: courseTier.id }] }] })
      .expectStatus(200);

    assert.equal(removeBody.members[0].status, 'free');
    assert.deepEqual(
      removeBody.members[0].tiers.map((t) => t.id),
      [courseTier.id],
    );

    // Removing every tier still keeps the purchased course (A11: Admin cannot remove it)
    const { body: emptyBody } = await adminAgent
      .put(`/members/${member.id}/`)
      .body({ members: [{ id: member.id, email, tiers: [] }] })
      .expectStatus(200);
    assert.equal(emptyBody.members[0].status, 'free');
    assert.deepEqual(
      emptyBody.members[0].tiers.map((t) => t.id),
      [courseTier.id],
    );

    // Purchase ids never produce product events of their own
    assert.deepEqual(
      (await getProductEvents(member.id, courseTier.id)).map((e) => e.action),
      ['added'],
    );
  });

  it('9. keeps the course when the purchaser cancels a Library subscription', async function () {
    const email = 'purchase-cancel-subscription@example.com';
    await purchaseAsGuest(email);

    const customer = stripeMocker.createCustomer({ email });
    const price = await stripeMocker.getPriceForTier(libraryProduct.get('slug'), 'month');
    const subscription = await stripeMocker.createSubscription({ customer, price });
    await DomainEvents.allSettled();

    let member = await getMember(email);
    assert.equal(member.get('status'), 'paid');
    assert.deepEqual(productIds(member), [courseTier.id, libraryProduct.id].sort());

    await stripeMocker.updateSubscription({ id: subscription.id, status: 'canceled' });

    member = await getMember(email);
    assert.equal(member.get('status'), 'free');
    assert.deepEqual(productIds(member), [courseTier.id]);
  });

  it('10. strips purchase markers from donation checkout metadata', async function () {
    const { url } = await getPostUrl();

    await membersAgent
      .post('/api/create-stripe-checkout-session/')
      .body({
        type: 'donation',
        customerEmail: 'purchase-reserved-donation@example.com',
        successUrl: 'https://example.com/?type=success',
        cancelUrl: 'https://example.com/?type=cancel',
        metadata: {
          ghost_purchase_tier_id: courseTier.id,
          ghost_purchase_member_uuid: 'attacker-uuid',
          urlHistory: [{ path: url, time: Date.now(), referrerSource: null }],
        },
      })
      .expectStatus(200);

    const checkoutSession = getLatestCheckoutSession();
    assert.equal(checkoutSession.mode, 'payment');
    assert.equal(checkoutSession.metadata.ghost_purchase_tier_id, undefined);
    assert.equal(checkoutSession.metadata.ghost_purchase_member_uuid, undefined);

    // Client-supplied markers are dropped from purchase checkouts too
    await startCheckout({
      customerEmail: 'purchase-reserved-purchase@example.com',
      metadata: { ghost_purchase_member_uuid: 'attacker-uuid' },
    });
    const purchaseSession = getLatestCheckoutSession();
    assert.equal(purchaseSession.metadata.ghost_purchase_member_uuid, undefined);
    assert.equal(purchaseSession.metadata.ghost_purchase_tier_id, courseTier.id);
  });

  it('11. refuses a subscription checkout for the purchase-only tier', async function () {
    const sessionsBefore = stripeMocker.checkoutSessions.length;

    const { body } = await membersAgent
      .post('/api/create-stripe-checkout-session/')
      .body({
        type: 'subscription',
        tierId: courseTier.id,
        cadence: 'month',
        customerEmail: 'purchase-subscription-attempt@example.com',
        metadata: {},
      })
      .expectStatus(403);

    assert.equal(body.errors[0].code, 'TIER_PURCHASE_ONLY');
    assert.equal(stripeMocker.checkoutSessions.length, sessionsBefore);
  });

  it('12. keeps the purchase row when the purchaser is deleted', async function () {
    const email = 'purchase-deleted-member@example.com';
    const { member, checkoutSession } = await purchaseAsGuest(email);

    await adminAgent.delete(`/members/${member.id}/`).expectStatus(204);

    assert.equal(await models.Member.findOne({ email }), null);
    const [purchase] = await getPurchases({ stripe_checkout_session_id: checkoutSession.id });
    assert.ok(purchase, 'the purchase row is kept');
    assert.equal(purchase.member_id, null);
    assert.equal(purchase.status, 'paid');
  });

  it('A6. refuses to move a subscription onto the purchase-only tier', async function () {
    const email = 'purchase-move-subscription@example.com';
    const { subscription, identity } = await createLibrarySubscriber(email);

    // tierId + cadence branch
    await membersAgent
      .put(`/api/subscriptions/${subscription.id}/`)
      .body({ identity, tierId: courseTier.id, cadence: 'month' })
      .expectStatus(403)
      .expect(({ text }) => {
        assert.equal(text, 'Tier is only available as a one-time purchase.');
      });

    // priceId branch: point at the course's one-time stripe_prices row
    await startCheckout({ customerEmail: 'purchase-price-creator@example.com' });
    const priceRow = await db
      .knex('stripe_prices')
      .where({ type: 'one_time', amount: COURSE_PRICE, active: true })
      .first();
    assert.ok(priceRow);

    await membersAgent
      .put(`/api/subscriptions/${subscription.id}/`)
      .body({ identity, priceId: priceRow.id })
      .expectStatus(403)
      .expect(({ text }) => {
        assert.equal(text, 'Tier is only available as a one-time purchase.');
      });

    const member = await getMember(email);
    assert.deepEqual(productIds(member), [libraryProduct.id]);
  });

  it('A6. refuses a gift checkout for a public purchase-only tier', async function () {
    mockManager.mockSetting('portal_plans', ['free', 'monthly', 'yearly']);

    const { body: tierBody } = await adminAgent
      .post('/tiers/')
      .body({
        tiers: [
          {
            name: 'Public Course',
            type: 'paid',
            currency: 'usd',
            monthly_price: 500,
            yearly_price: 5000,
            visibility: 'public',
            one_time_price: 4900,
          },
        ],
      })
      .expectStatus(201);
    await DomainEvents.allSettled();
    const publicCourse = tierBody.tiers[0];

    try {
      const sessionsBefore = stripeMocker.checkoutSessions.length;

      const { body } = await membersAgent
        .post('/api/create-stripe-checkout-session/')
        .body({
          type: 'gift',
          tierId: publicCourse.id,
          cadence: 'month',
          customerEmail: 'purchase-gift-attempt@example.com',
          metadata: {},
        })
        .expectStatus(400);

      // The tier is active, public and paid, so only the one-time price rejects it
      assert.equal(
        body.errors[0].context,
        'The requested tier is not available for gift purchases',
      );
      assert.equal(stripeMocker.checkoutSessions.length, sessionsBefore);
    } finally {
      await tiersService.api.edit(publicCourse.id, { status: 'archived' });
    }
  });

  it('A5. a member comped on the course with an expiry becomes free with lifetime access after buying it', async function () {
    const email = 'purchase-comped-with-expiry@example.com';
    const expiry = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30);

    const { body } = await adminAgent
      .post('/members/')
      .body({
        members: [
          { email, name: 'Comped Buyer', tiers: [{ id: courseTier.id, expiry_at: expiry }] },
        ],
      })
      .expectStatus(201);
    const memberId = body.members[0].id;
    assert.equal(body.members[0].status, 'comped');
    const [compLink] = await getMemberProductRows(memberId);
    assert.ok(compLink.expiry_at, 'the comp carries an expiry');

    await purchaseAsMember(email);

    const member = await getMember(email);
    assert.equal(member.id, memberId);
    assert.equal(member.get('status'), 'free');
    assert.deepEqual(productIds(member), [courseTier.id]);
    const links = await getMemberProductRows(memberId);
    assert.equal(links.length, 1);
    assert.equal(links[0].expiry_at, null);

    const statusEvents = await db
      .knex('members_status_events')
      .where({ member_id: memberId })
      .orderBy([
        { column: 'created_at', order: 'asc' },
        { column: 'id', order: 'asc' },
      ]);
    assert.deepEqual(
      statusEvents.map((e) => [e.from_status, e.to_status]),
      [
        [null, 'comped'],
        ['comped', 'free'],
      ],
    );
  });

  describe('Gifts for a purchaser', function () {
    async function redeemGiftAsPurchaser(email) {
      const n = next();
      await purchaseAsGuest(email);

      const now = new Date();
      const consumesAt = new Date(now.getTime() + 1000 * 60 * 60 * 24 * 30);
      const gift = await models.Gift.add({
        token: `purchase-gift-token-${n}`,
        buyer_email: `purchase-gift-buyer-${n}@example.com`,
        buyer_member_id: null,
        redeemer_member_id: null,
        tier_id: libraryProduct.id,
        cadence: 'year',
        duration: 1,
        currency: 'usd',
        amount: 5000,
        stripe_checkout_session_id: `cs_purchase_gift_${n}`,
        stripe_payment_intent_id: `pi_purchase_gift_${n}`,
        checkout_started_at: now,
        consumes_at: null,
        expires_at: new Date(now.getTime() + 1000 * 60 * 60 * 24 * 365 * 10),
        status: 'purchased',
        purchased_at: now,
      });

      const agent = membersAgent.duplicate();
      await agent.loginAs(email);
      await agent
        .post(`/api/gifts/${gift.get('token')}/redeem/`)
        .body({})
        .expectStatus(200);
      await DomainEvents.allSettled();

      const member = await getMember(email);
      assert.equal(member.get('status'), 'gift');
      assert.deepEqual(productIds(member), [courseTier.id, libraryProduct.id].sort());

      return { gift, member, consumesAt };
    }

    it('keeps the course when the redeemed gift is refunded', async function () {
      const email = 'purchase-gift-refund@example.com';
      const { gift } = await redeemGiftAsPurchaser(email);

      await sendRefund(gift.get('stripe_payment_intent_id'));

      const refundedGift = await models.Gift.findOne({ id: gift.id }, { require: true });
      assert.equal(refundedGift.get('status'), 'refunded');

      const member = await getMember(email);
      assert.equal(member.get('status'), 'free');
      assert.deepEqual(productIds(member), [courseTier.id]);
      const [purchase] = await getPurchases({ member_id: member.id });
      assert.equal(purchase.status, 'paid');
    });

    it('keeps the course when the redeemed gift is consumed', async function () {
      const email = 'purchase-gift-consumed@example.com';
      const { gift } = await redeemGiftAsPurchaser(email);

      await models.Gift.edit({ consumes_at: new Date(Date.now() - 1000 * 60) }, { id: gift.id });
      await giftService.service.processConsumed();
      await DomainEvents.allSettled();

      const consumedGift = await models.Gift.findOne({ id: gift.id }, { require: true });
      assert.equal(consumedGift.get('status'), 'consumed');

      const member = await getMember(email);
      assert.equal(member.get('status'), 'free');
      assert.deepEqual(productIds(member), [courseTier.id]);
    });

    it('moves a gift member who bought the gifted tier to free when the gift is consumed', async function () {
      const n = next();
      const email = 'purchase-gift-same-tier@example.com';
      const created = await membersService.api.members.create({ email, name: 'Gifted Buyer' });
      await DomainEvents.allSettled();

      const now = new Date();
      const gift = await models.Gift.add({
        token: `purchase-gift-token-${n}`,
        buyer_email: `purchase-gift-buyer-${n}@example.com`,
        buyer_member_id: null,
        redeemer_member_id: null,
        tier_id: courseTier.id,
        cadence: 'year',
        duration: 1,
        currency: 'usd',
        amount: 5000,
        stripe_checkout_session_id: `cs_purchase_gift_${n}`,
        stripe_payment_intent_id: `pi_purchase_gift_${n}`,
        checkout_started_at: now,
        consumes_at: null,
        expires_at: new Date(now.getTime() + 1000 * 60 * 60 * 24 * 365 * 10),
        status: 'purchased',
        purchased_at: now,
      });

      const agent = membersAgent.duplicate();
      await agent.loginAs(email);
      await agent
        .post(`/api/gifts/${gift.get('token')}/redeem/`)
        .body({})
        .expectStatus(200);
      await DomainEvents.allSettled();

      let member = await getMember(email);
      assert.equal(member.get('status'), 'gift');
      assert.deepEqual(productIds(member), [courseTier.id]);

      // The gift member buys the gifted tier while signed in
      const identity = await membersService.api.getMemberIdentityToken(created.get('transient_id'));
      await startCheckout({ identity });
      const checkoutSession = getLatestCheckoutSession();
      await sendWebhook(
        buildCompletedEvent(checkoutSession, {
          email,
          customer: `cus_purchase_gift_same_${n}`,
          paymentIntent: `pi_purchase_gift_same_${n}`,
        }),
      );

      member = await getMember(email);
      assert.equal(member.get('status'), 'gift');

      await models.Gift.edit({ consumes_at: new Date(Date.now() - 1000 * 60) }, { id: gift.id });
      await giftService.service.processConsumed();
      await DomainEvents.allSettled();

      member = await getMember(email);
      assert.equal(member.get('status'), 'free');
      assert.deepEqual(productIds(member), [courseTier.id]);
      const statusEvents = await db
        .knex('members_status_events')
        .where({ member_id: member.id, from_status: 'gift', to_status: 'free' });
      assert.equal(statusEvents.length, 1);
    });
  });

  // fork(salvare): Phase 3, tierSlug on purchase checkout (theme contract §2). tierId wins strictly.
  describe('tierSlug', function () {
    it('resolves a slug-only checkout to the tier and its one-time price', async function () {
      const sessionsBefore = stripeMocker.checkoutSessions.length;

      await startCheckout({
        tierId: undefined,
        tierSlug: courseTier.slug,
        customerEmail: 'purchase-slug-only@example.com',
      });

      assert.equal(stripeMocker.checkoutSessions.length, sessionsBefore + 1);
      const checkoutSession = getLatestCheckoutSession();
      assert.equal(checkoutSession.mode, 'payment');
      assert.equal(checkoutSession.metadata.ghost_purchase_tier_id, courseTier.id);

      // mockStripe() resets per test, so look up the price this session used
      const price = await db
        .knex('stripe_prices')
        .where({ stripe_price_id: checkoutSession.line_items[0].price })
        .first();
      assert.ok(price, 'the line item uses a stored price');
      assert.equal(price.type, 'one_time');
      assert.equal(price.amount, COURSE_PRICE);
      assert.equal(price.currency, 'usd');
      assert.equal(checkoutSession.line_items[0].quantity, 1);
    });

    it('accepts tierId: null next to a slug, and trims the slug', async function () {
      await startCheckout({
        tierId: null,
        tierSlug: `  ${courseTier.slug} `,
        customerEmail: 'purchase-slug-null-id@example.com',
      });

      assert.equal(getLatestCheckoutSession().metadata.ghost_purchase_tier_id, courseTier.id);
    });

    it('uses tierId when both are sent', async function () {
      await startCheckout({
        tierId: courseTier.id,
        tierSlug: libraryProduct.get('slug'),
        customerEmail: 'purchase-slug-and-id@example.com',
      });

      assert.equal(getLatestCheckoutSession().metadata.ghost_purchase_tier_id, courseTier.id);
    });

    it('never falls back to the slug when tierId is present', async function () {
      const sessionsBefore = stripeMocker.checkoutSessions.length;

      // A tier without a one-time price by id, the course by slug: the id wins and is refused
      const { body } = await startCheckout(
        {
          tierId: libraryProduct.id,
          tierSlug: courseTier.slug,
          customerEmail: 'purchase-slug-no-fallback@example.com',
        },
        400,
      );
      assert.match(body.errors[0].context, /Tier with id ".+" has no one-time price/);

      // An unknown id is not rescued by a good slug either
      const unknown = await startCheckout(
        {
          tierId: '0123456789abcdef01234567',
          tierSlug: courseTier.slug,
          customerEmail: 'purchase-slug-no-fallback@example.com',
        },
        400,
      );
      assert.equal(unknown.body.errors[0].message, 'This tier does not exist.');

      assert.equal(stripeMocker.checkoutSessions.length, sessionsBefore);
    });

    it('refuses an unknown slug, and a request with neither key, with 400', async function () {
      const sessionsBefore = stripeMocker.checkoutSessions.length;

      const { body } = await startCheckout(
        {
          tierId: undefined,
          tierSlug: 'no-such-course',
          customerEmail: 'purchase-slug-unknown@example.com',
        },
        400,
      );
      assert.equal(body.errors[0].message, 'This tier does not exist.');
      assert.equal(body.errors[0].context, 'Tier with slug "no-such-course" not found');

      await startCheckout(
        {
          tierId: undefined,
          customerEmail: 'purchase-slug-neither@example.com',
        },
        400,
      );

      // A slug naming a tier without a one-time price
      const subscriptionTier = await startCheckout(
        {
          tierId: undefined,
          tierSlug: libraryProduct.get('slug'),
          customerEmail: 'purchase-slug-subscription-tier@example.com',
        },
        400,
      );
      assert.match(
        subscriptionTier.body.errors[0].context,
        /Tier with slug ".+" has no one-time price/,
      );

      assert.equal(stripeMocker.checkoutSessions.length, sessionsBefore);
    });
  });
});
