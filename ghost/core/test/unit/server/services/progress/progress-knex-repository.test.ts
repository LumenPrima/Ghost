import assert from 'node:assert/strict';
import errors from '@tryghost/errors';
import type { Knex } from 'knex';
import { ProgressKnexRepository } from '../../../../../core/server/services/progress/progress-knex-repository';
import { createProgressTables, createSqliteKnex } from './db';

const MEMBER = 'aaaaaaaaaaaaaaaaaaaaaaa1';
const OTHER_MEMBER = 'aaaaaaaaaaaaaaaaaaaaaaa2';
const LESSON_1 = 'bbbbbbbbbbbbbbbbbbbbbbb1';
const LESSON_2 = 'bbbbbbbbbbbbbbbbbbbbbbb2';
const LESSON_3 = 'bbbbbbbbbbbbbbbbbbbbbbb3';
const DRAFT = 'bbbbbbbbbbbbbbbbbbbbbbb4';
const PAGE = 'bbbbbbbbbbbbbbbbbbbbbbb5';
const SCHEDULED = 'bbbbbbbbbbbbbbbbbbbbbbb6';
const COURSE_TAG = 'ccccccccccccccccccccccc1';
const OTHER_TAG = 'ccccccccccccccccccccccc2';
const TIER_A = 'ddddddddddddddddddddddd1';
const TIER_B = 'ddddddddddddddddddddddd2';
const FREE = 'ddddddddddddddddddddddd3';

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe('ProgressKnexRepository', function () {
  let knex: Knex;
  let repository: ProgressKnexRepository;

  beforeEach(async function () {
    knex = createSqliteKnex();
    await createProgressTables(knex);
    await knex('members').insert([{ id: MEMBER }, { id: OTHER_MEMBER }]);
    await knex('posts').insert([
      // Every row names every column: a multi-row insert fills a missing key with NULL.
      { id: LESSON_1, type: 'post', status: 'published', visibility: 'tiers' },
      { id: LESSON_2, type: 'post', status: 'published', visibility: 'members' },
      { id: LESSON_3, type: 'post', status: 'published', visibility: 'public' },
      { id: DRAFT, type: 'post', status: 'draft', visibility: 'public' },
      { id: PAGE, type: 'page', status: 'published', visibility: 'public' },
      { id: SCHEDULED, type: 'post', status: 'scheduled', visibility: 'public' },
    ]);
    await knex('tags').insert([
      { id: COURSE_TAG, slug: 'hash-course-x' },
      { id: OTHER_TAG, slug: 'other' },
    ]);
    await knex('posts_tags').insert([
      { id: 'pt1', post_id: LESSON_1, tag_id: COURSE_TAG, sort_order: 0 },
      { id: 'pt2', post_id: LESSON_2, tag_id: COURSE_TAG, sort_order: 0 },
      // Tagged twice: rows must not repeat.
      { id: 'pt3', post_id: LESSON_2, tag_id: COURSE_TAG, sort_order: 1 },
      { id: 'pt4', post_id: LESSON_3, tag_id: OTHER_TAG, sort_order: 0 },
    ]);
    await knex('products').insert([
      { id: TIER_A, slug: 'tier-a', type: 'paid' },
      { id: TIER_B, slug: 'tier-b', type: 'paid' },
      { id: FREE, slug: 'free', type: 'free' },
    ]);
    await knex('posts_products').insert([
      { id: 'pp1', post_id: LESSON_1, product_id: TIER_B, sort_order: 1 },
      { id: 'pp2', post_id: LESSON_1, product_id: TIER_A, sort_order: 0 },
      { id: 'pp3', post_id: LESSON_1, product_id: FREE, sort_order: 2 },
    ]);
    repository = new ProgressKnexRepository({ knex });
  });

  afterEach(async function () {
    await knex.destroy();
  });

  describe('upsert', function () {
    it('inserts rows and returns them with ISO timestamps', async function () {
      const now = new Date('2026-10-06T04:10:00.000Z');

      const rows = await repository.upsert(
        MEMBER,
        [
          { postId: LESSON_2, status: 'completed' },
          { postId: LESSON_1, status: 'started' },
        ],
        now,
      );

      assert.deepEqual(rows, [
        { post_id: LESSON_1, status: 'started', updated_at: '2026-10-06T04:10:00.000Z' },
        { post_id: LESSON_2, status: 'completed', updated_at: '2026-10-06T04:10:00.000Z' },
      ]);
    });

    it('updates an existing row in place, keeping created_at', async function () {
      await repository.upsert(
        MEMBER,
        [{ postId: LESSON_1, status: 'started' }],
        new Date('2026-10-01T10:00:00.000Z'),
      );
      const [first] = await knex('members_post_progress').select('id', 'created_at');

      const rows = await repository.upsert(
        MEMBER,
        [{ postId: LESSON_1, status: 'completed' }],
        new Date('2026-10-02T11:30:00.000Z'),
      );

      assert.deepEqual(rows, [
        { post_id: LESSON_1, status: 'completed', updated_at: '2026-10-02T11:30:00.000Z' },
      ]);
      const stored = await knex('members_post_progress').select('id', 'created_at', 'status');
      assert.equal(stored.length, 1);
      assert.equal(stored[0].id, first.id);
      assert.equal(stored[0].created_at, first.created_at);
      assert.equal(stored[0].created_at, '2026-10-01 10:00:00');
    });

    it('stores started over completed (an un-tick)', async function () {
      await repository.upsert(MEMBER, [{ postId: LESSON_1, status: 'completed' }], new Date());

      const rows = await repository.upsert(
        MEMBER,
        [{ postId: LESSON_1, status: 'started' }],
        new Date(),
      );

      assert.equal(rows[0].status, 'started');
    });

    it('keeps members apart and returns only the caller rows', async function () {
      await repository.upsert(
        OTHER_MEMBER,
        [{ postId: LESSON_1, status: 'completed' }],
        new Date(),
      );

      const rows = await repository.upsert(
        MEMBER,
        [{ postId: LESSON_1, status: 'started' }],
        new Date(),
      );

      assert.deepEqual(
        rows.map((row) => row.status),
        ['started'],
      );
      assert.equal((await knex('members_post_progress').select('id')).length, 2);
    });

    it('inserts in post id order whatever the request order (InnoDB lock order)', async function () {
      const inserts: unknown[][] = [];
      knex.on('query', (query: { sql: string; bindings?: unknown[] }) => {
        if (/^insert into .members_post_progress./i.test(query.sql)) {
          inserts.push(query.bindings ?? []);
        }
      });

      await repository.upsert(
        MEMBER,
        [
          { postId: LESSON_3, status: 'started' },
          { postId: LESSON_1, status: 'started' },
          { postId: LESSON_2, status: 'started' },
        ],
        new Date(),
      );

      assert.equal(inserts.length, 1);
      const postIds = inserts[0].filter((value) =>
        [LESSON_1, LESSON_2, LESSON_3].includes(value as string),
      );
      assert.deepEqual(postIds, [LESSON_1, LESSON_2, LESSON_3]);
    });

    it('reports a post deleted after the access check as 404 POST_NOT_FOUND', async function () {
      await assert.rejects(
        repository.upsert(
          MEMBER,
          [
            { postId: LESSON_1, status: 'started' },
            { postId: 'eeeeeeeeeeeeeeeeeeeeeee1', status: 'started' },
          ],
          new Date(),
        ),
        (err: unknown) => {
          assert.ok(err instanceof errors.NotFoundError, String(err));
          assert.equal((err as InstanceType<typeof errors.NotFoundError>).code, 'POST_NOT_FOUND');
          return true;
        },
      );
      // All or nothing: the valid row was rolled back too.
      assert.equal((await knex('members_post_progress').select('id')).length, 0);
    });

    it('rethrows errors other than a foreign key violation', async function () {
      await knex.schema.dropTable('members_post_progress');

      await assert.rejects(
        repository.upsert(MEMBER, [{ postId: LESSON_1, status: 'started' }], new Date()),
        (err: unknown) => {
          assert.ok(!(err instanceof errors.NotFoundError), String(err));
          return true;
        },
      );
    });

    it('writes nothing for an empty batch', async function () {
      assert.deepEqual(await repository.upsert(MEMBER, [], new Date()), []);
    });

    it('rows go when the member or the post is deleted (cascade)', async function () {
      await repository.upsert(
        MEMBER,
        [
          { postId: LESSON_1, status: 'started' },
          { postId: LESSON_2, status: 'started' },
        ],
        new Date(),
      );

      await knex('posts_tags').where({ post_id: LESSON_2 }).del();
      await knex('posts').where({ id: LESSON_2 }).del();
      assert.deepEqual(
        (await knex('members_post_progress').select('post_id')).map((r) => r.post_id),
        [LESSON_1],
      );

      await knex('members').where({ id: MEMBER }).del();
      assert.equal((await knex('members_post_progress').select('id')).length, 0);
    });
  });

  describe('browse', function () {
    beforeEach(async function () {
      await repository.upsert(
        MEMBER,
        [
          { postId: LESSON_1, status: 'completed' },
          { postId: LESSON_2, status: 'started' },
          { postId: LESSON_3, status: 'started' },
        ],
        new Date('2026-10-06T04:10:00.000Z'),
      );
      await repository.upsert(OTHER_MEMBER, [{ postId: LESSON_1, status: 'started' }], new Date());
    });

    it('by post returns the caller row only', async function () {
      assert.deepEqual(await repository.browseByPost(MEMBER, LESSON_1), [
        { post_id: LESSON_1, status: 'completed', updated_at: '2026-10-06T04:10:00.000Z' },
      ]);
    });

    it('by post returns nothing when there is no row', async function () {
      assert.deepEqual(await repository.browseByPost(MEMBER, DRAFT), []);
    });

    it('by tag returns each tagged post once, for the caller only', async function () {
      const rows = await repository.browseByTag(MEMBER, 'hash-course-x');

      assert.deepEqual(rows, [
        { post_id: LESSON_1, status: 'completed', updated_at: '2026-10-06T04:10:00.000Z' },
        { post_id: LESSON_2, status: 'started', updated_at: '2026-10-06T04:10:00.000Z' },
      ]);
      const other = await repository.browseByTag(OTHER_MEMBER, 'hash-course-x');
      assert.deepEqual(
        other.map((row) => [row.post_id, row.status]),
        [[LESSON_1, 'started']],
      );
      assert.match(other[0].updated_at, ISO);
    });

    it('by unknown tag returns nothing', async function () {
      assert.deepEqual(await repository.browseByTag(MEMBER, 'nope'), []);
    });

    it('falls back to created_at when updated_at is null', async function () {
      await knex('members_post_progress')
        .where({ member_id: MEMBER, post_id: LESSON_3 })
        .update({ updated_at: null, created_at: '2026-09-01 08:00:00' });

      assert.deepEqual(await repository.browseByPost(MEMBER, LESSON_3), [
        { post_id: LESSON_3, status: 'started', updated_at: '2026-09-01T08:00:00.000Z' },
      ]);
    });
  });

  describe('getPublishedPosts', function () {
    it('returns published posts with tiers in sort order, and nothing else', async function () {
      const posts = await repository.getPublishedPosts([
        LESSON_1,
        LESSON_2,
        DRAFT,
        PAGE,
        SCHEDULED,
        'eeeeeeeeeeeeeeeeeeeeeee1',
      ]);

      const byId = new Map(posts.map((post) => [post.id, post]));
      assert.deepEqual([...byId.keys()].sort(), [LESSON_1, LESSON_2]);
      assert.deepEqual(byId.get(LESSON_1), {
        id: LESSON_1,
        visibility: 'tiers',
        tiers: [
          { id: TIER_A, slug: 'tier-a', type: 'paid' },
          { id: TIER_B, slug: 'tier-b', type: 'paid' },
          { id: FREE, slug: 'free', type: 'free' },
        ],
      });
      assert.deepEqual(byId.get(LESSON_2), { id: LESSON_2, visibility: 'members', tiers: [] });
    });

    it('makes no query for an empty list', async function () {
      await knex.destroy();
      assert.deepEqual(await repository.getPublishedPosts([]), []);
      knex = createSqliteKnex();
    });
  });
});
