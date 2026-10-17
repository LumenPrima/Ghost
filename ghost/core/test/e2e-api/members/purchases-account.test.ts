// fork(salvare): a member's own one-time purchases (`GET /members/api/purchases/`), end to end against the database.
import assert from 'node:assert/strict';

const {
  agentProvider,
  mockManager,
  fixtureManager,
  configUtils,
} = require('../../utils/e2e-framework');
const purchaseHelpers = require('../../utils/purchase-helpers');

const { getPurchases, sendRefund } = purchaseHelpers;

describe('Members API purchases', function () {
  let adminAgent: any;
  let membersAgent: any;
  let anonAgent: any;
  let courseA: any;
  let courseB: any;
  let courseC: any;
  let emailCount = 0;

  function nextEmail(label: string): string {
    emailCount += 1;
    return `purchases-account-${label}-${emailCount}@example.com`;
  }

  async function createMember(label: string): Promise<any> {
    const { body } = await adminAgent
      .post('/members/')
      .body({ members: [{ email: nextEmail(label), name: `Member ${label}` }] })
      .expectStatus(201);
    return body.members[0];
  }

  async function grant(memberId: string, tierId: string): Promise<any> {
    const { body } = await adminAgent
      .post(`/members/${memberId}/purchases/`)
      .body({ member_purchases: [{ tier_id: tierId }] })
      .expectStatus(201);
    return body.member_purchases[0];
  }

  async function signedIn(email: string): Promise<any> {
    const agent = membersAgent.duplicate();
    await agent.loginAs(email);
    return agent;
  }

  async function purchasesOf(agent: any): Promise<any[]> {
    const res = await agent.get('/api/purchases/').expectStatus(200);
    assert.match(res.headers['cache-control'], /private/);
    return res.body.purchases;
  }

  beforeAll(async function () {
    ({ adminAgent, membersAgent } = await agentProvider.getAgentsForMembers());
    anonAgent = membersAgent.duplicate();
    await fixtureManager.init('members');
    await adminAgent.loginAsOwner();
  });

  beforeEach(async function () {
    mockManager.mockStripe();
    mockManager.mockMail();

    if (!courseA) {
      courseA = await purchaseHelpers.createCourseTier(adminAgent, {
        name: 'Account Course A',
        welcome_page_url: '/welcome-course-a/',
      });
      courseB = await purchaseHelpers.createCourseTier(adminAgent, { name: 'Account Course B' });
      courseC = await purchaseHelpers.createCourseTier(adminAgent, { name: 'Account Course C' });
    }
  });

  afterEach(async function () {
    await configUtils.restore();
    mockManager.restore();
  });

  it('refuses a signed-out caller with 401', async function () {
    const res = await anonAgent.get('/api/purchases/').expectStatus(401);
    assert.match(res.body.errors[0].message, /you must be signed in/i);
  });

  it('returns an empty list for a member with no purchases', async function () {
    const member = await createMember('empty');

    assert.deepEqual(await purchasesOf(await signedIn(member.email)), []);
  });

  it('lists only active purchases, newest first, with no Stripe or staff fields', async function () {
    const email = nextEmail('buyer');
    const { member } = await purchaseHelpers.purchaseAsGuest(membersAgent, {
      tierId: courseA.id,
      email,
    });
    const [stripePurchase] = await getPurchases({ member_id: member.id });

    // A revoked grant is left out
    const revoked = await grant(member.id, courseB.id);
    await adminAgent.delete(`/members/${member.id}/purchases/${revoked.id}/`).expectStatus(204);

    const granted = await grant(member.id, courseC.id);

    const res = await (await signedIn(email)).get('/api/purchases/').expectStatus(200);
    const purchases = res.body.purchases;

    assert.deepEqual(
      purchases.map((p: any) => p.id),
      [granted.id, stripePurchase.id],
    );
    for (const purchase of purchases) {
      assert.deepEqual(Object.keys(purchase).sort(), [
        'amount',
        'currency',
        'id',
        'purchased_at',
        'tier',
      ]);
      assert.deepEqual(Object.keys(purchase.tier).sort(), [
        'id',
        'name',
        'slug',
        'welcome_page_url',
      ]);
      assert.match(purchase.purchased_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    }
    assert.doesNotMatch(JSON.stringify(res.body), /stripe|pi_purchase|cus_purchase|cs_/i);

    const [manual, paid] = purchases;
    assert.deepEqual(manual.tier, {
      id: courseC.id,
      name: courseC.name,
      slug: courseC.slug,
      welcome_page_url: null,
    });
    assert.equal(manual.amount, 0);

    assert.equal(paid.tier.id, courseA.id);
    assert.equal(paid.tier.welcome_page_url, courseA.welcome_page_url);
    assert.ok(paid.tier.welcome_page_url, 'expected the course welcome page');
    assert.equal(paid.amount, purchaseHelpers.COURSE_PRICE);
    assert.equal(paid.currency, 'usd');
  });

  it('leaves out a refunded purchase, and never shows another member any rows', async function () {
    const email = nextEmail('refunded');
    const { member, paymentIntent } = await purchaseHelpers.purchaseAsGuest(membersAgent, {
      tierId: courseA.id,
      email,
    });
    await sendRefund(paymentIntent);
    assert.equal((await getPurchases({ member_id: member.id }))[0].status, 'refunded');

    assert.deepEqual(await purchasesOf(await signedIn(email)), []);

    const owner = await createMember('owner');
    await grant(owner.id, courseB.id);
    const bystander = await createMember('bystander');

    assert.deepEqual(await purchasesOf(await signedIn(bystander.email)), []);
    assert.equal((await purchasesOf(await signedIn(owner.email))).length, 1);
  });
});
