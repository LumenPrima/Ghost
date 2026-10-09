// fork(salvare): lesson progress (members_post_progress) through the members API, end to end against the database.
import assert from 'node:assert/strict';

const {
  agentProvider,
  mockManager,
  fixtureManager,
  configUtils,
} = require('../../utils/e2e-framework');
const db = require('../../../core/server/data/db');
const drip = require('../../../core/server/services/drip');
const membersService = require('../../../core/server/services/members');
const { toDatabaseDate } = require('../../../core/server/lib/db-types/date');

const DAY = 24 * 60 * 60 * 1000;
const UNKNOWN_ID = '0123456789abcdef01234567';

async function waitFor(fn: () => boolean | Promise<boolean>, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) {
      return true;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  }
  return false;
}

async function progressRows(memberId: string): Promise<any[]> {
  return db.knex('members_post_progress').where({ member_id: memberId }).orderBy('post_id');
}

/** Moves the member's `added` event(s) for a tier to `date`, as Phase 4's Thinkific backfill will. */
async function backdateAdded(memberId: string, productId: string, date: Date): Promise<void> {
  const updated = await db
    .knex('members_product_events')
    .where({ member_id: memberId, product_id: productId, action: 'added' })
    .update({ created_at: toDatabaseDate(date) });
  assert.ok(updated > 0, 'expected an added product event to backdate');
}

