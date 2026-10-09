import assert from 'node:assert/strict';
import {
  MAX_DRIP_DAYS,
  buildDripDaysMap,
  parseDripTagName,
} from '../../../../../core/server/services/drip/drip-tags';

describe('drip tags', function () {
  describe('parseDripTagName', function () {
    it('reads the days from a #drip-<n> name', function () {
      assert.equal(parseDripTagName('#drip-3'), 3);
      assert.equal(parseDripTagName('#drip-03'), 3);
      assert.equal(parseDripTagName('#drip-0'), 0);
      assert.equal(parseDripTagName('#DRIP-7'), 7);
      assert.equal(parseDripTagName('  #drip-5 '), 5);
    });

    it('clamps to the maximum', function () {
      assert.equal(parseDripTagName('#drip-99999'), MAX_DRIP_DAYS);
      assert.equal(parseDripTagName('#drip-3650'), 3650);
      assert.equal(parseDripTagName('#drip-3651'), 3650);
    });

    it('rejects names that are not drip tags', function () {
      for (const name of [
        'drip-3', // no hash: a public tag
        '#drip-',
        '#drip-x',
        '#drip-3x',
        '#drip-123456', // more than five digits
        '#drip--3',
        '#drip-3.5',
        '#course-anxiety',
        'hash-drip-3', // a slug, not a name
        '',
        null,
        undefined,
        3,
      ]) {
        assert.equal(parseDripTagName(name), null, String(name));
      }
    });

    it('reads renamed, imported and duplicated tags from the name, whatever their slug', function () {
      // Renamed #drip-3 → #drip-5: the slug stays hash-drip-3, the name is the truth.
      assert.equal(parseDripTagName('#drip-5'), 5);
      // Imported: the slug is drip-3 (no hash- prefix), the name is unchanged.
      assert.equal(parseDripTagName('#drip-3'), 3);
      // A second tag named #drip-3 gets the slug hash-drip-3-2; its name still parses.
      assert.equal(parseDripTagName('hash-drip-3-2'), null);
    });
  });

  describe('buildDripDaysMap', function () {
    it('groups rows per post and takes the largest', function () {
      const map = buildDripDaysMap([
        { post_id: 'p1', name: '#drip-3' },
        { post_id: 'p1', name: '#drip-5' },
        { post_id: 'p2', name: '#drip-0' },
        { post_id: 'p3', name: '#drip-nope' },
        { post_id: '', name: '#drip-2' },
      ]);

      assert.deepEqual([...map.entries()].sort(), [
        ['p1', 5],
        ['p2', 0],
      ]);
    });

    it('takes the largest of several drip tags and ignores other tags', function () {
      const map = buildDripDaysMap([
        { post_id: 'p1', name: '#lesson' },
        { post_id: 'p1', name: '#drip-3' },
        { post_id: 'p1', name: '#course-x' },
        { post_id: 'p1', name: '#drip-10' },
        { post_id: 'p1', name: '#drip-7' },
      ]);

      assert.deepEqual([...map.entries()], [['p1', 10]]);
    });

    it('has no entry for a post without a drip tag, and keeps a lone #drip-0 as zero', function () {
      const map = buildDripDaysMap([
        { post_id: 'p1', name: '#lesson' },
        { post_id: 'p1', name: 'drip-3' },
        { post_id: 'p2', name: '#drip-0' },
      ]);

      assert.equal(map.has('p1'), false);
      assert.equal(map.get('p2'), 0);
      assert.equal(buildDripDaysMap([]).size, 0);
    });
  });
});
