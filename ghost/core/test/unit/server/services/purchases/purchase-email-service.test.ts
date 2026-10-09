import assert from 'node:assert/strict';
import Handlebars from 'handlebars';
import sinon from 'sinon';
import {
  PurchaseEmailService,
  type AccessEmailData,
} from '../../../../../core/server/services/purchases/purchase-email-service';

describe('PurchaseEmailService', function () {
  let transactionalMailer: { send: sinon.SinonStub };
  let service: PurchaseEmailService;

  const accessUrl =
    'https://example.com/members/?token=abc&action=signin&r=https%3A%2F%2Fexample.com%2Fstart%2F';

  function emailData(overrides: Partial<AccessEmailData> = {}): AccessEmailData {
    return {
      toEmail: 'buyer@example.com',
      tierName: 'Breaking Free',
      isNewMember: false,
      accessUrl,
      amount: 9900,
      currency: 'usd',
      ...overrides,
    };
  }

  function sentMessage() {
    sinon.assert.calledOnce(transactionalMailer.send);
    return transactionalMailer.send.firstCall.args[0];
  }

  beforeEach(function () {
    transactionalMailer = { send: sinon.stub().resolves() };
    service = new PurchaseEmailService({
      transactionalMailer,
      settingsCache: {
        get: (key: string) =>
          (({ title: 'Salvare', accent_color: '#ff5500' }) as Record<string, string>)[key],
      },
      urlUtils: { getSiteUrl: () => 'https://example.com/' },
      getFromAddress: () => 'Salvare <noreply@example.com>',
      getReplyToAddress: () => 'support@example.com',
      blogIcon: { getIconUrl: () => 'https://example.com/icon.png' },
    });
  });

  afterEach(function () {
    sinon.restore();
  });

  it('sends the access email to the purchaser', async function () {
    await service.sendAccessEmail(emailData());

    const message = sentMessage();
    assert.equal(message.to, 'buyer@example.com');
    assert.equal(message.subject, 'You now have access to Breaking Free');
    assert.equal(message.from, 'Salvare <noreply@example.com>');
    assert.equal(message.replyTo, 'support@example.com');
    assert.equal(message.forceTextContent, true);
    assert.equal(message.disableTracking, true);
  });

  it('puts the access link in both the HTML and the text part', async function () {
    await service.sendAccessEmail(emailData());

    const message = sentMessage();
    assert.ok(message.html.includes(`href="${Handlebars.Utils.escapeExpression(accessUrl)}"`));
    assert.ok(message.text.includes(accessUrl));
    assert.ok(message.html.includes('$99.00'));
    assert.ok(message.text.includes('$99.00'));
    assert.ok(message.html.includes('#ff5500'));
    assert.ok(message.html.includes('https://example.com/icon.png'));
  });

  it('tells a new member that an account was created', async function () {
    await service.sendAccessEmail(emailData({ isNewMember: true }));

    const message = sentMessage();
    assert.ok(message.html.includes('created a Salvare account for'));
    assert.ok(message.text.includes("We've created a Salvare account for buyer@example.com."));
  });

  it('leaves the account sentence out for an existing member', async function () {
    await service.sendAccessEmail(emailData({ isNewMember: false }));

    const message = sentMessage();
    assert.equal(message.html.includes('account for'), false);
    assert.equal(message.text.includes('account for'), false);
  });

  it('escapes the tier name in the HTML', async function () {
    await service.sendAccessEmail(emailData({ tierName: '<script>x</script>' }));

    const message = sentMessage();
    assert.equal(message.html.includes('<script>x</script>'), false);
    assert.ok(message.html.includes('&lt;script&gt;'));
  });

  it('propagates a mail transport failure', async function () {
    transactionalMailer.send.rejects(new Error('mail down'));

    await assert.rejects(service.sendAccessEmail(emailData()), /mail down/);
  });
});
