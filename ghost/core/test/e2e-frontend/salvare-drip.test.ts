// fork(salvare): drip (`#drip-<n>` tags, `unlock_at`) and the theme-helper member context, end to end against the database.
import assert from 'node:assert/strict';
import sinon from 'sinon';
import supertest from 'supertest';
import { DateTime } from 'luxon';
import { afterAll, beforeAll } from 'vitest';

const testUtils = require('../utils');
const configUtils = require('../utils/config-utils');
const settingsCache = require('../../core/shared/settings-cache');
const models = require('../../core/server/models');
const db = require('../../core/server/data/db');
const drip = require('../../core/server/services/drip');
const { toDatabaseDate } = require('../../core/server/lib/db-types/date');

const DAY = 24 * 60 * 60 * 1000;
const INTRO = 'Drip lesson intro';
const BODY = 'Drip lesson secret body';
const LEXICAL = testUtils.DataGenerator.markdownToLexical(
  `${INTRO}\n\n<!--members-only-->\n\n${BODY}`,
);

function assertOpen(res: any) {
  assert.match(res.text, new RegExp(INTRO), 'the lead renders');
  assert.match(res.text, new RegExp(BODY), 'the lesson body renders');
}

function assertLocked(res: any) {
  assert.match(res.text, new RegExp(INTRO), 'the lead renders');
  assert.doesNotMatch(res.text, new RegExp(BODY), 'the lesson body is withheld');
}

/** Start of the start day in `zone`, plus `days` calendar days, as ISO UTC (design B4). */
function expectedUnlock(start: Date, days: number, zone: string): string {
  return DateTime.fromJSDate(start, { zone })
    .startOf('day')
    .plus({ days })
    .toJSDate()
    .toISOString();
}

async function waitFor(fn: () => boolean, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) {
      return true;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  }
  return false;
}

/** Moves the member's `added` event(s) for a tier to `date` (one-second resolution in MySQL). */
async function setAccessStart(memberId: string, productId: string, date: Date): Promise<void> {
  const updated = await db
    .knex('members_product_events')
    .where({ member_id: memberId, product_id: productId, action: 'added' })
    .update({ created_at: toDatabaseDate(date) });
  assert.ok(updated > 0, 'expected an added product event');
}

function wholeSecond(ms: number): Date {
  return new Date(Math.floor(ms / 1000) * 1000);
}

