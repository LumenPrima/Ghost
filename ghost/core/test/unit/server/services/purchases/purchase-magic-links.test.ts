import assert from 'node:assert/strict';
import sinon from 'sinon';
import { MembersApiMagicLinks } from '../../../../../core/server/services/purchases/purchase-magic-links';

describe('MembersApiMagicLinks', function () {
  let membersApi: { getMagicLink: sinon.SinonStub; sendEmailWithMagicLink: sinon.SinonStub };
  let magicLinks: MembersApiMagicLinks;

  beforeEach(function () {
    membersApi = {
      getMagicLink: sinon
        .stub()
        .callsFake(
          async (_email: string, type: string) =>
            `https://example.com/members/?token=tok&action=${type}`,
        ),
      sendEmailWithMagicLink: sinon.stub().resolves(),
    };
    magicLinks = new MembersApiMagicLinks({ getMembersApi: () => membersApi });
  });

  afterEach(function () {
    sinon.restore();
  });

  it('creates a signup link carrying the attribution and redirecting to the referrer', async function () {
    const attribution = { id: 'post_1', type: 'post', url: '/course-intro/' };

    const link = await magicLinks.getSignupLink(
      'new@example.com',
      attribution,
      'https://example.com/start/?stripe=purchase-success&purchase_tier=breaking-free',
    );

    sinon.assert.calledOnceWithExactly(membersApi.getMagicLink, 'new@example.com', 'signup', {
      attribution,
    });
    const url = new URL(link);
    assert.equal(url.searchParams.get('token'), 'tok');
    assert.equal(url.searchParams.get('action'), 'signup');
    assert.equal(
      url.searchParams.get('r'),
      'https://example.com/start/?stripe=purchase-success&purchase_tier=breaking-free',
    );
  });

  it('creates a signin link redirecting to the referrer', async function () {
    const link = await magicLinks.getSigninLink('member@example.com', 'https://example.com/start/');

    sinon.assert.calledOnceWithExactly(membersApi.getMagicLink, 'member@example.com', 'signin');
    const url = new URL(link);
    assert.equal(url.searchParams.get('action'), 'signin');
    assert.equal(url.searchParams.get('r'), 'https://example.com/start/');
  });

  it('sends a sign-in email', async function () {
    await magicLinks.sendSigninEmail('member@example.com');

    sinon.assert.calledOnceWithExactly(membersApi.sendEmailWithMagicLink, {
      email: 'member@example.com',
      requestedType: 'signin',
    });
  });
});
