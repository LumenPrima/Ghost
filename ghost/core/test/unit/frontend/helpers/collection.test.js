const assert = require('node:assert/strict');
const sinon = require('sinon');
const configUtils = require('../../../utils/config-utils');
const loggingLib = require('@tryghost/logging');

// Stuff we are testing
const collection = require('../../../../core/frontend/helpers/collection');
const api = require('../../../../core/server/api').endpoints;

describe('{{#collection}} helper', function () {
  let fn;
  let inverse;
  let locals = {};
  let logging;

  beforeEach(function () {
    fn = sinon.spy();
    inverse = sinon.spy();

    locals = { root: { _locals: {} } };

    logging = {
      error: sinon.stub(loggingLib, 'error'),
      warn: sinon.stub(loggingLib, 'warn'),
    };
  });

  afterEach(async function () {
    sinon.restore();
    await configUtils.restore();
  });

  describe('optimization', function () {
    beforeEach(function () {
      sinon.stub(api, 'postsPublic').get(() => {
        return {
          browse: () => {
            return new Promise((resolve) => {
              setTimeout(() => {
                resolve({ posts: [{ id: 'abcd1234' }] });
              }, 5);
            });
          },
        };
      });
    });

    it('should log an error and flag a degraded render if it hits the timeout threshold', async function () {
      const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        configUtils.set('optimization:getHelper:timeout:threshold', 1);

        const resultPromise = collection.call({}, 'featured', {
          hash: {},
          data: locals,
          fn: fn,
          inverse: inverse,
        });
        // 2 > threshold (1), < stub's 5 — fires only the helper's timer.
        await clock.tickAsync(2);
        await resultPromise;

        assert.equal(locals.root._locals.degradedRender, true);
        sinon.assert.calledOnce(logging.error);
        sinon.assert.calledOnce(fn);
        const args = fn.firstCall.args[0];
        assert(args && typeof args === 'object');
        assert.deepEqual(args.posts, []);
        assert(!('@@ABORTED_GET_HELPER@@' in args));
      } finally {
        clock.restore();
      }
    });

    it('should return safely on timeout when _locals is not available', async function () {
      const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        configUtils.set('optimization:getHelper:timeout:threshold', 1);
        locals = { root: {} };

        const resultPromise = collection.call({}, 'featured', {
          hash: {},
          data: locals,
          fn: fn,
          inverse: inverse,
        });
        await clock.tickAsync(2);
        await resultPromise;

        sinon.assert.calledOnce(fn);
        const args = fn.firstCall.args[0];
        assert.deepEqual(args.posts, []);
        assert(!('@@ABORTED_GET_HELPER@@' in args));
      } finally {
        clock.restore();
      }
    });
  });

  // fork(salvare): theme contract §5 and drip
  describe('auth', function () {
    let browseStub;

    beforeEach(function () {
      browseStub = sinon.stub().resolves({ posts: [] });
      sinon.stub(api, 'postsPublic').get(() => {
        return {
          browse: browseStub,
        };
      });
    });

    it('passes @member unchanged when there is no session member', async function () {
      const member = { uuid: 'test' };
      locals = { root: { _locals: {} }, member };

      await collection.call({}, 'featured', { hash: {}, data: locals, fn: fn, inverse: inverse });

      assert.equal(browseStub.firstCall.args[0].context.member, member);
    });

    it("adds the session member's tier ids/slugs and access starts to the member context", async function () {
      const member = { uuid: 'test' };
      const accessStarts = {
        member: '2026-01-01T00:00:00.000Z',
        products: { 'product-1': '2026-02-01T00:00:00.000Z' },
      };
      const session = {
        uuid: 'test',
        email: 'member@example.com',
        unsubscribe_url: 'https://example.com/unsubscribe/?key=secret',
        products: [{ id: 'product-1', slug: 'anxiety', name: 'Anxiety', expiry_at: null }],
        // drip uses access starts already on the member as is (Phase 3 amendment B1)
        access_starts: accessStarts,
      };
      locals = { root: { _locals: { member: session } }, member };

      await collection.call({}, 'featured', { hash: {}, data: locals, fn: fn, inverse: inverse });

      assert.deepEqual(browseStub.firstCall.args[0].context.member, {
        uuid: 'test',
        products: [{ id: 'product-1', slug: 'anxiety' }],
        access_starts: accessStarts,
      });
      assert.deepEqual(member, { uuid: 'test' });
    });
  });
});