describe('Salvare drip', function () {
  let timezone = 'Etc/UTC';
  let membersService: any;
  let api: any;
  let get: any;
  let updateLocalTemplateOptions: any;
  let hbs: any;
  let tier: any;
  let dripPost: any;
  let tierPost: any;
  let publicDripPost: any;
  let paidDripPost: any;
  let draftDripPost: any;
  let comped: any; // fresh comp onto the tier, `added` event a day ago
  let buyer: any; // purchase-only member (status free) holding the tier
  let freeMember: any;

  async function createPost(data: Record<string, unknown>) {
    const post = testUtils.DataGenerator.forKnex.createPost({
      status: 'published',
      published_at: new Date(),
      lexical: LEXICAL,
      ...data,
    });
    await models.Post.add(post, { context: { internal: true } });
    return post;
  }

  async function createMember(email: string, data: Record<string, unknown> = {}) {
    const member = await membersService.api.members.create(
      { email, name: email.split('@')[0], ...data },
      { context: { internal: true } },
    );
    return { id: member.id, email, uuid: member.get('uuid') };
  }

  /** A supertest agent signed in as `email` through a magic link, as the site does it. */
  async function signedIn(email: string) {
    const agent = supertest.agent(configUtils.config.get('url'));
    const signinLink = await membersService.api.getMagicLink(email, 'signin');
    const signinURL = new URL(signinLink);
    await agent.get(`${signinURL.pathname}${signinURL.search}`).expect(302);
    return agent;
  }

  /** The session member: what loadMemberSession puts on req.member / res.locals.member. */
  async function sessionMember(email: string) {
    return membersService.api.memberBREADService.read({ email }, { metafieldsFor: null });
  }

  /** The template `@member`, built by the real theme middleware from a session member. */
  function templateMember(session: any) {
    const req = { member: session, header: () => undefined };
    const res = { locals: {} };
    updateLocalTemplateOptions(req, res, () => {});
    return hbs.getLocalTemplateOptions(res.locals).data.member;
  }

  /** Runs the real {{#get "posts"}} helper for one post as `email`, and returns that post. */
  async function getHelperPost(email: string | null, postId: string, hash = {}) {
    const session = email ? await sessionMember(email) : null;
    const fn = sinon.spy();
    const inverse = sinon.spy();
    await get.call({}, 'posts', {
      hash: { filter: `id:${postId}`, include: 'tiers', ...hash },
      data: {
        member: session ? templateMember(session) : null,
        root: { _locals: { member: session } },
      },
      fn,
      inverse,
    });
    assert.ok(fn.calledOnce, `{{#get}} rendered its inverse: ${JSON.stringify(inverse.args)}`);
    const [post] = fn.firstCall.args[0].posts;
    assert.ok(post, 'post returned');
    return post;
  }

  async function readAs(member: any, slug: string, options: Record<string, unknown> = {}) {
    const result = await api.postsPublic.read({
      slug,
      include: 'tags,tiers',
      context: { member },
      ...options,
    });
    return result.posts[0];
  }

  beforeAll(async function () {
    const originalSettingsCacheGetFn = settingsCache.get;
    sinon.stub(settingsCache, 'get').callsFake(function (key: any, options: any) {
      if (key === 'labs') {
        return { members: true };
      }
      if (key === 'active_theme') {
        return 'members-test-theme';
      }
      if (key === 'timezone') {
        return timezone;
      }
      return originalSettingsCacheGetFn(key, options);
    });

    await testUtils.startGhost({ copyThemes: true });

    // Required after boot, as members.test.js does
    membersService = require('../../core/server/services/members');
    api = require('../../core/server/api').endpoints;
    get = require('../../core/frontend/helpers/get');
    updateLocalTemplateOptions = require('../../core/frontend/services/theme-engine/middleware/update-local-template-options');
    hbs = require('../../core/frontend/services/theme-engine/engine');

    const product = await models.Product.findOne({ slug: 'default-product' }, { require: true });
    tier = { id: product.id, slug: product.get('slug') };

    dripPost = await createPost({
      slug: 'drip-three-lesson',
      visibility: 'tiers',
      tiers: [{ id: tier.id }],
      tags: [{ name: '#drip-3' }, { name: '#course-drip' }],
    });
    tierPost = await createPost({
      slug: 'tier-lesson-no-drip',
      visibility: 'tiers',
      tiers: [{ id: tier.id }],
    });
    publicDripPost = await createPost({
      slug: 'public-post-with-drip-tag',
      visibility: 'public',
      tags: [{ name: '#drip-3' }],
    });
    paidDripPost = await createPost({
      slug: 'paid-post-with-drip-tag',
      visibility: 'paid',
      tags: [{ name: '#drip-3' }],
    });
    draftDripPost = await createPost({
      slug: 'draft-drip-lesson',
      status: 'draft',
      published_at: null,
      visibility: 'tiers',
      tiers: [{ id: tier.id }],
      tags: [{ name: '#drip-3' }],
    });

    assert.ok(
      await waitFor(
        () => drip.getDripDays(dripPost.id) === 3 && drip.getDripDays(draftDripPost.id) === 3,
      ),
      'the drip index never picked up the new posts',
    );
    assert.equal(drip.getDripDays(tierPost.id), null);

    comped = await createMember('drip-comped@example.com', { products: [{ id: tier.id }] });
    buyer = await createMember('drip-buyer@example.com', { status: 'free' });
    await membersService.api.members.grantPurchasedProduct({
      memberId: buyer.id,
      productId: tier.id,
    });
    freeMember = await createMember('drip-free@example.com');
  });

  beforeEach(async function () {
    timezone = 'Etc/UTC';
    // A fresh comp: the lesson opens in two days
    await setAccessStart(comped.id, tier.id, wholeSecond(Date.now() - DAY));
  });

  afterEach(async function () {
    await configUtils.restore();
  });

  afterAll(function () {
    sinon.restore();
  });

  describe('post page', function () {
    it('withholds a #drip-3 lesson from a fresh comp in enforce mode', async function () {
      configUtils.set('salvare:drip:mode', 'enforce');
      const agent = await signedIn(comped.email);

      const res = await agent.get(`/${dripPost.slug}/`).expect(200);
      assertLocked(res);
      assert.match(res.headers['cache-control'], /private/);

      // The tier lesson without a drip tag is open
      assertOpen(await agent.get(`/${tierPost.slug}/`).expect(200));
    });

    it('opens it once the access start is three calendar days back', async function () {
      configUtils.set('salvare:drip:mode', 'enforce');
      await setAccessStart(comped.id, tier.id, wholeSecond(Date.now() - 4 * DAY));
      const agent = await signedIn(comped.email);

      assertOpen(await agent.get(`/${dripPost.slug}/`).expect(200));
    });

    it('shows it in advise mode, in off mode, and with the mode unset', async function () {
      const agent = await signedIn(comped.email);

      configUtils.set('salvare:drip:mode', 'advise');
      assertOpen(await agent.get(`/${dripPost.slug}/`).expect(200));

      configUtils.set('salvare:drip:mode', 'off');
      assertOpen(await agent.get(`/${dripPost.slug}/`).expect(200));

      await configUtils.restore();
      assert.equal(drip.getMode(), 'advise');
      assertOpen(await agent.get(`/${dripPost.slug}/`).expect(200));
    });

    it('ignores drip tags on public and paid posts', async function () {
      configUtils.set('salvare:drip:mode', 'enforce');
      const agent = await signedIn(comped.email);

      assertOpen(await agent.get(`/${publicDripPost.slug}/`).expect(200));
      assertOpen(await agent.get(`/${paidDripPost.slug}/`).expect(200));
    });

    it('keeps tier gating for anonymous visitors and members without the tier', async function () {
      configUtils.set('salvare:drip:mode', 'enforce');
      const anonymous = supertest.agent(configUtils.config.get('url'));
      assertLocked(await anonymous.get(`/${dripPost.slug}/`).expect(200));
      assertLocked(await anonymous.get(`/${tierPost.slug}/`).expect(200));
      assertOpen(await anonymous.get(`/${publicDripPost.slug}/`).expect(200));

      const free = await signedIn(freeMember.email);
      assertLocked(await free.get(`/${dripPost.slug}/`).expect(200));
      assertLocked(await free.get(`/${tierPost.slug}/`).expect(200));
    });
  });

  describe('in-process Content API read', function () {
    it('sets access:false and unlock_at for the session member in enforce mode', async function () {
      configUtils.set('salvare:drip:mode', 'enforce');
      const start = wholeSecond(Date.now() - DAY);
      await setAccessStart(comped.id, tier.id, start);

      const post = await readAs(await sessionMember(comped.email), dripPost.slug);
      assert.equal(post.access, false);
      assert.equal(post.unlock_at, expectedUnlock(start, 3, 'Etc/UTC'));
      assert.ok(post.html.includes(INTRO));
      assert.ok(!post.html.includes(BODY));
    });

    it('keeps access but still reports unlock_at in advise mode', async function () {
      configUtils.set('salvare:drip:mode', 'advise');
      const start = wholeSecond(Date.now() - DAY);
      await setAccessStart(comped.id, tier.id, start);

      const post = await readAs(await sessionMember(comped.email), dripPost.slug);
      assert.equal(post.access, true);
      assert.equal(post.unlock_at, expectedUnlock(start, 3, 'Etc/UTC'));
      assert.ok(post.html.includes(BODY));
    });

    it('drops unlock_at once the lesson is open, and for posts without drip', async function () {
      configUtils.set('salvare:drip:mode', 'enforce');
      await setAccessStart(comped.id, tier.id, wholeSecond(Date.now() - 4 * DAY));
      const session = await sessionMember(comped.email);

      const open = await readAs(session, dripPost.slug);
      assert.equal(open.access, true);
      assert.equal(Object.hasOwn(open, 'unlock_at'), false);

      const plain = await readAs(session, tierPost.slug);
      assert.equal(plain.access, true);
      assert.equal(Object.hasOwn(plain, 'unlock_at'), false);
    });

    it('follows the fields rule for unlock_at, as for access', async function () {
      configUtils.set('salvare:drip:mode', 'enforce');
      const session = await sessionMember(comped.email);

      const without = await readAs(session, dripPost.slug, { fields: 'id,title,access' });
      assert.equal(without.access, false);
      assert.equal(Object.hasOwn(without, 'unlock_at'), false);

      const withField = await readAs(session, dripPost.slug, {
        fields: 'id,title,access,unlock_at',
      });
      assert.equal(withField.access, false);
      assert.ok(withField.unlock_at, 'unlock_at listed in fields is returned');
    });

    it('unlocks at midnight in the site timezone, by calendar days', async function () {
      configUtils.set('salvare:drip:mode', 'enforce');
      timezone = 'America/New_York';

      // 02:00 UTC yesterday is still the day before in New York
      const yesterday = new Date(Date.now() - DAY);
      const start = new Date(
        Date.UTC(yesterday.getUTCFullYear(), yesterday.getUTCMonth(), yesterday.getUTCDate(), 2),
      );
      await setAccessStart(comped.id, tier.id, start);

      const post = await readAs(await sessionMember(comped.email), dripPost.slug);
      assert.equal(post.access, false);
      assert.equal(post.unlock_at, expectedUnlock(start, 3, 'America/New_York'));
      assert.notEqual(post.unlock_at, expectedUnlock(start, 3, 'Etc/UTC'));

      const local = DateTime.fromISO(post.unlock_at, { zone: 'America/New_York' });
      assert.equal(local.toFormat('HH:mm:ss.SSS'), '00:00:00.000');
      const startDay = DateTime.fromJSDate(start, { zone: 'America/New_York' }).startOf('day');
      assert.equal(local.diff(startDay, 'days').days, 3);
    });

    it('keeps local midnight across a DST change (Europe/London)', async function () {
      configUtils.set('salvare:drip:mode', 'enforce');
      timezone = 'Europe/London';
      const start = wholeSecond(Date.now() - DAY);
      await setAccessStart(comped.id, tier.id, start);

      // Whatever the date, pick N so the drip window crosses exactly one London
      // clock change: the first day whose local midnight has a different offset.
      const startDay = DateTime.fromJSDate(start, { zone: 'Europe/London' }).startOf('day');
      let days = 1;
      while (startDay.plus({ days }).offset === startDay.offset) {
        days += 1;
      }
      assert.ok(days <= 220, `no London offset change within ${days} days`);

      const post = await createPost({
        slug: `drip-dst-lesson-${days}`,
        visibility: 'tiers',
        tiers: [{ id: tier.id }],
        tags: [{ name: `#drip-${days}` }],
      });
      assert.ok(
        await waitFor(() => drip.getDripDays(post.id) === days),
        'the drip index never picked up the DST post',
      );

      const read = await readAs(await sessionMember(comped.email), post.slug);
      assert.equal(read.access, false);
      const local = DateTime.fromISO(read.unlock_at, { zone: 'Europe/London' });
      assert.notEqual(local.offset, startDay.offset, 'the window crosses a clock change');
      assert.equal(local.toFormat('HH:mm:ss.SSS'), '00:00:00.000');
      assert.equal(local.diff(startDay, 'days').days, days);
      // 24-hour blocks would land an hour off local midnight
      assert.notEqual(read.unlock_at, new Date(startDay.toMillis() + days * DAY).toISOString());
    });

    it('fails closed for a real member whose access start is unknown', async function () {
      // Holds the tier, but carries neither access_starts nor productEvents
      const member = {
        id: comped.id,
        uuid: comped.uuid,
        email: comped.email,
        status: 'comped',
        products: [{ id: tier.id, slug: tier.slug }],
      };

      configUtils.set('salvare:drip:mode', 'enforce');
      const locked = await readAs(member, dripPost.slug);
      assert.equal(locked.access, false);
      assert.equal(Object.hasOwn(locked, 'unlock_at'), false);
      assert.ok(!locked.html.includes(BODY));

      // A non-drip tier post is unaffected
      assert.equal((await readAs(member, tierPost.slug)).access, true);

      configUtils.set('salvare:drip:mode', 'advise');
      const advised = await readAs({ ...member }, dripPost.slug);
      assert.equal(advised.access, true);
      assert.equal(Object.hasOwn(advised, 'unlock_at'), false);
    });

    it('leaves shims (no id, no uuid) with their access', async function () {
      configUtils.set('salvare:drip:mode', 'enforce');
      const shim = { status: 'paid', products: [{ id: tier.id, slug: tier.slug }] };
      const post = await readAs(shim, dripPost.slug);
      assert.equal(post.access, true);
      assert.equal(Object.hasOwn(post, 'unlock_at'), false);
    });
  });

  describe('{{#get}} helper member context (theme contract §5)', function () {
    it('gives a comped member and a purchase-only member access to a tier post', async function () {
      configUtils.set('salvare:drip:mode', 'enforce');

      const compedPost = await getHelperPost(comped.email, tierPost.id);
      assert.equal(compedPost.access, true);

      assert.equal((await sessionMember(buyer.email)).status, 'free');
      const buyerPost = await getHelperPost(buyer.email, tierPost.id);
      assert.equal(buyerPost.access, true);

      // Without the tier: still locked
      const freePost = await getHelperPost(freeMember.email, tierPost.id);
      assert.equal(freePost.access, false);
      const anonymousPost = await getHelperPost(null, tierPost.id);
      assert.equal(anonymousPost.access, false);
    });

    it('returns access:false with unlock_at for a dripped lesson, then opens it', async function () {
      configUtils.set('salvare:drip:mode', 'enforce');
      const start = wholeSecond(Date.now() - DAY);
      await setAccessStart(comped.id, tier.id, start);

      const locked = await getHelperPost(comped.email, dripPost.id);
      assert.equal(locked.access, false);
      assert.equal(locked.unlock_at, expectedUnlock(start, 3, 'Etc/UTC'));

      // fields= must list unlock_at for the theme to see it
      const narrowed = await getHelperPost(comped.email, dripPost.id, {
        fields: 'id,title,access',
      });
      assert.equal(narrowed.access, false);
      assert.equal(Object.hasOwn(narrowed, 'unlock_at'), false);

      await setAccessStart(comped.id, tier.id, wholeSecond(Date.now() - 4 * DAY));
      const open = await getHelperPost(comped.email, dripPost.id);
      assert.equal(open.access, true);
      assert.equal(Object.hasOwn(open, 'unlock_at'), false);
    });

    it('drips the purchase-only member from the purchase grant', async function () {
      configUtils.set('salvare:drip:mode', 'enforce');
      const start = wholeSecond(Date.now() - DAY);
      await setAccessStart(buyer.id, tier.id, start);

      const locked = await getHelperPost(buyer.email, dripPost.id);
      assert.equal(locked.access, false);
      assert.equal(locked.unlock_at, expectedUnlock(start, 3, 'Etc/UTC'));

      await setAccessStart(buyer.id, tier.id, wholeSecond(Date.now() - 10 * DAY));
      assert.equal((await getHelperPost(buyer.email, dripPost.id)).access, true);
    });

    it('exposes owned tiers on @member.tiers, never @member.products', async function () {
      const atMember = templateMember(await sessionMember(buyer.email));
      // A purchase never expires: expiry_at null tells the theme the Buy button would be refused.
      assert.deepEqual(
        atMember.tiers.map((t: any) => [t.slug, t.expiry_at]),
        [[tier.slug, null]],
      );
      assert.equal(Object.hasOwn(atMember, 'products'), false);
      assert.equal(Object.hasOwn(atMember, 'access_starts'), false);
    });
  });

  describe('preview', function () {
    it('previews a dripped draft as open, with unlock_at counted from today', async function () {
      configUtils.set('salvare:drip:mode', 'enforce');
      const before = expectedUnlock(new Date(), 3, 'Etc/UTC');

      const result = await api.previews.read({
        uuid: draftDripPost.uuid,
        member_status: 'paid',
        member_tier: tier.slug,
        include: 'tags,tiers',
        // No context, as the frontend preview controller calls it (a public read)
      });
      const after = expectedUnlock(new Date(), 3, 'Etc/UTC');
      const [post] = result.previews;

      assert.equal(post.access, true);
      assert.ok(
        [before, after].includes(post.unlock_at),
        `unlock_at ${post.unlock_at} is not today + 3 days`,
      );
      assert.ok(post.html.includes(BODY));
    });

    it('renders the preview page with the lesson body for a paid preview', async function () {
      configUtils.set('salvare:drip:mode', 'enforce');
      const request = supertest.agent(configUtils.config.get('url'));

      assertOpen(
        await request
          .get(`/p/${draftDripPost.uuid}/?member_status=paid&member_tier=${tier.slug}`)
          .expect(200),
      );
      // Tier gating still applies to a free preview
      assertLocked(await request.get(`/p/${draftDripPost.uuid}/?member_status=free`).expect(200));
    });
  });
});
