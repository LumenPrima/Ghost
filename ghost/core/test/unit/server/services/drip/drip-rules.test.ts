import assert from 'node:assert/strict';
import sinon from 'sinon';
import type { AccessStarts } from '../../../../../core/server/services/drip/access-starts';
import {
  evaluateDrip,
  isRealMember,
  startForPost,
  unlockTime,
  type EvaluateDripInput,
} from '../../../../../core/server/services/drip/drip-rules';

const COURSE = 'course_tier_000000000000';
const LIBRARY = 'library_tier_00000000000';
const FREE = 'free_tier_00000000000000';

const SIGNUP = '2026-01-01T10:00:00.000Z';

function at(iso: string) {
  return new Date(iso);
}

describe('drip rules', function () {
  describe('unlockTime (calendar days in the site timezone)', function () {
    it('opens at local midnight N days after the start day (theme contract example)', function () {
      // Bought 6 Oct 21:00 New York (EDT, UTC-4) → #drip-3 opens 9 Oct 00:00 New York.
      const start = at('2026-10-07T01:00:00.000Z');

      assert.equal(
        unlockTime(start, 3, 'America/New_York').toISOString(),
        '2026-10-09T04:00:00.000Z',
      );
      // The same instant in UTC is already 7 Oct, so it opens a day later there.
      assert.equal(unlockTime(start, 3, 'Etc/UTC').toISOString(), '2026-10-10T00:00:00.000Z');
    });

    it('aligns to the start of the day, not 24-hour blocks', function () {
      const late = unlockTime(at('2026-10-06T21:00:00.000Z'), 3, 'Etc/UTC');
      const early = unlockTime(at('2026-10-06T00:00:01.000Z'), 3, 'Etc/UTC');

      assert.equal(late.toISOString(), '2026-10-09T00:00:00.000Z');
      assert.equal(early.toISOString(), '2026-10-09T00:00:00.000Z');
    });

    it('counts calendar days across the spring DST change (Europe/London)', function () {
      // 27 Mar 12:00 GMT; clocks go forward on 29 Mar. 30 Mar 00:00 BST = 29 Mar 23:00 UTC.
      const unlock = unlockTime(at('2026-03-27T12:00:00.000Z'), 3, 'Europe/London');

      assert.equal(unlock.toISOString(), '2026-03-29T23:00:00.000Z');
      // 72 hours from the start of the day would be an hour late.
      assert.notEqual(unlock.toISOString(), '2026-03-30T00:00:00.000Z');
    });

    it('counts calendar days across the autumn DST change (America/New_York)', function () {
      // 30 Oct 10:00 EDT; clocks go back on 1 Nov. 2 Nov 00:00 EST = 05:00 UTC.
      const unlock = unlockTime(at('2026-10-30T14:00:00.000Z'), 3, 'America/New_York');

      assert.equal(unlock.toISOString(), '2026-11-02T05:00:00.000Z');
    });

    it('uses the local date of the start, which can differ from the UTC date', function () {
      // 1 Jun 23:30 UTC is 2 Jun 00:30 in London (BST).
      const unlock = unlockTime(at('2026-06-01T23:30:00.000Z'), 1, 'Europe/London');

      assert.equal(unlock.toISOString(), '2026-06-02T23:00:00.000Z');
    });

    it('falls back to UTC for an invalid or empty zone', function () {
      const start = at('2026-10-06T21:00:00.000Z');

      assert.equal(unlockTime(start, 3, 'Not/AZone').toISOString(), '2026-10-09T00:00:00.000Z');
      assert.equal(unlockTime(start, 3, '').toISOString(), '2026-10-09T00:00:00.000Z');
    });
  });

  describe('isRealMember', function () {
    it('needs an id or uuid', function () {
      assert.equal(isRealMember({ id: 'm1' }), true);
      assert.equal(isRealMember({ uuid: 'u1' }), true);
      assert.equal(isRealMember({ status: 'paid', products: [] }), false); // paid shim
      assert.equal(isRealMember({ status: 'free' }), false); // preview shim
      assert.equal(isRealMember(null), false);
    });
  });

  describe('startForPost', function () {
    const starts: AccessStarts = {
      member: SIGNUP,
      products: {
        [COURSE]: '2026-03-01T00:00:00.000Z',
        [LIBRARY]: '2026-02-01T00:00:00.000Z',
      },
    };

    it('takes the earliest start over held tiers listed on the post', function () {
      const post = { visibility: 'tiers', tiers: [{ id: COURSE }, { id: LIBRARY }] };

      assert.equal(
        startForPost(post, { status: 'paid' }, starts)?.toISOString(),
        '2026-02-01T00:00:00.000Z',
      );
    });

    it('ignores held tiers that are not on the post', function () {
      const post = { visibility: 'tiers', tiers: [{ id: COURSE }] };

      assert.equal(
        startForPost(post, { status: 'paid' }, starts)?.toISOString(),
        '2026-03-01T00:00:00.000Z',
      );
    });

    it('counts a listed free tier from signup for a free member only', function () {
      const post = {
        visibility: 'tiers',
        tiers: [
          { id: FREE, type: 'free' },
          { id: COURSE, type: 'paid' },
        ],
      };

      assert.equal(startForPost(post, { status: 'free' }, starts)?.toISOString(), SIGNUP);
      assert.equal(
        startForPost(post, { status: 'paid' }, starts)?.toISOString(),
        '2026-03-01T00:00:00.000Z',
      );
    });

    it('falls back to signup when no listed tier is held', function () {
      const post = { visibility: 'tiers', tiers: [{ id: 'unheld' }] };

      assert.equal(startForPost(post, { status: 'free' }, starts)?.toISOString(), SIGNUP);
      assert.equal(startForPost({ visibility: 'tiers' }, {}, starts)?.toISOString(), SIGNUP);
    });

    it('returns null when there is no candidate and no signup', function () {
      assert.equal(
        startForPost({ visibility: 'tiers', tiers: [] }, {}, { member: null, products: {} }),
        null,
      );
    });
  });

  describe('evaluateDrip', function () {
    const NOW = at('2026-03-05T12:00:00.000Z');
    const realMember = { id: 'member_1', uuid: 'uuid-1', status: 'free' };
    const starts: AccessStarts = {
      member: SIGNUP,
      products: { [COURSE]: '2026-03-03T15:00:00.000Z' },
    };

    function input(overrides: Partial<EvaluateDripInput> = {}): EvaluateDripInput {
      return {
        post: {
          id: 'post_1',
          visibility: 'tiers',
          tiers: [{ id: COURSE, slug: 'course', type: 'paid' }],
        },
        member: realMember,
        getStarts: () => starts,
        days: 3,
        mode: 'enforce',
        memberHasAccess: true,
        preview: false,
        now: NOW,
        timezone: 'Etc/UTC',
        ...overrides,
      };
    }

    it('leaves access unchanged for a post with no drip days', function () {
      const getStarts = sinon.stub().returns(starts);
      assert.deepEqual(evaluateDrip(input({ days: null, getStarts })), {
        access: true,
        unlockAt: null,
      });
      assert.deepEqual(evaluateDrip(input({ days: null, memberHasAccess: false })), {
        access: false,
        unlockAt: null,
      });
      sinon.assert.notCalled(getStarts);
    });

    it('treats #drip-0 as no delay', function () {
      assert.deepEqual(evaluateDrip(input({ days: 0 })), { access: true, unlockAt: null });
    });

    it('does nothing in off mode', function () {
      assert.deepEqual(evaluateDrip(input({ mode: 'off' })), { access: true, unlockAt: null });
      assert.deepEqual(evaluateDrip(input({ mode: 'off', memberHasAccess: false })), {
        access: false,
        unlockAt: null,
      });
    });

    it('returns false with no unlock_at when the member has no access anyway (contract row 1)', function () {
      assert.deepEqual(evaluateDrip(input({ memberHasAccess: false })), {
        access: false,
        unlockAt: null,
      });
      assert.deepEqual(evaluateDrip(input({ memberHasAccess: false, preview: true })), {
        access: false,
        unlockAt: null,
      });
    });

    it('ignores drip tags on public, members and paid posts', function () {
      for (const visibility of ['public', 'members', 'paid']) {
        const getStarts = sinon.stub().returns(starts);
        assert.deepEqual(evaluateDrip(input({ post: { id: 'p', visibility }, getStarts })), {
          access: true,
          unlockAt: null,
        });
        sinon.assert.notCalled(getStarts);
      }
    });

    it('locks a future lesson in enforce mode with the exact unlock time', function () {
      // Start 3 Mar 15:00 UTC → day start 3 Mar → +3 days = 6 Mar 00:00 UTC; now is 5 Mar.
      assert.deepEqual(evaluateDrip(input()), {
        access: false,
        unlockAt: '2026-03-06T00:00:00.000Z',
      });
    });

    it('uses the site timezone for the unlock time', function () {
      // 3 Mar 15:00 UTC is 3 Mar 10:00 in New York (EST) → opens 6 Mar 00:00 EST = 05:00 UTC.
      assert.deepEqual(evaluateDrip(input({ timezone: 'America/New_York' })), {
        access: false,
        unlockAt: '2026-03-06T05:00:00.000Z',
      });
    });

    it('opens exactly at the unlock time', function () {
      assert.deepEqual(evaluateDrip(input({ now: at('2026-03-06T00:00:00.000Z') })), {
        access: true,
        unlockAt: null,
      });
      assert.deepEqual(evaluateDrip(input({ now: at('2026-03-05T23:59:59.999Z') })), {
        access: false,
        unlockAt: '2026-03-06T00:00:00.000Z',
      });
    });

    it('opens a past lesson with no unlock_at', function () {
      assert.deepEqual(evaluateDrip(input({ now: at('2026-04-01T00:00:00.000Z') })), {
        access: true,
        unlockAt: null,
      });
    });

    it('shows the unlock time without locking in advise mode', function () {
      assert.deepEqual(evaluateDrip(input({ mode: 'advise' })), {
        access: true,
        unlockAt: '2026-03-06T00:00:00.000Z',
      });
    });

    it('uses the earliest start over the post tiers the member holds', function () {
      const twoTiers = {
        id: 'post_1',
        visibility: 'tiers',
        tiers: [
          { id: COURSE, slug: 'course' },
          { id: LIBRARY, slug: 'library' },
        ],
      };
      const both: AccessStarts = {
        member: SIGNUP,
        products: { [COURSE]: '2026-03-03T15:00:00.000Z', [LIBRARY]: '2026-02-01T00:00:00.000Z' },
      };

      assert.deepEqual(evaluateDrip(input({ post: twoTiers, getStarts: () => both })), {
        access: true,
        unlockAt: null,
      });
    });

    it('gives a preview frame now + N days and keeps access', function () {
      const getStarts = sinon.stub().returns(null);
      // Preview shim: no id, no uuid, no starts.
      assert.deepEqual(
        evaluateDrip(input({ preview: true, member: { status: 'paid' }, getStarts })),
        {
          access: true,
          unlockAt: '2026-03-08T00:00:00.000Z',
        },
      );
      sinon.assert.notCalled(getStarts);
    });

    it('leaves shims (no id, no uuid) alone outside previews', function () {
      const getStarts = sinon.stub().returns(null);
      assert.deepEqual(
        evaluateDrip(input({ member: { status: 'paid', products: [] }, getStarts })),
        {
          access: true,
          unlockAt: null,
        },
      );
      assert.deepEqual(evaluateDrip(input({ member: null, getStarts })), {
        access: true,
        unlockAt: null,
      });
      sinon.assert.notCalled(getStarts);
    });

    it('fails closed for a real member without starts in enforce mode', function () {
      assert.deepEqual(evaluateDrip(input({ getStarts: () => null })), {
        access: false,
        unlockAt: null,
      });
      assert.deepEqual(
        evaluateDrip(input({ member: { uuid: 'uuid-only' }, getStarts: () => null })),
        {
          access: false,
          unlockAt: null,
        },
      );
    });

    it('stays open for a real member without starts in advise mode', function () {
      assert.deepEqual(evaluateDrip(input({ mode: 'advise', getStarts: () => null })), {
        access: true,
        unlockAt: null,
      });
    });

    it('fails closed when no start can be found at all', function () {
      const empty: AccessStarts = { member: null, products: {} };

      assert.deepEqual(evaluateDrip(input({ getStarts: () => empty })), {
        access: false,
        unlockAt: null,
      });
      assert.deepEqual(evaluateDrip(input({ mode: 'advise', getStarts: () => empty })), {
        access: true,
        unlockAt: null,
      });
    });
  });
});
