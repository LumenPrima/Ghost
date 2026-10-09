// fork(salvare): theme-helper API member context (theme contract §5, drip access starts).
import assert from 'node:assert/strict';
import sinon from 'sinon';
import logging from '@tryghost/logging';
import { apiMemberContext } from '../../../../core/frontend/utils/member-api-context';

const STARTS = {
  member: '2026-01-01T00:00:00.000Z',
  products: { 'product-1': '2026-02-01T10:00:00.000Z' },
};

function templateMember() {
  return {
    uuid: 'member-uuid',
    email: 'member@example.com',
    name: 'Jamie Larson',
    status: 'free',
    paid: false,
    subscriptions: [],
    tiers: [{ id: 'product-1', slug: 'anxiety', name: 'Anxiety' }],
  };
}

function sessionMember() {
  return {
    id: 'member-id',
    uuid: 'member-uuid',
    email: 'member@example.com',
    created_at: '2026-01-01T00:00:00.000Z',
    unsubscribe_url: 'https://example.com/unsubscribe/?uuid=member-uuid&key=secret',
    labels: [{ name: 'vip' }],
    products: [
      {
        id: 'product-1',
        slug: 'anxiety',
        name: 'Anxiety',
        expiry_at: null,
        monthly_price: 500,
      },
      { id: 'product-2', slug: 'breaking-free', name: 'Breaking Free', expiry_at: '2027-01-01' },
    ],
    productEvents: [],
    subscriptions: [],
  };
}

describe('fork(salvare): apiMemberContext', function () {
  afterEach(function () {
    sinon.restore();
  });

  it('returns null for a null or missing member', function () {
    const compute = sinon.stub().returns(STARTS);

    assert.equal(apiMemberContext(undefined, compute), null);
    assert.equal(apiMemberContext(null, compute), null);
    assert.equal(
      apiMemberContext({ member: null, root: { _locals: { member: sessionMember() } } }, compute),
      null,
    );
    sinon.assert.notCalled(compute);
  });

  it('returns the same @member object when there is no session member', function () {
    const compute = sinon.stub().returns(STARTS);
    const member = templateMember();

    assert.equal(apiMemberContext({ member }, compute), member);
    assert.equal(apiMemberContext({ member, root: {} }, compute), member);
    assert.equal(apiMemberContext({ member, root: { _locals: {} } }, compute), member);
    sinon.assert.notCalled(compute);
  });

  it('returns the same @member object when the session member is someone else', function () {
    const compute = sinon.stub().returns(STARTS);
    const member = templateMember();
    const session = { ...sessionMember(), uuid: 'other-uuid' };

    assert.equal(
      apiMemberContext({ member, root: { _locals: { member: session } } }, compute),
      member,
    );
    sinon.assert.notCalled(compute);
  });

  it('does not match on a missing uuid', function () {
    const compute = sinon.stub().returns(STARTS);
    const member = { ...templateMember(), uuid: undefined };
    const session = { ...sessionMember(), uuid: undefined };

    assert.equal(
      apiMemberContext({ member, root: { _locals: { member: session } } }, compute),
      member,
    );
  });

  it('adds only tier ids and slugs, and the access starts, for the matching session member', function () {
    const compute = sinon.stub().returns(STARTS);
    const member = templateMember();
    const session = sessionMember();

    const result = apiMemberContext({ member, root: { _locals: { member: session } } }, compute);

    assert.notEqual(result, member);
    assert.deepEqual(result, {
      ...templateMember(),
      products: [
        { id: 'product-1', slug: 'anxiety' },
        { id: 'product-2', slug: 'breaking-free' },
      ],
      access_starts: STARTS,
    });
    sinon.assert.calledOnceWithExactly(compute, session);

    // nothing private from the session member leaks into the API context
    assert.ok(result && !('unsubscribe_url' in result));
    assert.ok(result && !('labels' in result));
    assert.ok(result && !('id' in result));
  });

  it('does not mutate @member or the session member', function () {
    const member = templateMember();
    const session = sessionMember();

    apiMemberContext({ member, root: { _locals: { member: session } } }, () => STARTS);

    assert.deepEqual(member, templateMember());
    assert.deepEqual(session, sessionMember());
  });

  it('gives an empty products list when the session member holds no tiers', function () {
    const member = templateMember();
    const session = { ...sessionMember(), products: undefined };

    const result = apiMemberContext(
      { member, root: { _locals: { member: session } } },
      () => STARTS,
    );

    assert.deepEqual(result?.products, []);
  });

  it('omits access_starts when drip cannot compute them', function () {
    const member = templateMember();
    const session = sessionMember();

    const result = apiMemberContext({ member, root: { _locals: { member: session } } }, () => null);

    assert.ok(result && !('access_starts' in result));
    assert.equal(result?.products?.length, 2);
  });

  it('logs and omits access_starts when computing them throws (drip then fails closed)', function () {
    const errorStub = sinon.stub(logging, 'error');
    const member = templateMember();
    const session = sessionMember();
    const err = new Error('boom');

    const result = apiMemberContext({ member, root: { _locals: { member: session } } }, () => {
      throw err;
    });

    assert.ok(result && !('access_starts' in result));
    assert.equal(result?.products?.length, 2);
    sinon.assert.calledOnceWithExactly(errorStub, err);
  });

  it('uses services/drip computeAccessStarts by default', function () {
    const errorStub = sinon.stub(logging, 'error');
    const member = templateMember();
    // drip uses access starts already present on the member as is (Phase 3 amendment B1)
    const session = { ...sessionMember(), access_starts: STARTS };

    const result = apiMemberContext({ member, root: { _locals: { member: session } } });

    sinon.assert.notCalled(errorStub);
    assert.deepEqual(result?.access_starts, STARTS);
  });
});
