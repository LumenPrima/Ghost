import assert from 'node:assert/strict';
import errors from '@tryghost/errors';
import sinon from 'sinon';
import { ProgressService } from '../../../../../core/server/services/progress/progress-service';

const MEMBER_ID = 'aaaaaaaaaaaaaaaaaaaaaaa1';
const POST_1 = 'bbbbbbbbbbbbbbbbbbbbbbb1';
const POST_2 = 'bbbbbbbbbbbbbbbbbbbbbbb2';
const POST_3 = 'bbbbbbbbbbbbbbbbbbbbbbb3';

describe('ProgressService', function () {
  const now = new Date('2026-10-07T12:00:00.000Z');
  let repository: {
    browseByPost: sinon.SinonStub;
    browseByTag: sinon.SinonStub;
    upsert: sinon.SinonStub;
    getPublishedPosts: sinon.SinonStub;
  };
  let checker: { check: sinon.SinonStub };
  let service: ProgressService;

  const row = { post_id: POST_1, status: 'started', updated_at: now.toISOString() };

  beforeEach(function () {
    repository = {
      browseByPost: sinon.stub().resolves([row]),
      browseByTag: sinon.stub().resolves([row]),
      upsert: sinon.stub().resolves([row]),
      getPublishedPosts: sinon.stub(),
    };
    checker = {
      check: sinon
        .stub()
        .callsFake(
          async (_memberId: string, ids: string[]) => new Map(ids.map((id) => [id, 'ok'])),
        ),
    };
    service = new ProgressService({ repository, checker, now: () => now });
  });

  async function assertValidationError(promise: Promise<unknown>) {
    await assert.rejects(promise, (err: unknown) => {
      assert.ok(err instanceof errors.ValidationError, String(err));
      assert.equal((err as InstanceType<typeof errors.ValidationError>).statusCode, 422);
      return true;
    });
  }

  describe('browse', function () {
    it('reads by post_id, ignoring the request context', async function () {
      const rows = await service.browse(MEMBER_ID, {
        post_id: POST_1,
        context: { member: { id: MEMBER_ID } },
      });

      assert.deepEqual(rows, [row]);
      sinon.assert.calledOnceWithExactly(repository.browseByPost, MEMBER_ID, POST_1);
    });

    it('accepts post as an alias, and lowercases the id', async function () {
      await service.browse(MEMBER_ID, { post: POST_2.toUpperCase() });

      sinon.assert.calledOnceWithExactly(repository.browseByPost, MEMBER_ID, POST_2);
    });

    it('accepts post_id and post together when they agree', async function () {
      await service.browse(MEMBER_ID, { post_id: POST_1, post: POST_1.toUpperCase() });

      sinon.assert.calledOnceWithExactly(repository.browseByPost, MEMBER_ID, POST_1);
    });

    it('reads by tag', async function () {
      await service.browse(MEMBER_ID, { tag: 'hash-course-anxiety' });

      sinon.assert.calledOnceWithExactly(repository.browseByTag, MEMBER_ID, 'hash-course-anxiety');
    });

    it('lowercases the tag, so SQLite and MySQL match the same slugs', async function () {
      await service.browse(MEMBER_ID, { tag: ' Hash-Course ' });

      sinon.assert.calledOnceWithExactly(repository.browseByTag, MEMBER_ID, 'hash-course');
    });

    for (const [name, options] of [
      ['neither post nor tag', {}],
      ['both post_id and tag', { post_id: POST_1, tag: 'hash-course-x' }],
      ['post_id and post naming different posts', { post_id: POST_1, post: POST_2 }],
      ['a malformed id', { post_id: 'not-an-id' }],
      ['an empty id', { post_id: '' }],
      ['an empty tag', { tag: '' }],
      ['a repeated parameter', { post_id: [POST_1, POST_2] }],
      ['an overlong tag', { tag: 'x'.repeat(192) }],
    ] as const) {
      it(`refuses ${name} with 422`, async function () {
        await assertValidationError(service.browse(MEMBER_ID, options as Record<string, unknown>));
        sinon.assert.notCalled(repository.browseByPost);
        sinon.assert.notCalled(repository.browseByTag);
      });
    }
  });

  describe('upsert', function () {
    it('checks access, then writes with the caller member id', async function () {
      const rows = await service.upsert(MEMBER_ID, {
        progress: [{ post_id: POST_1, status: 'completed' }],
      });

      assert.deepEqual(rows, [row]);
      sinon.assert.calledOnceWithExactly(checker.check, MEMBER_ID, [POST_1]);
      sinon.assert.calledOnceWithExactly(
        repository.upsert,
        MEMBER_ID,
        [{ postId: POST_1, status: 'completed' }],
        now,
      );
      sinon.assert.callOrder(checker.check, repository.upsert);
    });

    it('lowercases ids and keeps the last entry per post', async function () {
      await service.upsert(MEMBER_ID, {
        progress: [
          { post_id: POST_1, status: 'started' },
          { post_id: POST_2, status: 'started' },
          { post_id: POST_1.toUpperCase(), status: 'completed' },
        ],
      });

      sinon.assert.calledOnceWithExactly(checker.check, MEMBER_ID, [POST_1, POST_2]);
      assert.deepEqual(repository.upsert.firstCall.args[1], [
        { postId: POST_1, status: 'completed' },
        { postId: POST_2, status: 'started' },
      ]);
    });

    const item = { post_id: POST_1, status: 'started' };
    for (const [name, body] of [
      ['a missing envelope', {}],
      ['a bare array', [item]],
      ['a non-object body', 'progress'],
      ['an undefined body', undefined],
      ['an envelope that is not an array', { progress: item }],
      ['zero items', { progress: [] }],
      ['101 items', { progress: Array.from({ length: 101 }, () => item) }],
      ['an unknown status', { progress: [{ post_id: POST_1, status: 'done' }] }],
      ['a missing status', { progress: [{ post_id: POST_1 }] }],
      ['a malformed id', { progress: [{ post_id: 'abc', status: 'started' }] }],
      ['an extra item key', { progress: [{ ...item, updated_at: now.toISOString() }] }],
      ['an extra top-level key', { progress: [item], member_id: MEMBER_ID }],
    ] as const) {
      it(`refuses ${name} with 422 and writes nothing`, async function () {
        await assertValidationError(service.upsert(MEMBER_ID, body));
        sinon.assert.notCalled(checker.check);
        sinon.assert.notCalled(repository.upsert);
      });
    }

    it('accepts 100 items', async function () {
      const progress = Array.from({ length: 100 }, (_v, i) => ({
        post_id: i.toString(16).padStart(24, '0'),
        status: 'started',
      }));

      await service.upsert(MEMBER_ID, { progress });

      assert.equal(repository.upsert.firstCall.args[1].length, 100);
    });

    it('refuses the whole batch with 404 POST_NOT_FOUND when any post is missing', async function () {
      checker.check.resolves(
        new Map([
          [POST_1, 'ok'],
          [POST_2, 'not_found'],
        ]),
      );

      await assert.rejects(
        service.upsert(MEMBER_ID, {
          progress: [
            { post_id: POST_1, status: 'started' },
            { post_id: POST_2, status: 'started' },
          ],
        }),
        (err: InstanceType<typeof errors.NotFoundError>) => {
          assert.ok(err instanceof errors.NotFoundError);
          assert.equal(err.statusCode, 404);
          assert.equal(err.code, 'POST_NOT_FOUND');
          return true;
        },
      );
      sinon.assert.notCalled(repository.upsert);
    });

    it('refuses the whole batch with 403 POST_LOCKED when any post is locked', async function () {
      checker.check.resolves(
        new Map([
          [POST_1, 'ok'],
          [POST_2, 'locked'],
        ]),
      );

      await assert.rejects(
        service.upsert(MEMBER_ID, {
          progress: [
            { post_id: POST_1, status: 'started' },
            { post_id: POST_2, status: 'started' },
          ],
        }),
        (err: InstanceType<typeof errors.NoPermissionError>) => {
          assert.ok(err instanceof errors.NoPermissionError);
          assert.equal(err.statusCode, 403);
          assert.equal(err.code, 'POST_LOCKED');
          assert.equal(err.message, "You don't have access to this lesson.");
          return true;
        },
      );
      sinon.assert.notCalled(repository.upsert);
    });

    it('answers 404 before 403 when both apply', async function () {
      checker.check.resolves(
        new Map([
          [POST_1, 'locked'],
          [POST_2, 'not_found'],
        ]),
      );

      await assert.rejects(
        service.upsert(MEMBER_ID, {
          progress: [
            { post_id: POST_1, status: 'started' },
            { post_id: POST_2, status: 'started' },
          ],
        }),
        errors.NotFoundError,
      );
    });

    it('treats a post the checker did not answer for as not found', async function () {
      checker.check.resolves(new Map([[POST_1, 'ok']]));

      await assert.rejects(
        service.upsert(MEMBER_ID, {
          progress: [
            { post_id: POST_1, status: 'started' },
            { post_id: POST_3, status: 'started' },
          ],
        }),
        errors.NotFoundError,
      );
      sinon.assert.notCalled(repository.upsert);
    });

    it('lets an UnauthorizedError from the checker through, writing nothing', async function () {
      checker.check.rejects(new errors.UnauthorizedError({ message: 'gone' }));

      await assert.rejects(
        service.upsert(MEMBER_ID, { progress: [{ post_id: POST_1, status: 'started' }] }),
        errors.UnauthorizedError,
      );
      sinon.assert.notCalled(repository.upsert);
    });
  });
});
