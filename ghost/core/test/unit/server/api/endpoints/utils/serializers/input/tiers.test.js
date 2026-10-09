const assert = require('node:assert/strict');
const tiersSerializer = require('../../../../../../../../core/server/api/endpoints/utils/serializers/input/tiers');

// fork(salvare): one-time price
describe('Tiers input serializer', function () {
  for (const method of ['add', 'edit']) {
    describe(method, function () {
      it('maps one_time_price to oneTimePrice', function () {
        const frame = { data: { tiers: [{ name: 'Course', one_time_price: 9900 }] } };
        tiersSerializer[method]({}, frame);

        assert.deepEqual(frame.data, { name: 'Course', oneTimePrice: 9900 });
      });

      it('keeps an explicit null', function () {
        const frame = { data: { tiers: [{ name: 'Course', one_time_price: null }] } };
        tiersSerializer[method]({}, frame);

        assert.equal(Reflect.has(frame.data, 'oneTimePrice'), true);
        assert.equal(frame.data.oneTimePrice, null);
        assert.equal(Reflect.has(frame.data, 'one_time_price'), false);
      });

      it('leaves the key absent when it was not sent', function () {
        const frame = { data: { tiers: [{ name: 'Course', monthly_price: 500 }] } };
        tiersSerializer[method]({}, frame);

        assert.deepEqual(frame.data, { name: 'Course', monthlyPrice: 500 });
        assert.equal(Reflect.has(frame.data, 'oneTimePrice'), false);
      });

      it('maps one_time_price in the legacy products payload', function () {
        const frame = { data: { products: [{ name: 'Course', one_time_price: 9900 }] } };
        tiersSerializer[method]({}, frame);

        assert.deepEqual(frame.data, { name: 'Course', oneTimePrice: 9900 });
      });
    });
  }
});
