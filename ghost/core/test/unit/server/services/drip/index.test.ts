import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import sinon from 'sinon';

// Required (not imported) so this file shares the CommonJS instances that
// post-gating.js, config and the settings cache use.
const drip = require('../../../../../core/server/services/drip');
const configUtils = require('../../../../utils/config-utils');
const settingsCache = require('../../../../../core/shared/settings-cache');

const COURSE = 'course_tier_000000000000';
const DAY = 24 * 60 * 60 * 1000;

const flush = () =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

function startOfUtcDay(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

describe('drip service (index)', function () {
  let events: EventEmitter;
  let logger: { error: sinon.SinonStub; warn: sinon.SinonStub };

  async function initWith(rows: Array<{ post_id: string; name: string }>) {
    await drip.init({ loadRows: async () => rows, events, logger });
  }

  beforeEach(function () {
    events = new EventEmitter();
    logger = { error: sinon.stub(), warn: sinon.stub() };
    drip.reset();
  });

  afterEach(async function () {
    drip.reset();
    sinon.restore();
    await configUtils.restore();
  });

  describe('getMode', function () {
    it('defaults to advise', function () {
      configUtils.set('salvare:drip:mode', undefined);
      assert.equal(drip.getMode(), 'advise');
      configUtils.set('salvare:drip:mode', '');
      assert.equal(drip.getMode(), 'advise');
    });

    it('reads enforce, advise and off on every call', function () {
      for (const mode of ['enforce', 'advise', 'off']) {
        configUtils.set('salvare:drip:mode', mode);
        assert.equal(drip.getMode(), mode);
      }
      configUtils.set('salvare:drip:mode', ' Enforce ');
      assert.equal(drip.getMode(), 'enforce');
    });

    it('treats unknown values as enforce (fail closed)', function () {
      for (const value of ['enforced', 'on', 'true', true, 1]) {
        configUtils.set('salvare:drip:mode', value);
        assert.equal(drip.getMode(), 'enforce', String(value));
      }
    });
  });

  describe('init and the index', function () {
    it('sees an empty index before init, so drip does nothing', function () {
      assert.equal(drip.getDripDays('p1'), null);
      const attrs = { id: 'p1', visibility: 'tiers', tiers: [{ id: COURSE }] };
      assert.equal(
        drip.applyToPost(
          attrs,
          { options: {}, original: { context: { member: { id: 'm' } } } },
          true,
        ),
        true,
      );
      assert.equal('unlock_at' in attrs, false);
    });

    it('loads the index from tag names', async function () {
      await initWith([
        { post_id: 'p1', name: '#drip-3' },
        { post_id: 'p1', name: '#drip-5' },
        { post_id: 'p2', name: '#drip-0' },
      ]);

      assert.equal(drip.getDripDays('p1'), 5);
      assert.equal(drip.getDripDays('p2'), 0);
      assert.equal(drip.getDripDays('p3'), null);
    });

    it('reloads on post, tag and site change events, then stops after reset', async function () {
      let rows = [{ post_id: 'p1', name: '#drip-3' }];
      const loadRows = sinon.spy(async () => rows);
      await drip.init({ loadRows, events, logger });
      sinon.assert.calledOnce(loadRows);

      for (const event of [
        'site.changed',
        'post.added',
        'post.edited',
        'post.deleted',
        'post.published',
        'post.unpublished',
        'post.tag.attached',
        'post.tag.detached',
        'tag.added',
        'tag.edited',
        'tag.deleted',
      ]) {
        assert.ok(drip.RELOAD_EVENTS.includes(event), event);
        assert.equal(events.listenerCount(event), 1, event);
      }

      rows = [{ post_id: 'p1', name: '#drip-8' }];
      events.emit('tag.edited');
      await flush();
      assert.equal(drip.getDripDays('p1'), 8);

      drip.reset();
      for (const event of drip.RELOAD_EVENTS) {
        assert.equal(events.listenerCount(event), 0, event);
      }
      assert.equal(drip.getDripDays('p1'), null);
    });

    it('re-init reloads without subscribing twice', async function () {
      let rows = [{ post_id: 'p1', name: '#drip-3' }];
      await drip.init({ loadRows: async () => rows, events, logger });

      rows = [{ post_id: 'p1', name: '#drip-4' }];
      await drip.init({ loadRows: async () => [], events, logger });

      assert.equal(drip.getDripDays('p1'), 4);
      assert.equal(events.listenerCount('post.edited'), 1);
    });

    it('rejects when the first load fails, leaving drip inactive', async function () {
      await assert.rejects(
        drip.init({ loadRows: async () => Promise.reject(new Error('db down')), events, logger }),
        /initial drip index load failed/,
      );
      assert.equal(drip.getDripDays('p1'), null);
      assert.equal(events.listenerCount('post.edited'), 0);
    });

    it('keeps the old index when an event-driven reload fails', async function () {
      const loadRows = sinon.stub();
      loadRows.onFirstCall().resolves([{ post_id: 'p1', name: '#drip-3' }]);
      loadRows.onSecondCall().rejects(new Error('db down'));
      await drip.init({ loadRows, events, logger });

      events.emit('post.edited');
      await flush();

      assert.equal(drip.getDripDays('p1'), 3);
      sinon.assert.calledOnce(logger.error);
    });
  });

  describe('cache guard', function () {
    for (const key of ['cacheMembersContent:enabled', 'hostSettings:postsPublicCache:enabled']) {
      it(`refuses to boot in enforce mode when ${key} is on`, async function () {
        configUtils.set('salvare:drip:mode', 'enforce');
        configUtils.set(key, true);
        const loadRows = sinon.stub().resolves([]);

        await assert.rejects(drip.init({ loadRows, events, logger }), (err: Error) => {
          assert.match(err.message, new RegExp(key.replace(/[:.]/g, '.')));
          return true;
        });
        sinon.assert.notCalled(loadRows);
        assert.equal(events.listenerCount('post.edited'), 0);
      });

      it(`only warns in advise mode when ${key} is on`, async function () {
        configUtils.set('salvare:drip:mode', 'advise');
        configUtils.set(key, true);

        await drip.init({ loadRows: async () => [], events, logger });
        sinon.assert.calledOnce(logger.warn);
      });
    }

    it('stays quiet in off mode or with the caches off', async function () {
      configUtils.set('salvare:drip:mode', 'off');
      configUtils.set('cacheMembersContent:enabled', true);
      await drip.init({ loadRows: async () => [], events, logger });
      drip.reset();

      configUtils.set('salvare:drip:mode', 'enforce');
      configUtils.set('cacheMembersContent:enabled', false);
      configUtils.set('hostSettings:postsPublicCache:enabled', false);
      await drip.init({ loadRows: async () => [], events, logger });

      sinon.assert.notCalled(logger.warn);
    });

    it('treats an unknown mode as enforce for the guard', async function () {
      configUtils.set('salvare:drip:mode', 'strict');
      configUtils.set('cacheMembersContent:enabled', true);

      await assert.rejects(drip.init({ loadRows: async () => [], events, logger }));
    });
  });

  describe('computeAccessStarts', function () {
    it('memoises per member object', function () {
      const member = {
        id: 'm1',
        created_at: '2026-01-01T00:00:00.000Z',
        products: [{ id: COURSE }],
        productEvents: [
          { product_id: COURSE, action: 'added', created_at: '2026-02-01T00:00:00.000Z' },
        ],
      };

      const first = drip.computeAccessStarts(member);
      assert.deepEqual(first, {
        member: '2026-01-01T00:00:00.000Z',
        products: { [COURSE]: '2026-02-01T00:00:00.000Z' },
      });

      member.productEvents = [];
      assert.equal(drip.computeAccessStarts(member), first);
      // A fresh object is computed afresh.
      assert.notEqual(drip.computeAccessStarts({ ...member }), first);
    });

    it('returns null without data and for non-objects', function () {
      assert.equal(drip.computeAccessStarts({ uuid: 'u' }), null);
      assert.equal(drip.computeAccessStarts(null), null);
      assert.equal(drip.computeAccessStarts(undefined), null);
    });
  });

  describe('evaluate and applyToPost', function () {
    const now = new Date();
    const recent = new Date(now.getTime() - DAY).toISOString();
    const longAgo = new Date(now.getTime() - 30 * DAY).toISOString();

    function realMember(addedAt = recent) {
      return {
        id: 'member_1',
        uuid: 'uuid-1',
        status: 'free',
        created_at: longAgo,
        products: [{ id: COURSE, slug: 'course' }],
        productEvents: [{ product_id: COURSE, action: 'added', created_at: addedAt }],
        subscriptions: [],
      };
    }

    function post(id = 'p1'): {
      id: string;
      visibility: string;
      tiers: Array<{ id: string; slug: string; type: string }>;
      unlock_at?: string;
    } {
      return { id, visibility: 'tiers', tiers: [{ id: COURSE, slug: 'course', type: 'paid' }] };
    }

    function frame(
      member: unknown,
      options: Record<string, unknown> = {},
      extra: Record<string, unknown> = {},
    ) {
      return { options, original: { context: { member } }, ...extra };
    }

    beforeEach(async function () {
      sinon.stub(settingsCache, 'get').withArgs('timezone').returns('Etc/UTC');
      await initWith([{ post_id: 'p1', name: '#drip-3' }]);
    });

    it('defaults to advise: unlock_at without locking', function () {
      const attrs = post();

      assert.equal(drip.applyToPost(attrs, frame(realMember()), true), true);
      const expected = new Date(startOfUtcDay(new Date(recent)).getTime() + 3 * DAY).toISOString();
      assert.equal(attrs.unlock_at, expected);
    });

    it('locks in enforce mode and uses the site timezone', function () {
      configUtils.set('salvare:drip:mode', 'enforce');
      const at = new Date('2026-03-03T15:00:00.000Z');
      const member = realMember(at.toISOString());

      (settingsCache.get as sinon.SinonStub).withArgs('timezone').returns('America/New_York');
      assert.deepEqual(
        drip.evaluate(post(), member, {
          memberHasAccess: true,
          now: new Date('2026-03-05T12:00:00.000Z'),
        }),
        {
          access: false,
          unlockAt: '2026-03-06T05:00:00.000Z',
        },
      );
    });

    it('opens a lesson whose unlock time has passed', function () {
      configUtils.set('salvare:drip:mode', 'enforce');
      const attrs = post();

      assert.equal(drip.applyToPost(attrs, frame(realMember(longAgo)), true), true);
      assert.equal('unlock_at' in attrs, false);
    });

    it('leaves posts outside the index alone', function () {
      configUtils.set('salvare:drip:mode', 'enforce');
      const attrs = post('p2');

      assert.equal(drip.applyToPost(attrs, frame(realMember()), true), true);
      assert.equal(drip.applyToPost(attrs, frame(realMember()), false), false);
      assert.equal('unlock_at' in attrs, false);
    });

    it('does nothing in off mode', function () {
      configUtils.set('salvare:drip:mode', 'off');
      const attrs = post();

      assert.equal(drip.applyToPost(attrs, frame(realMember()), true), true);
      assert.equal('unlock_at' in attrs, false);
    });

    it('never adds unlock_at when the member has no access', function () {
      configUtils.set('salvare:drip:mode', 'enforce');
      const attrs = post();

      assert.equal(drip.applyToPost(attrs, frame(null), false), false);
      assert.equal('unlock_at' in attrs, false);
    });

    it('fails closed for a real member without starts in enforce mode', function () {
      configUtils.set('salvare:drip:mode', 'enforce');
      // The plain @member template object: uuid, no productEvents, no access_starts.
      const templateMember = { uuid: 'uuid-1', status: 'free', subscriptions: [] };
      const attrs = post();

      assert.equal(drip.applyToPost(attrs, frame(templateMember), true), false);
      assert.equal('unlock_at' in attrs, false);
    });

    it('stays open for a real member without starts in advise mode', function () {
      configUtils.set('salvare:drip:mode', 'advise');
      const attrs = post();

      assert.equal(drip.applyToPost(attrs, frame({ uuid: 'uuid-1', status: 'free' }), true), true);
      assert.equal('unlock_at' in attrs, false);
    });

    it('uses a precomputed access_starts from the trimmed theme-helper context', function () {
      configUtils.set('salvare:drip:mode', 'enforce');
      const context = {
        uuid: 'uuid-1',
        status: 'free',
        products: [{ id: COURSE, slug: 'course' }],
        access_starts: { member: longAgo, products: { [COURSE]: longAgo } },
      };

      assert.equal(drip.applyToPost(post(), frame(context), true), true);
    });

    it('leaves gift-link and preview shims unchanged outside previews', function () {
      configUtils.set('salvare:drip:mode', 'enforce');
      const attrs = post();

      assert.equal(drip.applyToPost(attrs, frame({ status: 'paid', products: [] }), true), true);
      assert.equal('unlock_at' in attrs, false);
    });

    it('gives a preview frame now + N days with access', function () {
      configUtils.set('salvare:drip:mode', 'enforce');
      const attrs = post();

      assert.equal(
        drip.applyToPost(attrs, frame({ status: 'paid' }, {}, { isPreview: true }), true),
        true,
      );
      const today = startOfUtcDay(new Date());
      assert.equal(attrs.unlock_at, new Date(today.getTime() + 3 * DAY).toISOString());
    });

    it('follows the fields rule for unlock_at', function () {
      configUtils.set('salvare:drip:mode', 'enforce');

      const withoutField = post();
      assert.equal(
        drip.applyToPost(
          withoutField,
          frame(realMember(), { columns: ['id', 'title', 'access'] }),
          true,
        ),
        false,
      );
      assert.equal('unlock_at' in withoutField, false);

      const withField = post();
      assert.equal(
        drip.applyToPost(
          withField,
          frame(realMember(), { columns: ['id', 'access', 'unlock_at'] }),
          true,
        ),
        false,
      );
      assert.equal(typeof withField.unlock_at, 'string');
    });

    it('evaluate passes through posts that are not dripped', function () {
      assert.deepEqual(drip.evaluate({ id: 'nope' }, realMember(), { memberHasAccess: false }), {
        access: false,
        unlockAt: null,
      });
      assert.deepEqual(drip.evaluate(null, realMember(), { memberHasAccess: true }), {
        access: true,
        unlockAt: null,
      });
    });
  });
});
