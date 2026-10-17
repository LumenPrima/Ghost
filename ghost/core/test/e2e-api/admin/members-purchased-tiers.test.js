// fork(salvare): purchased tiers in the member read paths (Phase 4 BREAD fix and entitlements).
// A tier bought outright is not a comp: it gets no synthetic "Complimentary" row, so Admin
// offers no Remove action that would do nothing, and it still counts as an entitlement.
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { agentProvider, mockManager, fixtureManager } = require('../../utils/e2e-framework');
const models = require('../../../core/server/models');
const membersService = require('../../../core/server/services/members');
const purchaseHelpers = require('../../utils/purchase-helpers');

let agent;
let courseTier; // Admin API JSON of the purchase-only tier
let libraryTier; // the fixture's paid tier, used for comps

// A paid checkout fulfilled through the webhook. The session only needs the
// server-set tier marker, so no members API agent is needed.
async function purchaseByWebhook(email) {
  const n = purchaseHelpers.next();
  const checkoutSession = {
    id: `cs_bread_${n}`,
    customer: null,
    metadata: { ghost_purchase_tier_id: courseTier.id },
  };
  await purchaseHelpers.sendWebhook(
    purchaseHelpers.buildCompletedEvent(checkoutSession, {
      email,
      customer: `cus_bread_${n}`,
      paymentIntent: `pi_bread_${n}`,
    }),
  );
}

async function createCompedMember(email) {
  const { body } = await agent
    .post('/members/')
    .body({ members: [{ email, tiers: [{ id: libraryTier.id }] }] })
    .expectStatus(201);
  assert.equal(body.members[0].status, 'comped');
  return body.members[0];
}

// A member comped on the library tier who then bought the course
async function createCompedPurchaser(email) {
  const comped = await createCompedMember(email);
  await purchaseByWebhook(email);
  return comped;
}

async function readMember(id) {
  const { body } = await agent.get(`/members/${id}/`).expectStatus(200);
  return body.members[0];
}

function tierIds(member) {
  return member.tiers.map((tier) => tier.id).sort();
}

function subscriptionRows(member) {
  return member.subscriptions.map((sub) => [sub.tier.id, sub.plan.nickname]);
}

async function entitlementTierIds(memberId) {
  const member = await models.Member.findOne({ id: memberId }, { require: true });
  const token = await membersService.api.getMemberEntitlementToken(member.get('transient_id'));
  return jwt.decode(token).active_tier_ids.sort();
}

describe('Members with purchased tiers', function () {
  beforeAll(async function () {
    agent = await agentProvider.getAdminAPIAgent();
    await fixtureManager.init('members');
    await agent.loginAsOwner();

    const library = await models.Product.findOne(
      { type: 'paid', slug: 'default-product' },
      { require: true },
    );
    libraryTier = { id: library.id };
  });

  beforeEach(async function () {
    mockManager.mockStripe();
    mockManager.mockMail();

    if (!courseTier) {
      courseTier = await purchaseHelpers.createCourseTier(agent);
    }
  });

  afterEach(function () {
    mockManager.restore();
  });

  it('shows no Complimentary row for a comped member’s purchased tier', async function () {
    const comped = await createCompedPurchaser('bread-comped-purchaser@example.com');

    const member = await readMember(comped.id);

    assert.equal(member.status, 'comped');
    assert.deepEqual(tierIds(member), [courseTier.id, libraryTier.id].sort());
    assert.deepEqual(subscriptionRows(member), [[libraryTier.id, 'Complimentary']]);
  });

  it('shows the same rows when members are browsed', async function () {
    await createCompedPurchaser('bread-browsed-purchaser@example.com');

    const { body } = await agent
      .get(`/members/?filter=${encodeURIComponent("email:'bread-browsed-purchaser@example.com'")}`)
      .expectStatus(200);

    assert.equal(body.members.length, 1);
    assert.deepEqual(subscriptionRows(body.members[0]), [[libraryTier.id, 'Complimentary']]);
  });

  it('keeps a purchased tier linked when an edit leaves it out', async function () {
    const comped = await createCompedMember('bread-stale-form@example.com');
    await purchaseByWebhook('bread-stale-form@example.com');

    // What Admin sends after "Remove" on the comp row: the remaining tiers, which never
    // include the purchased one because it has no row
    const { body } = await agent
      .put(`/members/${comped.id}/`)
      .body({ members: [{ id: comped.id, email: comped.email, tiers: [] }] })
      .expectStatus(200);

    const member = body.members[0];
    assert.equal(member.status, 'free');
    assert.deepEqual(tierIds(member), [courseTier.id]);
    assert.deepEqual(member.subscriptions, []);
  });

  it('includes the purchased tier in a comped member’s entitlements', async function () {
    const comped = await createCompedPurchaser('bread-entitled-purchaser@example.com');

    assert.deepEqual(await entitlementTierIds(comped.id), [courseTier.id, libraryTier.id].sort());
  });
});