describe('Members API lesson progress', function () {
  let adminAgent: any;
  let membersAgent: any;
  let anonAgent: any;
  let tier: any;
  let publicPost: any;
  let membersPost: any;
  let tierPost: any;
  let dripPost: any;
  let courseA: any;
  let courseB: any;
  let draftPost: any;
  let page: any;
  let member: any;

  async function createPost(data: Record<string, unknown>, resource = 'posts'): Promise<any> {
    const res = await adminAgent.post(`${resource}/`).body({
      [resource]: [{ status: 'published', lexical: null, ...data }],
    });
    assert.equal(res.statusCode, 201, JSON.stringify(res.body));
    return res.body[resource][0];
  }

  async function memberByEmail(email: string): Promise<any> {
    const { body } = await adminAgent.get(`members/?filter=email:'${email}'`);
    assert.equal(body.members.length, 1, `member ${email} not found`);
    return body.members[0];
  }

  async function comp(memberId: string, tierId: string): Promise<void> {
    const res = await adminAgent
      .put(`members/${memberId}/`)
      .body({ members: [{ tiers: [{ id: tierId }] }] });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  }

  async function put(agent: any, items: unknown, status: number): Promise<any> {
    return agent.put('/api/progress/').body({ progress: items }).expectStatus(status);
  }

  beforeAll(async function () {
    ({ adminAgent, membersAgent } = await agentProvider.getAgentsForMembers());
    anonAgent = membersAgent.duplicate();
    await fixtureManager.init('posts', 'members');
    await adminAgent.loginAsOwner();

    const { body: tiersBody } = await adminAgent.get('tiers/?filter=type:paid&limit=1');
    tier = tiersBody.tiers[0];

    publicPost = await createPost({ title: 'Progress public', visibility: 'public' });
    membersPost = await createPost({ title: 'Progress members', visibility: 'members' });
    tierPost = await createPost({
      title: 'Progress tier lesson',
      visibility: 'tiers',
      tiers: [{ id: tier.id }],
    });
    dripPost = await createPost({
      title: 'Progress drip lesson',
      visibility: 'tiers',
      tiers: [{ id: tier.id }],
      tags: [{ name: '#drip-3' }],
    });
    courseA = await createPost({
      title: 'Course X lesson A',
      visibility: 'public',
      tags: [{ name: '#course-x' }],
    });
    courseB = await createPost({
      title: 'Course X lesson B',
      visibility: 'public',
      tags: [{ name: '#course-x' }],
    });
    draftPost = await createPost({ title: 'Progress draft', status: 'draft' });
    page = await createPost({ title: 'Progress page', visibility: 'public' }, 'pages');

    assert.ok(
      await waitFor(() => drip.getDripDays(dripPost.id) === 3),
      'the drip index never picked up the #drip-3 post',
    );

    await membersAgent.loginAs('progress-member@example.com');
    member = await memberByEmail('progress-member@example.com');
  });

  beforeEach(function () {
    mockManager.mockMail();
  });

  afterEach(async function () {
    await configUtils.restore();
    mockManager.restore();
  });

  describe('signed out', function () {
    it('refuses GET and PUT with 401', async function () {
      const get = await anonAgent.get(`/api/progress/?post_id=${publicPost.id}`).expectStatus(401);
      assert.match(get.body.errors[0].message, /you must be signed in/i);

      const res = await put(anonAgent, [{ post_id: publicPost.id, status: 'started' }], 401);
      assert.match(res.body.errors[0].message, /you must be signed in/i);
    });
  });

  describe('reading and writing', function () {
    it('returns an empty list for a post with no row', async function () {
      const { body } = await membersAgent
        .get(`/api/progress/?post_id=${publicPost.id}`)
        .expectStatus(200);
      assert.deepEqual(body, { progress: [] });
    });

    it('records started, then completed, then an un-tick, on one row', async function () {
      const started = await put(membersAgent, [{ post_id: publicPost.id, status: 'started' }], 200);
      assert.equal(started.body.progress.length, 1);
      const [row] = started.body.progress;
      assert.deepEqual(Object.keys(row).sort(), ['post_id', 'status', 'updated_at']);
      assert.equal(row.post_id, publicPost.id);
      assert.equal(row.status, 'started');
      assert.match(row.updated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

      const read = await membersAgent
        .get(`/api/progress/?post_id=${publicPost.id}`)
        .expectStatus(200);
      assert.deepEqual(read.body.progress, started.body.progress);

      const [before] = await db
        .knex('members_post_progress')
        .where({ member_id: member.id, post_id: publicPost.id });

      // created_at and updated_at have one-second resolution in MySQL
      await new Promise((resolve) => {
        setTimeout(resolve, 1100);
      });

      const completed = await put(
        membersAgent,
        [{ post_id: publicPost.id, status: 'completed' }],
        200,
      );
      assert.equal(completed.body.progress[0].status, 'completed');

      let rows = await db
        .knex('members_post_progress')
        .where({ member_id: member.id, post_id: publicPost.id });
      assert.equal(rows.length, 1, 'an upsert, not a second row');
      assert.equal(rows[0].id, before.id);
      assert.equal(rows[0].status, 'completed');
      assert.equal(new Date(rows[0].created_at).getTime(), new Date(before.created_at).getTime());
      assert.ok(new Date(rows[0].updated_at).getTime() > new Date(before.updated_at).getTime());

      const unticked = await put(
        membersAgent,
        [{ post_id: publicPost.id, status: 'started' }],
        200,
      );
      assert.equal(unticked.body.progress[0].status, 'started');
      rows = await db
        .knex('members_post_progress')
        .where({ member_id: member.id, post_id: publicPost.id });
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, 'started');
    });

    it('accepts the post alias, and post together with post_id when they agree', async function () {
      await put(membersAgent, [{ post_id: membersPost.id, status: 'completed' }], 200);

      const alias = await membersAgent
        .get(`/api/progress/?post=${membersPost.id}`)
        .expectStatus(200);
      assert.deepEqual(
        alias.body.progress.map((r: any) => [r.post_id, r.status]),
        [[membersPost.id, 'completed']],
      );

      const both = await membersAgent
        .get(`/api/progress/?post=${membersPost.id}&post_id=${membersPost.id}`)
        .expectStatus(200);
      assert.equal(both.body.progress.length, 1);

      await membersAgent
        .get(`/api/progress/?post=${membersPost.id}&post_id=${publicPost.id}`)
        .expectStatus(422);
    });

    it('lowercases ids and lets the last entry for a post win', async function () {
      const res = await put(
        membersAgent,
        [
          { post_id: courseA.id.toUpperCase(), status: 'completed' },
          { post_id: courseA.id, status: 'started' },
        ],
        200,
      );
      assert.deepEqual(
        res.body.progress.map((r: any) => [r.post_id, r.status]),
        [[courseA.id, 'started']],
      );

      const rows = await db
        .knex('members_post_progress')
        .where({ member_id: member.id, post_id: courseA.id });
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, 'started');
    });

    it('returns every row for a course tag, and only those', async function () {
      await put(
        membersAgent,
        [
          { post_id: courseA.id, status: 'completed' },
          { post_id: courseB.id, status: 'started' },
        ],
        200,
      );

      const { body } = await membersAgent.get('/api/progress/?tag=hash-course-x').expectStatus(200);
      assert.deepEqual(
        body.progress.map((r: any) => [r.post_id, r.status]).sort(),
        [
          [courseA.id, 'completed'],
          [courseB.id, 'started'],
        ].sort(),
      );

      const none = await membersAgent.get('/api/progress/?tag=hash-no-such-tag').expectStatus(200);
      assert.deepEqual(none.body.progress, []);
    });

    it("never shows one member another member's rows", async function () {
      // Its own row, so the test also passes when run alone
      await put(membersAgent, [{ post_id: courseA.id, status: 'completed' }], 200);

      const other = membersAgent.duplicate();
      await other.loginAs('progress-other@example.com');

      const byPost = await other.get(`/api/progress/?post_id=${publicPost.id}`).expectStatus(200);
      assert.deepEqual(byPost.body.progress, []);
      const byTag = await other.get('/api/progress/?tag=hash-course-x').expectStatus(200);
      assert.deepEqual(byTag.body.progress, []);

      // Writing their own row leaves the first member's untouched
      await put(other, [{ post_id: courseA.id, status: 'started' }], 200);
      const mine = await membersAgent.get(`/api/progress/?post_id=${courseA.id}`).expectStatus(200);
      assert.equal(mine.body.progress[0].status, 'completed');
    });
  });

  describe('validation', function () {
    it('refuses malformed queries with 422', async function () {
      await membersAgent.get('/api/progress/').expectStatus(422);
      await membersAgent
        .get(`/api/progress/?post_id=${publicPost.id}&tag=hash-course-x`)
        .expectStatus(422);
      await membersAgent.get('/api/progress/?post_id=not-an-id').expectStatus(422);
    });

    it('refuses malformed bodies with 422 and writes nothing', async function () {
      const before = (await progressRows(member.id)).length;
      const ok = { post_id: publicPost.id, status: 'completed' };

      const invalid: unknown[] = [
        {},
        { progress: [] },
        { progress: Array.from({ length: 101 }, () => ok) },
        { progress: [{ post_id: publicPost.id, status: 'done' }] },
        { progress: [{ post_id: 'not-an-id', status: 'started' }] },
        { progress: [{ ...ok, extra: true }] },
        { progress: [ok], extra: true },
        { progress: ok },
        [ok],
      ];

      for (const body of invalid) {
        const res = await membersAgent.put('/api/progress/').body(body);
        assert.equal(res.statusCode, 422, `expected 422 for ${JSON.stringify(body)}`);
      }

      assert.equal((await progressRows(member.id)).length, before);
    });

    it('refuses a text/plain body with 422 and malformed JSON with 400', async function () {
      const plain = await membersAgent
        .put('/api/progress/')
        .header('Content-Type', 'text/plain')
        .body(JSON.stringify({ progress: [{ post_id: publicPost.id, status: 'started' }] }));
      assert.equal(plain.statusCode, 422);

      const malformed = await membersAgent
        .put('/api/progress/')
        .header('Content-Type', 'application/json')
        .body('{"progress": [');
      assert.equal(malformed.statusCode, 400);
    });
  });

  describe('access', function () {
    it('refuses unknown, draft and page ids with 404, all or nothing', async function () {
      for (const id of [UNKNOWN_ID, draftPost.id, page.id]) {
        const res = await put(membersAgent, [{ post_id: id, status: 'started' }], 404);
        assert.equal(res.body.errors[0].code, 'POST_NOT_FOUND');
      }

      const before = await progressRows(member.id);
      await put(
        membersAgent,
        [
          { post_id: courseB.id, status: 'completed' },
          { post_id: draftPost.id, status: 'completed' },
        ],
        404,
      );
      assert.deepEqual(
        await progressRows(member.id),
        before,
        'nothing written for a refused batch',
      );
    });

    it('prefers 404 over 403 in a batch with a missing and a locked post', async function () {
      const res = await put(
        membersAgent,
        [
          { post_id: tierPost.id, status: 'started' },
          { post_id: UNKNOWN_ID, status: 'started' },
        ],
        404,
      );
      assert.equal(res.body.errors[0].code, 'POST_NOT_FOUND');
    });

    it('refuses a tier-gated post with 403 until the member holds the tier', async function () {
      const locked = await put(membersAgent, [{ post_id: tierPost.id, status: 'started' }], 403);
      assert.equal(locked.body.errors[0].code, 'POST_LOCKED');
      assert.equal(locked.body.errors[0].message, "You don't have access to this lesson.");

      // A refused batch writes nothing, even for the open post in it
      const before = await progressRows(member.id);
      await put(
        membersAgent,
        [
          { post_id: courseB.id, status: 'completed' },
          { post_id: tierPost.id, status: 'started' },
        ],
        403,
      );
      assert.deepEqual(await progressRows(member.id), before);

      await comp(member.id, tier.id);
      const res = await put(membersAgent, [{ post_id: tierPost.id, status: 'started' }], 200);
      assert.equal(res.body.progress[0].post_id, tierPost.id);
    });
  });

  describe('drip', function () {
    const body = () => [{ post_id: dripPost.id, status: 'started' }];

    // Its own setup, so the block passes when run alone (-t drip): the member holds
    // the tier through a comp whose `added` event is fresh.
    beforeAll(async function () {
      await comp(member.id, tier.id);
      await backdateAdded(member.id, tier.id, new Date());
    });

    it('locks a fresh comp out of a #drip-3 lesson in enforce mode', async function () {
      configUtils.set('salvare:drip:mode', 'enforce');
      const res = await put(membersAgent, body(), 403);
      assert.equal(res.body.errors[0].code, 'POST_LOCKED');

      // Non-dripped tier lesson stays open
      await put(membersAgent, [{ post_id: tierPost.id, status: 'completed' }], 200);
    });

    it('lets it through in advise and off modes', async function () {
      configUtils.set('salvare:drip:mode', 'advise');
      await put(membersAgent, body(), 200);

      configUtils.set('salvare:drip:mode', 'off');
      await put(membersAgent, [{ post_id: dripPost.id, status: 'completed' }], 200);
    });

    it('defaults to advise when the mode is unset', async function () {
      assert.equal(drip.getMode(), 'advise');
      await put(membersAgent, body(), 200);
    });

    it('opens once the access start is far enough back', async function () {
      configUtils.set('salvare:drip:mode', 'enforce');
      await backdateAdded(member.id, tier.id, new Date(Date.now() - 4 * DAY));
      const res = await put(membersAgent, [{ post_id: dripPost.id, status: 'completed' }], 200);
      assert.equal(res.body.progress[0].status, 'completed');
    });

    it('opens at once for a purchase-only member whose purchase is backdated', async function () {
      configUtils.set('salvare:drip:mode', 'enforce');
      const agent = membersAgent.duplicate();
      await agent.loginAs('progress-buyer@example.com');
      const buyer = await memberByEmail('progress-buyer@example.com');

      // The purchase grant: a lifetime link plus an `added` event, status left free
      await membersService.api.members.grantPurchasedProduct({
        memberId: buyer.id,
        productId: tier.id,
      });
      const [link] = await db
        .knex('members_products')
        .where({ member_id: buyer.id, product_id: tier.id });
      assert.ok(link, 'the purchase grant links the tier');
      assert.equal((await memberByEmail('progress-buyer@example.com')).status, 'free');

      const res = await put(agent, body(), 403);
      assert.equal(res.body.errors[0].code, 'POST_LOCKED');

      await backdateAdded(buyer.id, tier.id, new Date(Date.now() - 10 * DAY));
      await put(agent, body(), 200);
    });
  });

  describe('drip index reload on admin edits', function () {
    // The reload hooks the real model events (post.tag.attached/detached,
    // tag.edited/deleted, site.changed); these edits are the editor's workflow.
    it('follows tag attach, rename, detach, delete and bulk addTag on an existing post', async function () {
      const post = await createPost({
        title: 'Drip reload lesson',
        visibility: 'tiers',
        tiers: [{ id: tier.id }],
      });
      assert.equal(drip.getDripDays(post.id), null);

      // (a) a drip tag added to an existing post
      let res = await adminAgent
        .put(`posts/${post.id}/`)
        .body({ posts: [{ updated_at: post.updated_at, tags: [{ name: '#drip-3' }] }] });
      assert.equal(res.statusCode, 200, JSON.stringify(res.body));
      assert.ok(await waitFor(() => drip.getDripDays(post.id) === 3), 'reload after attach');
      const tag = res.body.posts[0].tags[0];

      // (b) the tag renamed
      const renamed = await adminAgent.put(`tags/${tag.id}/`).body({ tags: [{ name: '#drip-5' }] });
      assert.equal(renamed.statusCode, 200, JSON.stringify(renamed.body));
      assert.ok(await waitFor(() => drip.getDripDays(post.id) === 5), 'reload after rename');

      // (c) the tag taken off the post (only the tags change)
      res = await adminAgent
        .put(`posts/${post.id}/`)
        .body({ posts: [{ updated_at: res.body.posts[0].updated_at, tags: [] }] });
      assert.equal(res.statusCode, 200, JSON.stringify(res.body));
      assert.ok(await waitFor(() => drip.getDripDays(post.id) === null), 'reload after detach');

      // (d) put back, then the tag itself deleted
      res = await adminAgent
        .put(`posts/${post.id}/`)
        .body({ posts: [{ updated_at: res.body.posts[0].updated_at, tags: [{ id: tag.id }] }] });
      assert.equal(res.statusCode, 200, JSON.stringify(res.body));
      assert.ok(await waitFor(() => drip.getDripDays(post.id) === 5), 'reload after re-attach');
      await adminAgent.delete(`tags/${tag.id}/`).expectStatus(204);
      assert.ok(await waitFor(() => drip.getDripDays(post.id) === null), 'reload after tag delete');

      // (e) the bulk addTag action
      const bulkTag = (await adminAgent.post('tags/').body({ tags: [{ name: '#drip-7' }] })).body
        .tags[0];
      const bulk = await adminAgent
        .put(`posts/bulk/?filter=id:'${post.id}'`)
        .body({ bulk: { action: 'addTag', meta: { tags: [{ id: bulkTag.id }] } } });
      assert.equal(bulk.statusCode, 200, JSON.stringify(bulk.body));
      assert.ok(await waitFor(() => drip.getDripDays(post.id) === 7), 'reload after bulk addTag');
    });
  });

  describe('deletes', function () {
    it('removes rows with the post and with the member', async function () {
      const agent = membersAgent.duplicate();
      await agent.loginAs('progress-deleted@example.com');
      const doomed = await memberByEmail('progress-deleted@example.com');
      const post = await createPost({ title: 'Progress doomed post', visibility: 'public' });

      await put(
        agent,
        [
          { post_id: post.id, status: 'completed' },
          { post_id: publicPost.id, status: 'started' },
        ],
        200,
      );
      await put(membersAgent, [{ post_id: post.id, status: 'started' }], 200);
      assert.equal((await progressRows(doomed.id)).length, 2);

      await adminAgent.delete(`posts/${post.id}/`).expectStatus(204);
      assert.deepEqual(
        await db.knex('members_post_progress').where({ post_id: post.id }),
        [],
        'post delete cascades',
      );
      assert.equal((await progressRows(doomed.id)).length, 1);

      await adminAgent.delete(`members/${doomed.id}/`).expectStatus(204);
      assert.deepEqual(await progressRows(doomed.id), [], 'member delete cascades');
      assert.ok((await progressRows(member.id)).length > 0, "other members' rows are kept");
    });
  });
});
