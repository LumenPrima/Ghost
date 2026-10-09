import assert from 'node:assert/strict';
import errors from '@tryghost/errors';
import sinon from 'sinon';
import { ProgressAccessChecker } from '../../../../../core/server/services/progress/progress-access';
import type { LessonPost } from '../../../../../core/server/services/progress/progress-knex-repository';

const contentGating = require('../../../../../core/server/services/members/content-gating');

const MEMBER_ID = 'aaaaaaaaaaaaaaaaaaaaaaa1';
const OPEN = 'bbbbbbbbbbbbbbbbbbbbbbb1';
const TIERED = 'bbbbbbbbbbbbbbbbbbbbbbb2';
const DRIPPED = 'bbbbbbbbbbbbbbbbbbbbbbb3';
const MISSING = 'bbbbbbbbbbbbbbbbbbbbbbb4';

const tierA = { id: 'ddddddddddddddddddddddd1', slug: 'tier-a', type: 'paid' };
const free = { id: 'ddddddddddddddddddddddd3', slug: 'free', type: 'free' };

const posts: LessonPost[] = [
  { id: OPEN, visibility: 'public', tiers: [] },
  { id: TIERED, visibility: 'tiers', tiers: [tierA, free] },
  { id: DRIPPED, visibility: 'tiers', tiers: [tierA] },
];

describe('ProgressAccessChecker', function () {
  const now = new Date('2026-10-07T12:00:00.000Z');
  let member: Record<string, unknown> | null;
  let loadMember: sinon.SinonStub;
  let loadPosts: sinon.SinonStub;
  let checkPostAccess: sinon.SinonSpy;
  let evaluateDrip: sinon.SinonStub;
  let checker: ProgressAccessChecker;

  beforeEach(function () {
    member = {
      id: MEMBER_ID,
      uuid: 'member-uuid',
      status: 'comped',
      products: [{ id: tierA.id, slug: tierA.slug }],
    };
    loadMember = sinon.stub().callsFake(async () => member);
    loadPosts = sinon.stub().resolves(posts);
    // The real content gating, so the tier narrowing is exercised end to end.
    checkPostAccess = sinon.spy(contentGating.checkPostAccess);
    evaluateDrip = sinon
      .stub()
      .callsFake((post: LessonPost, _member: unknown, opts: { memberHasAccess: boolean }) => {
        if (post.id === DRIPPED && opts.memberHasAccess) {
          return { access: false, unlockAt: '2026-10-09T00:00:00.000Z' };
        }
        return { access: opts.memberHasAccess, unlockAt: null };
      });
    checker = new ProgressAccessChecker({
      loadMember,
      loadPosts,
      checkPostAccess,
      evaluateDrip,
      now: () => now,
    });
  });

  it('answers ok, locked and not_found per post', async function () {
    const result = await checker.check(MEMBER_ID, [OPEN, TIERED, DRIPPED, MISSING]);

    assert.deepEqual(
      [...result],
      [
        [OPEN, 'ok'],
        [TIERED, 'ok'],
        [DRIPPED, 'locked'],
        [MISSING, 'not_found'],
      ],
    );
    sinon.assert.calledOnceWithExactly(loadMember, MEMBER_ID);
    sinon.assert.calledOnceWithExactly(loadPosts, [OPEN, TIERED, DRIPPED, MISSING]);
  });

  it('locks a tier post the member does not hold', async function () {
    member!.status = 'free';
    member!.products = [];

    const result = await checker.check(MEMBER_ID, [TIERED, OPEN]);

    assert.equal(result.get(TIERED), 'locked');
    assert.equal(result.get(OPEN), 'ok');
  });

  it('narrows a tiers post to paid tiers, as the Content API mapper does', async function () {
    member!.status = 'free';
    member!.products = [{ id: free.id, slug: free.slug }];

    const result = await checker.check(MEMBER_ID, [TIERED]);

    assert.equal(result.get(TIERED), 'locked');
    const [gatedPost] = checkPostAccess.firstCall.args;
    assert.deepEqual(gatedPost.tiers, [tierA]);
    // The loaded post is not mutated.
    assert.deepEqual(posts[1].tiers, [tierA, free]);
  });

  it('passes the loaded member, the gating answer and one now to drip', async function () {
    await checker.check(MEMBER_ID, [OPEN, DRIPPED]);

    sinon.assert.calledTwice(evaluateDrip);
    const [post, drippedMember, opts] = evaluateDrip.secondCall.args;
    assert.equal(post.id, DRIPPED);
    assert.equal(drippedMember, member);
    assert.deepEqual(opts, { memberHasAccess: true, now });
    assert.equal(evaluateDrip.firstCall.args[2].now, now);
  });

  it('tells drip when gating refused, and keeps the refusal', async function () {
    member!.status = 'free';
    member!.products = [];

    const result = await checker.check(MEMBER_ID, [DRIPPED]);

    assert.equal(result.get(DRIPPED), 'locked');
    assert.deepEqual(evaluateDrip.firstCall.args[2], { memberHasAccess: false, now });
  });

  it('opens a drip-locked lesson when drip says so (advise mode)', async function () {
    evaluateDrip.callsFake((_post: unknown, _m: unknown, opts: { memberHasAccess: boolean }) => ({
      access: opts.memberHasAccess,
      unlockAt: '2026-10-09T00:00:00.000Z',
    }));

    const result = await checker.check(MEMBER_ID, [DRIPPED]);

    assert.equal(result.get(DRIPPED), 'ok');
  });

  it('refuses with UnauthorizedError when the member no longer exists', async function () {
    member = null;

    await assert.rejects(checker.check(MEMBER_ID, [OPEN]), errors.UnauthorizedError);
    sinon.assert.notCalled(loadPosts);
  });
});
