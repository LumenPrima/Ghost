import assert from 'node:assert/strict';
import sinon from 'sinon';
import createKnex, { type Knex } from 'knex';
import { DripIndex, queryDripTagRows } from '../../../../../core/server/services/drip/drip-index';
import type { DripTagRow } from '../../../../../core/server/services/drip/drip-tags';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

describe('drip index', function () {
  describe('queryDripTagRows', function () {
    let knex: Knex;

    beforeEach(async function () {
      knex = createKnex({
        client: 'better-sqlite3',
        connection: { filename: ':memory:' },
        useNullAsDefault: true,
      });
      await knex.schema.createTable('tags', (table) => {
        table.string('id', 24).primary();
        table.string('name', 191).notNullable();
        table.string('slug', 191).notNullable().unique();
        table.string('visibility', 50).notNullable().defaultTo('public');
      });
      await knex.schema.createTable('posts_tags', (table) => {
        table.string('id', 24).primary();
        table.string('post_id', 24).notNullable();
        table.string('tag_id', 24).notNullable();
      });
      await knex('tags').insert([
        { id: 't1', name: '#drip-3', slug: 'hash-drip-3', visibility: 'internal' },
        // Renamed from #drip-3: the slug was not regenerated.
        { id: 't2', name: '#drip-5', slug: 'hash-drip-3-old', visibility: 'internal' },
        // Imported: no hash- prefix on the slug.
        { id: 't3', name: '#drip-7', slug: 'drip-7', visibility: 'internal' },
        // Duplicate name: -2 suffix on the slug.
        { id: 't4', name: '#drip-3', slug: 'hash-drip-3-2', visibility: 'internal' },
        // A public tag that looks like a drip tag: ignored.
        { id: 't5', name: '#drip-9', slug: 'drip-9-public', visibility: 'public' },
        { id: 't6', name: '#lesson', slug: 'hash-lesson', visibility: 'internal' },
        { id: 't7', name: '#drip-soon', slug: 'hash-drip-soon', visibility: 'internal' },
      ]);
      await knex('posts_tags').insert([
        { id: 'pt1', post_id: 'p1', tag_id: 't1' },
        { id: 'pt2', post_id: 'p2', tag_id: 't2' },
        { id: 'pt3', post_id: 'p3', tag_id: 't3' },
        { id: 'pt4', post_id: 'p4', tag_id: 't4' },
        { id: 'pt5', post_id: 'p5', tag_id: 't5' },
        { id: 'pt6', post_id: 'p1', tag_id: 't6' },
        { id: 'pt7', post_id: 'p6', tag_id: 't7' },
      ]);
    });

    afterEach(async function () {
      await knex.destroy();
    });

    it('returns internal #drip-* tag names per post, whatever the slug', async function () {
      const rows = await queryDripTagRows(knex);

      assert.deepEqual(
        rows.sort((a, b) => a.post_id.localeCompare(b.post_id)),
        [
          { post_id: 'p1', name: '#drip-3' },
          { post_id: 'p2', name: '#drip-5' },
          { post_id: 'p3', name: '#drip-7' },
          { post_id: 'p4', name: '#drip-3' },
          { post_id: 'p6', name: '#drip-soon' },
        ],
      );
    });

    it('feeds an index that parses the names', async function () {
      const index = new DripIndex({
        loadRows: () => queryDripTagRows(knex),
        logger: { error: sinon.stub() },
      });
      assert.equal(await index.reload(), true);

      assert.equal(index.get('p1'), 3);
      assert.equal(index.get('p2'), 5);
      assert.equal(index.get('p3'), 7);
      assert.equal(index.get('p4'), 3);
      assert.equal(index.get('p5'), null);
      assert.equal(index.get('p6'), null);
      assert.equal(index.size, 4);
    });
  });

  describe('DripIndex', function () {
    it('is empty and unloaded before the first reload', function () {
      const index = new DripIndex({ loadRows: async () => [], logger: { error: sinon.stub() } });

      assert.equal(index.loaded, false);
      assert.equal(index.get('p1'), null);
      assert.equal(index.get(undefined), null);
    });

    it('swaps in the new map after a successful reload', async function () {
      let rows: DripTagRow[] = [{ post_id: 'p1', name: '#drip-3' }];
      const index = new DripIndex({ loadRows: async () => rows, logger: { error: sinon.stub() } });

      await index.reload();
      assert.equal(index.get('p1'), 3);

      rows = [{ post_id: 'p2', name: '#drip-4' }];
      await index.reload();
      assert.equal(index.get('p1'), null);
      assert.equal(index.get('p2'), 4);
    });

    it('keeps the old map and logs when a reload fails', async function () {
      const logger = { error: sinon.stub() };
      const loadRows = sinon.stub();
      loadRows.onFirstCall().resolves([{ post_id: 'p1', name: '#drip-3' }]);
      loadRows.onSecondCall().rejects(new Error('db down'));
      loadRows.onThirdCall().resolves([{ post_id: 'p1', name: '#drip-6' }]);
      const index = new DripIndex({ loadRows, logger });

      assert.equal(await index.reload(), true);
      assert.equal(await index.reload(), false);
      assert.equal(index.get('p1'), 3);
      assert.equal(index.loaded, true);
      sinon.assert.calledOnce(logger.error);
      assert.match(String(logger.error.firstCall.args[0].message), /drip\.index_reload_failed/);

      // The next reload recovers.
      assert.equal(await index.reload(), true);
      assert.equal(index.get('p1'), 6);
    });

    it('keeps nothing loaded when the very first load fails', async function () {
      const index = new DripIndex({
        loadRows: sinon.stub().rejects(new Error('boom')),
        logger: { error: sinon.stub() },
      });

      assert.equal(await index.reload(), false);
      assert.equal(index.loaded, false);
      assert.equal(index.get('p1'), null);
    });

    it('coalesces a burst into one reload in flight plus one queued', async function () {
      const first = deferred<DripTagRow[]>();
      const second = deferred<DripTagRow[]>();
      const loadRows = sinon.stub();
      loadRows.onFirstCall().returns(first.promise);
      loadRows.onSecondCall().returns(second.promise);
      loadRows.onThirdCall().resolves([{ post_id: 'p1', name: '#drip-9' }]);
      const index = new DripIndex({ loadRows, logger: { error: sinon.stub() } });

      const a = index.reload();
      const b = index.reload();
      const c = index.reload();
      const d = index.reload();

      assert.equal(a === b, false);
      assert.equal(b, c);
      assert.equal(c, d);
      sinon.assert.calledOnce(loadRows);

      first.resolve([{ post_id: 'p1', name: '#drip-1' }]);
      assert.equal(await a, true);
      await flush();
      assert.equal(index.get('p1'), 1);
      // The queued reload starts only after the first finishes.
      sinon.assert.calledTwice(loadRows);

      second.resolve([{ post_id: 'p1', name: '#drip-2' }]);
      assert.equal(await b, true);
      assert.equal(index.get('p1'), 2);
      sinon.assert.calledTwice(loadRows);

      // Once idle, a new reload runs straight away.
      assert.equal(await index.reload(), true);
      assert.equal(index.get('p1'), 9);
      sinon.assert.calledThrice(loadRows);
    });

    it('queues again while the queued reload is running', async function () {
      const first = deferred<DripTagRow[]>();
      const second = deferred<DripTagRow[]>();
      const loadRows = sinon.stub();
      loadRows.onFirstCall().returns(first.promise);
      loadRows.onSecondCall().returns(second.promise);
      loadRows.onThirdCall().resolves([{ post_id: 'p1', name: '#drip-3' }]);
      const index = new DripIndex({ loadRows, logger: { error: sinon.stub() } });

      index.reload();
      const queued = index.reload();
      first.resolve([]);
      await flush();
      sinon.assert.calledTwice(loadRows);

      // The second load is in flight now; a new event queues a third.
      const third = index.reload();
      assert.notEqual(third, queued);
      second.resolve([{ post_id: 'p1', name: '#drip-2' }]);
      assert.equal(await queued, true);
      assert.equal(await third, true);
      sinon.assert.calledThrice(loadRows);
      assert.equal(index.get('p1'), 3);
    });

    it('a failed in-flight reload still lets the queued one run', async function () {
      const first = deferred<DripTagRow[]>();
      const loadRows = sinon.stub();
      loadRows.onFirstCall().returns(first.promise);
      loadRows.onSecondCall().resolves([{ post_id: 'p1', name: '#drip-4' }]);
      const logger = { error: sinon.stub() };
      const index = new DripIndex({ loadRows, logger });

      const a = index.reload();
      const b = index.reload();
      first.reject(new Error('timeout'));

      assert.equal(await a, false);
      assert.equal(await b, true);
      assert.equal(index.get('p1'), 4);
      sinon.assert.calledOnce(logger.error);
    });

    it('clear empties the index', async function () {
      const index = new DripIndex({
        loadRows: async () => [{ post_id: 'p1', name: '#drip-3' }],
        logger: { error: sinon.stub() },
      });
      await index.reload();

      index.clear();
      assert.equal(index.get('p1'), null);
      assert.equal(index.loaded, false);
    });
  });
});
