// fork(salvare): staff grants and revokes of one-time tier purchases
// (`/members/:id/purchases/`), end to end against the database.
const assert = require('node:assert/strict');
const sinon = require('sinon');
const {
  agentProvider,
  fixtureManager,
  matchers,
  mockManager,
  configUtils,
  resetRateLimits,
} = require('../../utils/e2e-framework');
const models = require('../../../core/server/models');
const tiersService = require('../../../core/server/services/tiers');
const membersService = require('../../../core/server/services/members');
const { fromDatabaseDate } = require('../../../core/server/lib/db-types/date');
const purchaseHelpers = require('../../utils/purchase-helpers');

const {
  anyContentLength,
  anyContentVersion,
  anyEtag,
  anyISODateTime,
  anyLocationFor,
  anyObjectId,
} = matchers;

const {
  buildCompletedEvent,
  getMemberProductRows,
  getProductEvents,
  getPurchases,
  sendRefund,
  sendWebhook,
  sentEmails,
  staffPurchaseEmails,
} = purchaseHelpers;

const DAY = 24 * 60 * 60 * 1000;
const UNKNOWN_ID = '0123456789abcdef01234567';

describe('Member purchases Admin API', function () {
  let adminAgent;
  let membersAgent;
  let courseTier; // Admin API JSON of the purchase-only tier
  let libraryProduct; // the fixture's paid tier, sold as a subscription
  let emailCount = 0;

  function nextEmail(label) {
    emailCount += 1;
    return `member-purchases-${label}-${emailCount}@example.com`;
  }

  /** Creates a member through the Admin API; `tiers` comps them. */
  async function createMember(label, tiers) {
    const email = nextEmail(label);
    const { body } = await adminAgent
      .post('/members/')
      .body({ members: [{ email, name: `Member ${label}`, ...(tiers ? { tiers } : {}) }] })
      .expectStatus(201);
    return body.members[0];
  }

  function grant(memberId, purchase, { query = '', status = 201 } = {}) {
    return adminAgent
      .post(`/members/${memberId}/purchases/${query}`)
      .body({ member_purchases: [{ tier_id: courseTier.id, ...purchase }] })
      .expectStatus(status);
  }

  function revoke(memberId, purchaseId, status = 204) {
    return adminAgent.delete(`/members/${memberId}/purchases/${purchaseId}/`).expectStatus(status);
  }

  function browse(memberId, status = 200) {
    return adminAgent.get(`/members/${memberId}/purchases/`).expectStatus(status);
  }

  async function memberStatus(memberId) {
    const member = await models.Member.findOne({ id: memberId }, { require: true });
    return member.get('status');
  }

  async function eventActions(memberId, tierId = courseTier.id) {
    return (await getProductEvents(memberId, tierId)).map((event) => event.action);
  }

  function errorOf(res) {
    return res.body.errors[0];
  }

  function sameSecond(actual, expected) {
    const ms = fromDatabaseDate(actual).getTime();
    assert.ok(
      Math.abs(ms - expected.getTime()) < 1000,
      `${actual} is not ${expected.toISOString()}`,
    );
  }

  beforeAll(async function () {
    ({ adminAgent, membersAgent } = await agentProvider.getAgentsForMembers());
    await fixtureManager.init('users', 'members');
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
      courseTier = await purchaseHelpers.createCourseTier(adminAgent);
    }
  });

  afterEach(async function () {
    await configUtils.restore();
    mockManager.restore();
  });

  describe('grant', function () {
    it('grants the course to a free member for nothing, with no Stripe ids', async function () {
      const member = await createMember('grant');

      const res = await grant(member.id, {})
        .matchBodySnapshot({
          member_purchases: [
            {
              id: anyObjectId,
              member_id: anyObjectId,
              tier: { id: anyObjectId },
              created_at: anyISODateTime,
              updated_at: anyISODateTime,
            },
          ],
        })
        .matchHeaderSnapshot({
          'content-version': anyContentVersion,
          'content-length': anyContentLength,
          etag: anyEtag,
          location: anyLocationFor('purchases'),
        });

      const view = res.body.member_purchases[0];
      assert.equal(view.member_id, member.id);
      assert.deepEqual(view.tier, {
        id: courseTier.id,
        name: courseTier.name,
        slug: courseTier.slug,
      });
      assert.equal(view.status, 'paid');
      assert.equal(view.source, 'manual');
      assert.equal(view.amount, 0);
      assert.equal(view.currency, 'usd');
      assert.match(
        res.headers.location,
        new RegExp(`/members/${member.id}/purchases/${view.id}/$`),
      );

      const [row] = await getPurchases({ id: view.id });
      assert.equal(row.status, 'paid');
      assert.equal(row.stripe_checkout_session_id, null);
      assert.equal(row.stripe_payment_intent_id, null);
      assert.equal(row.stripe_customer_id, null);

      const links = await getMemberProductRows(member.id);
      assert.deepEqual(
        links.map((link) => [link.product_id, link.expiry_at]),
        [[courseTier.id, null]],
      );
      assert.equal(await memberStatus(member.id), 'free');
      assert.deepEqual(await eventActions(member.id), ['added']);
    });

    it('backdates both the purchase and the access start', async function () {
      const member = await createMember('backdate');
      const startedAt = new Date(Math.floor((Date.now() - 30 * DAY) / 1000) * 1000);

      const res = await grant(member.id, {
        created_at: startedAt.toISOString(),
        amount: 4900,
        currency: 'USD',
      });

      const view = res.body.member_purchases[0];
      assert.equal(view.created_at, startedAt.toISOString());
      assert.equal(view.amount, 4900);
      assert.equal(view.currency, 'usd');

      const [row] = await getPurchases({ id: view.id });
      sameSecond(row.created_at, startedAt);

      const events = await getProductEvents(member.id, courseTier.id);
      assert.deepEqual(
        events.map((event) => event.action),
        ['added'],
      );
      sameSecond(events[0].created_at, startedAt);
    });

    it('takes a backdate with an offset as that instant', async function () {
      const member = await createMember('offset');

      const res = await grant(member.id, { created_at: '2024-03-01T09:30:00+01:00' });

      assert.equal(res.body.member_purchases[0].created_at, '2024-03-01T08:30:00.000Z');
    });

    it('refuses a grant over a comp on the same tier and leaves the comp alone', async function () {
      const expiry = new Date(Date.now() + 30 * DAY);
      const member = await createMember('comped', [
        { id: courseTier.id, expiry_at: expiry.toISOString() },
      ]);
      assert.equal(member.status, 'comped');
      const [compBefore] = await getMemberProductRows(member.id);

      const res = await grant(member.id, {}, { status: 422 });
      assert.equal(errorOf(res).code, 'PURCHASE_COMP_EXISTS');

      // A backdate over the comp is refused as well, by either rule
      const backdated = await grant(
        member.id,
        { created_at: new Date(Date.now() - 30 * DAY).toISOString() },
        { status: 422 },
      );
      assert.ok(
        ['PURCHASE_COMP_EXISTS', 'PURCHASE_BACKDATE_LINK_EXISTS'].includes(errorOf(backdated).code),
        errorOf(backdated).code,
      );

      assert.equal(await memberStatus(member.id), 'comped');
      assert.deepEqual(await getMemberProductRows(member.id), [compBefore]);
      assert.deepEqual(await getPurchases({ member_id: member.id }), []);
      assert.deepEqual(await eventActions(member.id), ['added']);
    });

    it('grants the course to a subscriber of the same tier, but never backdated', async function () {
      const email = nextEmail('subscriber');
      const { member } = await purchaseHelpers.createSubscriber(email, courseTier.slug);
      assert.deepEqual(await eventActions(member.id), ['added']);

      const backdated = await grant(
        member.id,
        { created_at: new Date(Date.now() - 30 * DAY).toISOString() },
        { status: 422 },
      );
      assert.equal(errorOf(backdated).code, 'PURCHASE_BACKDATE_LINK_EXISTS');
      assert.equal(errorOf(backdated).property, 'created_at');
      assert.deepEqual(await getPurchases({ member_id: member.id }), []);

      await grant(member.id, {});
      assert.equal((await getPurchases({ member_id: member.id })).length, 1);
      assert.equal(await memberStatus(member.id), 'paid');
      assert.deepEqual(await eventActions(member.id), ['added']);
    });

    it('refuses a date in the future, before 2000, or with no offset', async function () {
      const member = await createMember('dates');

      for (const createdAt of [
        new Date(Date.now() + DAY).toISOString(),
        '1999-12-31T23:59:59Z',
        '2024-03-01T00:00:00',
        'yesterday',
      ]) {
        const res = await grant(member.id, { created_at: createdAt }, { status: 422 });
        assert.equal(errorOf(res).type, 'ValidationError', createdAt);
      }

      assert.deepEqual(await getPurchases({ member_id: member.id }), []);
      assert.deepEqual(await getMemberProductRows(member.id), []);
    });

    it('refuses bad amounts and currencies', async function () {
      const member = await createMember('amounts');

      for (const purchase of [
        { amount: -1 },
        { amount: 1.5 },
        { amount: 2147483648 },
        { currency: 'dollars' },
      ]) {
        await grant(member.id, purchase, { status: 422 });
      }

      assert.deepEqual(await getPurchases({ member_id: member.id }), []);
    });

    it('refuses unknown, free, archived and subscription-only tiers', async function () {
      const member = await createMember('tiers');
      const freeProduct = await models.Product.findOne({ type: 'free' }, { require: true });
      const archived = await purchaseHelpers.createCourseTier(adminAgent, {
        name: 'Archived Course',
      });
      await tiersService.api.edit(archived.id, { status: 'archived' });

      for (const tierId of [UNKNOWN_ID, freeProduct.id, archived.id, libraryProduct.id]) {
        const res = await grant(member.id, { tier_id: tierId }, { status: 422 });
        assert.equal(errorOf(res).type, 'ValidationError', tierId);
      }

      assert.deepEqual(await getPurchases({ member_id: member.id }), []);
      assert.deepEqual(await getMemberProductRows(member.id), []);
    });

    it('refuses a second grant, and a grant to a buyer, of a course already owned', async function () {
      const member = await createMember('owned');
      await grant(member.id, {});

      const again = await grant(member.id, {}, { status: 422 });
      assert.equal(errorOf(again).code, 'PURCHASE_ALREADY_OWNED');
      assert.equal(errorOf(again).property, 'tier_id');

      const buyer = await purchaseHelpers.purchaseAsGuest(membersAgent, {
        tierId: courseTier.id,
        email: nextEmail('buyer'),
      });
      const overStripe = await grant(buyer.member.id, {}, { status: 422 });
      assert.equal(errorOf(overStripe).code, 'PURCHASE_ALREADY_OWNED');

      assert.equal((await getPurchases({ member_id: member.id })).length, 1);
      assert.equal((await getPurchases({ member_id: buyer.member.id })).length, 1);
    });

    it('drops fields a grant cannot set', async function () {
      const member = await createMember('stripped');

      const res = await grant(member.id, {
        status: 'refunded',
        member_id: UNKNOWN_ID,
        stripe_payment_intent_id: 'pi_injected',
        stripe_checkout_session_id: 'cs_injected',
        stripe_customer_id: 'cus_injected',
      });

      const view = res.body.member_purchases[0];
      assert.equal(view.status, 'paid');
      assert.equal(view.source, 'manual');
      assert.equal(view.member_id, member.id);
      assert.equal(view.stripe_payment_intent_id, null);
      assert.equal(view.stripe_checkout_session_id, null);
      assert.equal(view.stripe_customer_id, null);
    });

    it('refuses a body without the root key, or with two purchases', async function () {
      const member = await createMember('envelope');

      await adminAgent
        .post(`/members/${member.id}/purchases/`)
        .body({ purchases: [{ tier_id: courseTier.id }] })
        .expectStatus(400);

      await adminAgent
        .post(`/members/${member.id}/purchases/`)
        .body({ member_purchases: [{ tier_id: courseTier.id }, { tier_id: courseTier.id }] })
        .expectStatus(422);

      assert.deepEqual(await getPurchases({ member_id: member.id }), []);
    });

    it('answers 404 for an unknown member', async function () {
      await grant(UNKNOWN_ID, {}, { status: 404 });
      assert.deepEqual(await getPurchases({ member_id: UNKNOWN_ID }), []);
    });

    it('emails the member only when send_email is true, and never the staff', async function () {
      await grant((await createMember('quiet')).id, {});
      await grant((await createMember('not-true')).id, {}, { query: '?send_email=1' });
      assert.deepEqual(
        sentEmails().filter((mail) => /access to/i.test(mail.subject ?? '')),
        [],
      );

      const told = await createMember('told');
      await grant(told.id, {}, { query: '?send_email=true' });

      const mails = sentEmails().filter((mail) => mail.to === told.email);
      assert.equal(mails.length, 1);
      assert.match(mails[0].subject, /^You've been given access to /);
      assert.ok(mails[0].subject.includes(courseTier.name));
      assert.doesNotMatch(mails[0].html ?? '', /thank you for your purchase/i);
      assert.deepEqual(staffPurchaseEmails(), []);
    });

    it('grants without the access email while email verification is required', async function () {
      const verification = sinon
        .stub(membersService.verificationTrigger, 'checkVerificationRequired')
        .resolves(true);
      try {
        const member = await createMember('unverified-site');
        await grant(member.id, {}, { query: '?send_email=true' });

        sinon.assert.called(verification);
        assert.equal((await getPurchases({ member_id: member.id })).length, 1);
        assert.deepEqual(
          sentEmails().filter((mail) => mail.to === member.email),
          [],
        );
      } finally {
        verification.restore();
      }
    });
  });

  describe('browse', function () {
    it('lists every purchase of the member, newest first', async function () {
      const email = nextEmail('history');
      const { member, paymentIntent } = await purchaseHelpers.purchaseAsGuest(membersAgent, {
        tierId: courseTier.id,
        email,
      });
      await sendRefund(paymentIntent);

      const first = (await grant(member.id, {})).body.member_purchases[0];
      await revoke(member.id, first.id);
      const second = (await grant(member.id, {})).body.member_purchases[0];

      const { body } = await browse(member.id);

      assert.deepEqual(
        body.member_purchases.map((p) => [p.status, p.source]),
        [
          ['paid', 'manual'],
          ['revoked', 'manual'],
          ['refunded', 'stripe'],
        ],
      );
      assert.equal(body.member_purchases[0].id, second.id);
      assert.equal(body.member_purchases[1].id, first.id);
      assert.ok(body.member_purchases[1].revoked_at);
      assert.ok(body.member_purchases[2].refunded_at);
      assert.equal(body.member_purchases[2].stripe_payment_intent_id, paymentIntent);
      assert.ok(body.member_purchases.every((p) => p.member_id === member.id));
      assert.ok(body.member_purchases.every((p) => p.tier.id === courseTier.id));
    });

    it('returns an empty list for a member with no purchases', async function () {
      const member = await createMember('none');

      await browse(member.id).matchBodySnapshot();
    });

    it('answers 404 for an unknown member', async function () {
      await browse(UNKNOWN_ID, 404);
    });
  });

  describe('revoke', function () {
    it('revokes a staff grant: row kept as revoked, link and access removed', async function () {
      const member = await createMember('revoke');
      const view = (await grant(member.id, {})).body.member_purchases[0];

      await revoke(member.id, view.id);

      const [row] = await getPurchases({ id: view.id });
      assert.equal(row.status, 'revoked');
      assert.ok(row.revoked_at);
      assert.equal(row.refunded_at, null);
      assert.deepEqual(await getMemberProductRows(member.id), []);
      assert.deepEqual(await eventActions(member.id), ['added', 'removed']);
      assert.equal(await memberStatus(member.id), 'free');

      // Idempotent: a repeat is a no-op
      await revoke(member.id, view.id);
      assert.deepEqual(await eventActions(member.id), ['added', 'removed']);
      const [again] = await getPurchases({ id: view.id });
      assert.equal(again.status, 'revoked');
    });

    it('revokes a Stripe purchase, which a refund or a redelivery never undoes', async function () {
      const email = nextEmail('stripe-revoke');
      const customer = `cus_${email.replace(/\W/g, '')}`;
      const { member, paymentIntent, checkoutSession } = await purchaseHelpers.purchaseAsGuest(
        membersAgent,
        { tierId: courseTier.id, email, customer },
      );
      const [purchase] = await getPurchases({ stripe_payment_intent_id: paymentIntent });

      await revoke(member.id, purchase.id);
      assert.deepEqual(await getMemberProductRows(member.id), []);

      // A redelivered checkout.session.completed does not grant again
      await sendWebhook(buildCompletedEvent(checkoutSession, { email, customer, paymentIntent }));
      assert.deepEqual(await getMemberProductRows(member.id), []);
      assert.equal((await getPurchases({ member_id: member.id })).length, 1);

      // The later refund is recorded, and keeps the revoke date
      await sendRefund(paymentIntent);
      const [refunded] = await getPurchases({ id: purchase.id });
      assert.equal(refunded.status, 'refunded');
      assert.ok(refunded.refunded_at);
      assert.ok(refunded.revoked_at);
      assert.deepEqual(await getMemberProductRows(member.id), []);
      assert.deepEqual(await eventActions(member.id), ['added', 'removed']);
    });

    it('keeps a comp given after the revoke when the old payment is refunded', async function () {
      const email = nextEmail('revoke-comp-refund');
      const { member, paymentIntent } = await purchaseHelpers.purchaseAsGuest(membersAgent, {
        tierId: courseTier.id,
        email,
      });
      const [purchase] = await getPurchases({ stripe_payment_intent_id: paymentIntent });
      await revoke(member.id, purchase.id);

      await adminAgent
        .put(`/members/${member.id}/`)
        .body({ members: [{ id: member.id, email, tiers: [{ id: courseTier.id }] }] })
        .expectStatus(200);
      assert.equal(await memberStatus(member.id), 'comped');

      await sendRefund(paymentIntent);

      const [refunded] = await getPurchases({ id: purchase.id });
      assert.equal(refunded.status, 'refunded');
      assert.deepEqual(
        (await getMemberProductRows(member.id)).map((link) => link.product_id),
        [courseTier.id],
      );
      assert.equal(await memberStatus(member.id), 'comped');
    });

    it('keeps the link while a subscription still grants the tier', async function () {
      const email = nextEmail('revoke-subscriber');
      const { member } = await purchaseHelpers.createSubscriber(email, courseTier.slug);
      const view = (await grant(member.id, {})).body.member_purchases[0];

      await revoke(member.id, view.id);

      const [row] = await getPurchases({ id: view.id });
      assert.equal(row.status, 'revoked');
      assert.deepEqual(
        (await getMemberProductRows(member.id)).map((link) => link.product_id),
        [courseTier.id],
      );
      assert.equal(await memberStatus(member.id), 'paid');
    });

    it("answers 404 for another member's purchase or an unknown one, 422 for a malformed id", async function () {
      const owner = await createMember('revoke-owner');
      const other = await createMember('revoke-other');
      const view = (await grant(owner.id, {})).body.member_purchases[0];

      await revoke(other.id, view.id, 404);
      await revoke(owner.id, UNKNOWN_ID, 404);
      await revoke(UNKNOWN_ID, view.id, 404);
      const malformed = await revoke(owner.id, 'not-a-purchase', 422);
      assert.equal(errorOf(malformed).property, 'purchase_id');

      const [row] = await getPurchases({ id: view.id });
      assert.equal(row.status, 'paid');
      assert.deepEqual(
        (await getMemberProductRows(owner.id)).map((link) => link.product_id),
        [courseTier.id],
      );
    });
  });

  describe('permissions', function () {
    let member;
    let purchase;

    beforeEach(async function () {
      member = await createMember('permissions');
      purchase = (await grant(member.id, {})).body.member_purchases[0];
    });

    afterEach(async function () {
      // A staff token carries no integration id, which the audit log refuses
      // for member writes, so the owner signs in again (past the login limiter).
      await resetRateLimits();
      await adminAgent.loginAsOwner();
    });

    /** Signs in with `useAuth` (after creating the target as the owner) and calls all three routes. */
    async function expectAll(useAuth, status) {
      const target = await createMember('permissions-target');
      await useAuth();

      await browse(member.id, status.browse);
      await grant(target.id, {}, { status: status.add });
      await revoke(member.id, purchase.id, status.destroy);

      return target;
    }

    it('refuses editors and contributors', async function () {
      const target = await createMember('permissions-target');

      for (const role of ['editor', 'contributor']) {
        await adminAgent.useStaffTokenFor(role);
        await browse(member.id, 403);
        await grant(target.id, {}, { status: 403 });
        await revoke(member.id, purchase.id, 403);
      }

      const [row] = await getPurchases({ id: purchase.id });
      assert.equal(row.status, 'paid');
      assert.deepEqual(await getPurchases({ member_id: target.id }), []);
    });

    it('refuses the self-serve migration integration, which can only add members', async function () {
      const target = await createMember('permissions-migration');
      await adminAgent.useSelfServeMigrationAdminAPIKey();

      await browse(member.id, 403);
      await grant(target.id, {}, { status: 403 });
      await revoke(member.id, purchase.id, 403);
    });

    it('allows an Admin integration key', async function () {
      const target = await expectAll(() => adminAgent.useZapierAdminAPIKey(), {
        browse: 200,
        add: 201,
        destroy: 204,
      });

      assert.equal((await getPurchases({ member_id: target.id }))[0].status, 'paid');
      assert.equal((await getPurchases({ id: purchase.id }))[0].status, 'revoked');
    });

    it('allows a Super Editor', async function () {
      const target = await expectAll(() => adminAgent.useStaffTokenFor('superEditor'), {
        browse: 200,
        add: 201,
        destroy: 204,
      });

      assert.equal((await getPurchases({ member_id: target.id }))[0].status, 'paid');
      assert.equal((await getPurchases({ id: purchase.id }))[0].status, 'revoked');
    });
  });
});
