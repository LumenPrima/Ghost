const assert = require('node:assert/strict');
const errors = require('@tryghost/errors');
const logging = require('@tryghost/logging');
const sinon = require('sinon');

const CheckoutSessionEventService = require('../../../../../../../core/server/services/stripe/services/webhook/checkout-session-event-service');

describe('CheckoutSessionEventService', function () {
  let api,
    memberRepository,
    donationRepository,
    giftService,
    staffServiceEmails,
    sendSignupEmail,
    isPaidWelcomeEmailActive;

  beforeEach(function () {
    api = {
      getSubscription: sinon.stub(),
      getCustomer: sinon.stub(),
      getSetupIntent: sinon.stub(),
      attachPaymentMethodToCustomer: sinon.stub(),
      updateSubscriptionDefaultPaymentMethod: sinon.stub(),
    };

    memberRepository = {
      get: sinon.stub(),
      create: sinon.stub().resolves({
        id: 'created_member',
      }),
      update: sinon.stub(),
      linkSubscription: sinon.stub(),
      upsertCustomer: sinon.stub(),
      removeComplimentarySubscription: sinon.stub(),
    };

    donationRepository = {
      save: sinon.stub(),
    };

    giftService = {
      completePurchase: sinon.stub().resolves(true),
    };

    staffServiceEmails = {
      notifyDonationReceived: sinon.stub(),
    };

    sendSignupEmail = sinon.stub();
    isPaidWelcomeEmailActive = sinon.stub().resolves(false);
  });

  function createService(deps = {}) {
    return new CheckoutSessionEventService({
      api,
      memberRepository,
      donationRepository,
      giftService,
      staffServiceEmails,
      sendSignupEmail,
      isPaidWelcomeEmailActive,
      ...deps,
    });
  }

  describe('handleEvent', function () {
    it('should call handleSetupEvent if session mode is setup', async function () {
      const service = createService();
      const session = { mode: 'setup' };
      const handleSetupEventStub = sinon.stub(service, 'handleSetupEvent');

      await service.handleEvent(session);

      sinon.assert.calledWith(handleSetupEventStub, session);
    });

    it('should call handleSubscriptionEvent if session mode is subscription', async function () {
      const service = createService();
      const session = { mode: 'subscription' };
      const handleSubscriptionEventStub = sinon.stub(service, 'handleSubscriptionEvent');

      await service.handleEvent(session);

      sinon.assert.calledWith(handleSubscriptionEventStub, session);
    });

    it('should call handleDonationEvent if session mode is payment and session metadata ghost_donation is present', async function () {
      const service = createService();
      const session = { mode: 'payment', metadata: { ghost_donation: true } };
      const handleDonationEventStub = sinon.stub(service, 'handleDonationEvent');

      await service.handleEvent(session);

      sinon.assert.calledWith(handleDonationEventStub, session);
    });

    it('should call handleDonationEvent if session mode is payment and session metadata ghost_donation is string true', async function () {
      const service = createService();
      const session = { mode: 'payment', metadata: { ghost_donation: 'true' } };
      const handleDonationEventStub = sinon.stub(service, 'handleDonationEvent');

      await service.handleEvent(session);

      sinon.assert.calledWith(handleDonationEventStub, session);
    });

    it('should ignore false donation metadata flags', async function () {
      const service = createService();
      const session = { mode: 'payment', metadata: { ghost_donation: 'false' } };
      const handleDonationEventStub = sinon.stub(service, 'handleDonationEvent');

      await service.handleEvent(session);

      sinon.assert.notCalled(handleDonationEventStub);
    });

    it('should call handleGiftEvent if session mode is payment and session metadata ghost_gift is present', async function () {
      const service = createService();
      const session = { mode: 'payment', payment_status: 'paid', metadata: { ghost_gift: 'true' } };
      const handleGiftEventStub = sinon.stub(service, 'handleGiftEvent');

      await service.handleEvent(session);

      sinon.assert.calledWith(handleGiftEventStub, session);
    });

    it('waits for async payment success when a gift checkout is still unpaid', async function () {
      const service = createService();
      const session = {
        mode: 'payment',
        payment_status: 'unpaid',
        metadata: { ghost_gift: 'true' },
      };
      const handleGiftEventStub = sinon.stub(service, 'handleGiftEvent');

      await service.handleEvent(session);
      sinon.assert.notCalled(handleGiftEventStub);

      await service.handleEvent(
        { ...session, payment_status: 'paid' },
        'checkout.session.async_payment_succeeded',
      );
      sinon.assert.calledOnce(handleGiftEventStub);
    });

    it('ignores async payment success for a gift that Stripe still reports as unpaid', async function () {
      const service = createService();
      const session = {
        mode: 'payment',
        payment_status: 'unpaid',
        metadata: { ghost_gift: 'true' },
      };
      const handleGiftEventStub = sinon.stub(service, 'handleGiftEvent');

      await service.handleEvent(session, 'checkout.session.async_payment_succeeded');

      sinon.assert.notCalled(handleGiftEventStub);
    });

    it('ignores async payment success with conflicting donation and gift markers', async function () {
      const service = createService();
      const session = {
        mode: 'payment',
        payment_status: 'paid',
        metadata: { ghost_donation: 'true', ghost_gift: 'true' },
      };
      const handleDonationEventStub = sinon.stub(service, 'handleDonationEvent');
      const handleGiftEventStub = sinon.stub(service, 'handleGiftEvent');

      await service.handleEvent(session, 'checkout.session.async_payment_succeeded');

      sinon.assert.notCalled(handleDonationEventStub);
      sinon.assert.notCalled(handleGiftEventStub);
    });

    it('does not handle donations on async payment success', async function () {
      const service = createService();
      const session = {
        mode: 'payment',
        payment_status: 'paid',
        metadata: { ghost_donation: 'true' },
      };
      const handleDonationEventStub = sinon.stub(service, 'handleDonationEvent');

      await service.handleEvent(session, 'checkout.session.async_payment_succeeded');

      sinon.assert.notCalled(handleDonationEventStub);
    });

    it('ignores failed async gift payments', async function () {
      const service = createService();
      const handleGiftEventStub = sinon.stub(service, 'handleGiftEvent');

      await service.handleEvent(
        { mode: 'payment', metadata: { ghost_gift: 'true' } },
        'checkout.session.async_payment_failed',
      );

      sinon.assert.notCalled(handleGiftEventStub);
    });

    it('should ignore false gift metadata flags', async function () {
      const service = createService();
      const session = { mode: 'payment', metadata: { ghost_gift: 'false' } };
      const handleGiftEventStub = sinon.stub(service, 'handleGiftEvent');

      await service.handleEvent(session);

      sinon.assert.notCalled(handleGiftEventStub);
    });

    it('should ignore payment sessions with conflicting donation and gift markers', async function () {
      const service = createService();
      const session = { mode: 'payment', metadata: { ghost_donation: '', ghost_gift: 'true' } };
      const handleDonationEventStub = sinon.stub(service, 'handleDonationEvent');
      const handleGiftEventStub = sinon.stub(service, 'handleGiftEvent');

      await service.handleEvent(session);

      sinon.assert.notCalled(handleDonationEventStub);
      sinon.assert.notCalled(handleGiftEventStub);
    });

    it('should ignore payment sessions when both donation and gift markers are true', async function () {
      const service = createService();
      const session = { mode: 'payment', metadata: { ghost_donation: true, ghost_gift: 'true' } };
      const handleDonationEventStub = sinon.stub(service, 'handleDonationEvent');
      const handleGiftEventStub = sinon.stub(service, 'handleGiftEvent');

      await service.handleEvent(session);

      sinon.assert.notCalled(handleDonationEventStub);
      sinon.assert.notCalled(handleGiftEventStub);
    });

    it('should do nothing if session mode is unsupported', async function () {
      const service = createService();
      const session = { mode: 'unsupported_mode' };
      const handleSetupEventStub = sinon.stub(service, 'handleSetupEvent');
      const handleSubscriptionEventStub = sinon.stub(service, 'handleSubscriptionEvent');
      const handleDonationEventStub = sinon.stub(service, 'handleDonationEvent');
      const handleGiftEventStub = sinon.stub(service, 'handleGiftEvent');

      await service.handleEvent(session);

      sinon.assert.notCalled(handleSetupEventStub);
      sinon.assert.notCalled(handleSubscriptionEventStub);
      sinon.assert.notCalled(handleDonationEventStub);
      sinon.assert.notCalled(handleGiftEventStub);
    });
  });

  describe('handleDonationEvent', function () {
    it('can handle donation event', async function () {
      const service = createService();
      const session = {
        custom_fields: [{ key: 'donation_message', text: { value: 'Test donation message' } }],
        amount_total: 1000,
        currency: 'usd',
        customer: 'cust_123',
        customer_details: { name: 'Test Name', email: '' },
        metadata: {
          attribution_id: 'attr_123',
          attribution_url: 'https://example.com/blog/',
          attribution_type: 'referral',
          referrer_source: 'google',
          referrer_medium: 'cpc',
          referrer_url: 'https://referrer.com',
        },
      };

      memberRepository.get.resolves(null);

      await service.handleDonationEvent(session);

      sinon.assert.calledOnce(donationRepository.save);

      const savedDonationEvent = donationRepository.save.getCall(0).args[0];

      assert.equal(savedDonationEvent.amount, 1000);
      assert.equal(savedDonationEvent.currency, 'usd');
      assert.equal(savedDonationEvent.name, 'Test Name');
      assert.equal(savedDonationEvent.email, '');
      assert.equal(savedDonationEvent.donationMessage, 'Test donation message');
      assert.equal(savedDonationEvent.attributionId, 'attr_123');
      assert.equal(savedDonationEvent.attributionUrl, 'https://example.com/blog/');
      assert.equal(savedDonationEvent.attributionType, 'referral');
      assert.equal(savedDonationEvent.referrerSource, 'google');
      assert.equal(savedDonationEvent.referrerMedium, 'cpc');
      assert.equal(savedDonationEvent.referrerUrl, 'https://referrer.com');
    });

    it('donation message is null if its empty', async function () {
      const service = createService();
      const session = {
        custom_fields: [
          { key: 'donation_message', text: { value: '' } },
          { key: 'donation_message', text: { value: null } },
        ],
        amount_total: 1000,
        currency: 'usd',
        customer: 'cust_123',
        customer_details: { name: 'Test Name', email: '' },
        metadata: {
          attribution_id: 'attr_123',
          attribution_url: 'https://example.com/blog/',
          attribution_type: 'referral',
          referrer_source: 'google',
          referrer_medium: 'cpc',
          referrer_url: 'https://referrer.com',
        },
      };

      memberRepository.get.resolves(null);

      await service.handleDonationEvent(session);

      sinon.assert.calledOnce(donationRepository.save);

      const savedDonationEvent = donationRepository.save.getCall(0).args[0];
      assert.equal(savedDonationEvent.donationMessage, null);
    });

    it('can handle donation event with member', async function () {
      const service = createService();
      const session = {
        custom_fields: [{ key: 'donation_message', text: { value: 'Test donation message' } }],
        amount_total: 1000,
        currency: 'usd',
        customer: 'cust_123',
        customer_details: { name: 'Test Name', email: 'member@example.com' },
        metadata: {
          attribution_id: 'attr_123',
          attribution_url: 'https://example.com/blog/',
          attribution_type: 'referral',
          referrer_source: 'google',
          referrer_medium: 'cpc',
          referrer_url: 'https://referrer.com',
        },
      };

      const member = {
        get: sinon.stub(),
        id: 'member_123',
      };

      // Stub the `get` method on the member object
      member.get.withArgs('name').returns('Test Name');
      member.get.withArgs('email').returns('member@example.com');

      memberRepository.get.resolves(member);

      await service.handleDonationEvent(session);

      // expect(donationRepository.save.calledOnce).to.be.true;
      sinon.assert.calledOnce(donationRepository.save);

      const savedDonationEvent = donationRepository.save.getCall(0).args[0];

      assert.equal(savedDonationEvent.amount, 1000);
      assert.equal(savedDonationEvent.currency, 'usd');
      assert.equal(savedDonationEvent.name, 'Test Name');
      assert.equal(savedDonationEvent.email, 'member@example.com');
      assert.equal(savedDonationEvent.donationMessage, 'Test donation message');
      assert.equal(savedDonationEvent.attributionId, 'attr_123');
      assert.equal(savedDonationEvent.attributionUrl, 'https://example.com/blog/');
      assert.equal(savedDonationEvent.attributionType, 'referral');
      assert.equal(savedDonationEvent.referrerSource, 'google');
      assert.equal(savedDonationEvent.referrerMedium, 'cpc');
      assert.equal(savedDonationEvent.referrerUrl, 'https://referrer.com');
    });

    it('can handle donation event with empty customer email', async function () {
      const service = createService();
      const session = {
        custom_fields: [{ key: 'donation_message', text: { value: 'Test donation message' } }],
        amount_total: 1000,
        currency: 'usd',
        customer: 'cust_123',
        customer_details: { name: 'Test Name', email: '' },
        metadata: {
          attribution_id: 'attr_123',
          attribution_url: 'https://example.com/blog/',
          attribution_type: 'referral',
          referrer_source: 'google',
          referrer_medium: 'cpc',
          referrer_url: 'https://referrer.com',
        },
      };

      const member = {
        get: sinon.stub(),
        id: 'member_123',
      };

      member.get.withArgs('name').returns('Test Name');
      member.get.withArgs('email').returns('');

      memberRepository.get.resolves(member);

      await service.handleDonationEvent(session);

      sinon.assert.calledOnce(donationRepository.save);

      const savedDonationEvent = donationRepository.save.getCall(0).args[0];

      assert.equal(savedDonationEvent.amount, 1000);
    });
  });

  describe('handleSetupEvent', function () {
    it('fires getSetupIntent', async function () {
      const service = createService();
      const session = { setup_intent: 'si_123' };

      api.getSetupIntent.resolves({ metadata: { customer_id: 'cust_123' } });

      await service.handleSetupEvent(session);

      sinon.assert.calledWith(api.getSetupIntent, 'si_123');
    });

    it('fires getSetupIntent and memberRepository.get', async function () {
      const service = createService();
      const session = { setup_intent: 'si_123' };
      const setupIntent = { metadata: { customer_id: 'cust_123' } };

      api.getSetupIntent.resolves(setupIntent);

      await service.handleSetupEvent(session);

      sinon.assert.calledWith(api.getSetupIntent, 'si_123');
      sinon.assert.calledWith(memberRepository.get, { customer_id: 'cust_123' });
    });

    it('fires getSetupIntent, memberRepository.get and attachPaymentMethodToCustomer', async function () {
      const service = createService();
      const session = { setup_intent: 'si_123' };
      const setupIntent = { metadata: { customer_id: 'cust_123' }, payment_method: 'pm_123' };
      const member = { id: 'member_123', related: sinon.stub() };
      const fetchStub = sinon.stub();
      member.related.withArgs('stripeSubscriptions').returns({ fetch: fetchStub });
      const mockSubscriptions = [
        { get: sinon.stub().withArgs('status').returns('active') },
        { get: sinon.stub().withArgs('status').returns('trialing') },
        { get: sinon.stub().withArgs('status').returns('unpaid') },
      ];
      fetchStub.resolves({ models: mockSubscriptions });

      api.getSetupIntent.resolves(setupIntent);
      memberRepository.get.resolves(member);

      await service.handleSetupEvent(session);

      sinon.assert.calledWith(api.getSetupIntent, 'si_123');
      sinon.assert.calledWith(memberRepository.get, { customer_id: 'cust_123' });
      sinon.assert.called(api.attachPaymentMethodToCustomer);
    });

    it('if member is not found, it should return early', async function () {
      const service = createService();
      const session = { setup_intent: 'si_123' };
      const setupIntent = { metadata: { customer_id: 'cust_123' } };

      api.getSetupIntent.resolves(setupIntent);
      memberRepository.get.resolves(null);

      await service.handleSetupEvent(session);

      sinon.assert.calledWith(api.getSetupIntent, 'si_123');
      sinon.assert.calledWith(memberRepository.get, { customer_id: 'cust_123' });
      sinon.assert.notCalled(api.attachPaymentMethodToCustomer);
    });

    it('if setupIntent has subscription_id, it should update subscription default payment method', async function () {
      const service = createService();
      const session = { setup_intent: 'si_123' };
      const setupIntent = {
        metadata: { customer_id: 'cust_123', subscription_id: 'sub_123' },
        payment_method: 'pm_123',
      };
      const member = { id: 'member_123' };
      const updatedSubscription = { id: 'sub_123' };

      api.getSetupIntent.resolves(setupIntent);
      memberRepository.get.resolves(member);
      api.updateSubscriptionDefaultPaymentMethod.resolves(updatedSubscription);

      await service.handleSetupEvent(session);

      sinon.assert.calledWith(api.updateSubscriptionDefaultPaymentMethod, 'sub_123', 'pm_123');
      sinon.assert.calledWith(memberRepository.linkSubscription, {
        id: 'member_123',
        subscription: updatedSubscription,
      });
    });

    it('if linkSubscription fails with ER_DUP_ENTRY, it should throw ConflictError', async function () {
      const service = createService();
      const session = { setup_intent: 'si_123' };
      const setupIntent = {
        metadata: { customer_id: 'cust_123', subscription_id: 'sub_123' },
        payment_method: 'pm_123',
      };
      const member = { id: 'member_123' };
      const updatedSubscription = { id: 'sub_123' };

      api.getSetupIntent.resolves(setupIntent);
      memberRepository.get.resolves(member);
      api.updateSubscriptionDefaultPaymentMethod.resolves(updatedSubscription);
      memberRepository.linkSubscription.rejects({ code: 'ER_DUP_ENTRY' });

      try {
        await service.handleSetupEvent(session);
        assert.fail('Expected ConflictError');
      } catch (err) {
        assert.equal(err.name, 'ConflictError');
      }
    });

    it('if linkSubscription fails with SQLITE_CONSTRAINT, it should throw ConflictError', async function () {
      const service = createService();
      const session = { setup_intent: 'si_123' };
      const setupIntent = {
        metadata: { customer_id: 'cust_123', subscription_id: 'sub_123' },
        payment_method: 'pm_123',
      };
      const member = { id: 'member_123' };
      const updatedSubscription = { id: 'sub_123' };

      api.getSetupIntent.resolves(setupIntent);
      memberRepository.get.resolves(member);
      api.updateSubscriptionDefaultPaymentMethod.resolves(updatedSubscription);
      memberRepository.linkSubscription.rejects({ code: 'SQLITE_CONSTRAINT' });

      try {
        await service.handleSetupEvent(session);
        assert.fail('Expected ConflictError');
      } catch (err) {
        assert.equal(err.name, 'ConflictError');
      }
    });

    it('if linkSubscription fails with unexpected error, it should throw', async function () {
      const service = createService();
      const session = { setup_intent: 'si_123' };
      const setupIntent = {
        metadata: { customer_id: 'cust_123', subscription_id: 'sub_123' },
        payment_method: 'pm_123',
      };
      const member = { id: 'member_123' };
      const updatedSubscription = { id: 'sub_123' };

      api.getSetupIntent.resolves(setupIntent);
      memberRepository.get.resolves(member);
      api.updateSubscriptionDefaultPaymentMethod.resolves(updatedSubscription);
      memberRepository.linkSubscription.rejects(new Error('Unexpected error'));

      try {
        await service.handleSetupEvent(session);

        assert.fail('Expected error');
      } catch (err) {
        assert.equal(err.message, 'Unexpected error');
      }
    });

    it('updateSubscriptionDefaultPaymentMethod of all active subscriptions', async function () {
      const service = createService();
      const session = { setup_intent: 'si_123' };
      const setupIntent = { metadata: { customer_id: 'cust_123' }, payment_method: 'pm_123' };
      const member = { id: 'member_123', related: sinon.stub() };
      const fetchStub = sinon.stub();
      member.related.withArgs('stripeSubscriptions').returns({ fetch: fetchStub });
      const mockSubscriptions = [
        {
          get: sinon.stub().callsFake((key) => {
            if (key === 'status') {
              return 'active';
            }
            if (key === 'customer_id') {
              return 'cust_123';
            }
            if (key === 'subscription_id') {
              return 'sub_123';
            }
          }),
        },
        {
          get: sinon.stub().callsFake((key) => {
            if (key === 'status') {
              return 'trialing';
            }
            if (key === 'customer_id') {
              return 'cust_123';
            }
            if (key === 'subscription_id') {
              return 'sub_456';
            }
          }),
        },
        {
          get: sinon.stub().callsFake((key) => {
            if (key === 'status') {
              return 'canceled';
            }
            if (key === 'customer_id') {
              return 'cust_123';
            }
          }),
        },
      ];
      fetchStub.resolves({ models: mockSubscriptions });

      api.getSetupIntent.resolves(setupIntent);
      memberRepository.get.resolves(member);

      await service.handleSetupEvent(session);

      sinon.assert.calledTwice(api.updateSubscriptionDefaultPaymentMethod);
    });

    it('throws if updateSubscriptionDefaultPaymentMethod fires but cannot link subscription', async function () {
      const service = createService();
      const session = { setup_intent: 'si_123' };
      const setupIntent = { metadata: { customer_id: 'cust_123' }, payment_method: 'pm_123' };
      const member = { id: 'member_123', related: sinon.stub() };
      const fetchStub = sinon.stub();
      member.related.withArgs('stripeSubscriptions').returns({ fetch: fetchStub });
      const mockSubscriptions = [
        {
          get: sinon.stub().callsFake((key) => {
            if (key === 'status') {
              return 'active';
            }
            if (key === 'customer_id') {
              return 'cust_123';
            }
            if (key === 'subscription_id') {
              return 'sub_123';
            }
          }),
        },
      ];
      fetchStub.resolves({ models: mockSubscriptions });

      api.getSetupIntent.resolves(setupIntent);
      memberRepository.get.resolves(member);
      api.updateSubscriptionDefaultPaymentMethod.resolves({ id: 'sub_123' });
      memberRepository.linkSubscription.rejects(new Error('Unexpected error'));

      try {
        await service.handleSetupEvent(session);
        assert.fail('Expected error');
      } catch (err) {
        assert.equal(err.message, 'Unexpected error');
      }
    });

    it('throws is linkSubscription fauls with conflict error', async function () {
      const service = createService();
      const session = { setup_intent: 'si_123' };
      const setupIntent = {
        metadata: { customer_id: 'cust_123', subscription_id: 'sub_123' },
        payment_method: 'pm_123',
      };
      const member = { id: 'member_123' };
      const updatedSubscription = { id: 'sub_123' };

      api.getSetupIntent.resolves(setupIntent);
      memberRepository.get.resolves(member);
      api.updateSubscriptionDefaultPaymentMethod.resolves(updatedSubscription);
      memberRepository.linkSubscription.rejects({ code: 'ER_DUP_ENTRY' });

      try {
        await service.handleSetupEvent(session);
        assert.fail('Expected ConflictError');
      } catch (err) {
        assert(err instanceof errors.ConflictError);
        assert.equal(err.message, 'The server has encountered an conflict.');
      }
    });

    it('should throw ConflictError if linkSubscription fails with ER_DUP_ENTRY', async function () {
      const service = createService();
      const session = { setup_intent: 'si_123' };
      const setupIntent = {
        metadata: { customer_id: 'cust_123', subscription_id: 'sub_123' },
        payment_method: 'pm_123',
      };
      const member = { id: 'member_123' };
      const updatedSubscription = { id: 'sub_123' };

      api.getSetupIntent.resolves(setupIntent);
      memberRepository.get.resolves(member);
      api.updateSubscriptionDefaultPaymentMethod.resolves(updatedSubscription);
      memberRepository.linkSubscription.rejects({ code: 'ER_DUP_ENTRY' });

      try {
        await service.handleSetupEvent(session);
        assert.fail('Expected ConflictError');
      } catch (err) {
        assert(err instanceof errors.ConflictError);
      }
    });

    it('should throw ConflictError if linkSubscription fails with SQLITE_CONSTRAINT', async function () {
      const service = createService();
      const session = { setup_intent: 'si_123' };
      const setupIntent = {
        metadata: { customer_id: 'cust_123', subscription_id: 'sub_123' },
        payment_method: 'pm_123',
      };
      const member = { id: 'member_123' };
      const updatedSubscription = { id: 'sub_123' };

      api.getSetupIntent.resolves(setupIntent);
      memberRepository.get.resolves(member);
      api.updateSubscriptionDefaultPaymentMethod.resolves(updatedSubscription);
      memberRepository.linkSubscription.rejects({ code: 'SQLITE_CONSTRAINT' });

      try {
        await service.handleSetupEvent(session);
        assert.fail('Expected ConflictError');
      } catch (err) {
        assert(err instanceof errors.ConflictError);
      }
    });
  });

  describe('handleGiftEvent', function () {
    it('completes a pre-created gift using only its Stripe metadata identifier', async function () {
      const service = createService();
      await service.handleGiftEvent({
        id: 'cs_test_123',
        amount_total: 5500,
        currency: 'usd',
        customer: 'cust_123',
        payment_intent: 'pi_test_456',
        customer_details: { email: 'buyer@example.com' },
        metadata: { ghost_gift_id: 'gift_123' },
      });

      sinon.assert.calledOnceWithExactly(giftService.completePurchase, {
        giftId: 'gift_123',
        buyerEmail: 'buyer@example.com',
        stripeCustomerId: 'cust_123',
        stripeCheckoutSessionId: 'cs_test_123',
        stripePaymentIntentId: 'pi_test_456',
      });
    });

    it('defers missing buyer email recovery to the pre-created gift service', async function () {
      const service = createService();

      await service.handleGiftEvent({
        id: 'cs_test_123',
        amount_total: 5000,
        currency: 'usd',
        customer: 'cust_123',
        payment_intent: 'pi_test_456',
        metadata: { ghost_gift_id: 'gift_123' },
      });

      sinon.assert.notCalled(api.getCustomer);
      sinon.assert.calledOnceWithExactly(giftService.completePurchase, {
        giftId: 'gift_123',
        buyerEmail: null,
        stripeCustomerId: 'cust_123',
        stripeCheckoutSessionId: 'cs_test_123',
        stripePaymentIntentId: 'pi_test_456',
      });
    });

    it('recovers the buyer email from the Stripe Customer for a legacy gift', async function () {
      const service = createService();
      api.getCustomer.resolves({
        id: 'cust_123',
        email: 'recovered-buyer@example.com',
      });

      await service.handleGiftEvent({
        id: 'cs_test_123',
        amount_total: 5000,
        currency: 'usd',
        customer: 'cust_123',
        payment_intent: 'pi_test_456',
        metadata: {
          ghost_gift: 'true',
          gift_token: 'abc-123-token',
          tier_id: 'tier_456',
          cadence: 'year',
          duration: '1',
        },
      });

      sinon.assert.calledOnceWithExactly(api.getCustomer, 'cust_123');
      sinon.assert.calledOnceWithExactly(
        giftService.completePurchase,
        sinon.match({
          token: 'abc-123-token',
          buyerEmail: 'recovered-buyer@example.com',
          stripeCustomerId: 'cust_123',
        }),
      );
    });

    it('uses the buyer email from expanded Stripe Customer data', async function () {
      const service = createService();

      await service.handleGiftEvent({
        id: 'cs_test_123',
        amount_total: 5000,
        currency: 'usd',
        customer: { id: 'cust_123', email: 'expanded-buyer@example.com' },
        payment_intent: 'pi_test_456',
        metadata: { ghost_gift_id: 'gift_123' },
      });

      sinon.assert.notCalled(api.getCustomer);
      sinon.assert.calledOnceWithExactly(
        giftService.completePurchase,
        sinon.match({
          buyerEmail: 'expanded-buyer@example.com',
          stripeCustomerId: 'cust_123',
        }),
      );
    });

    it('calls giftService.completePurchase with session data', async function () {
      const service = createService();
      const session = {
        id: 'cs_test_123',
        mode: 'payment',
        amount_total: 5000,
        currency: 'usd',
        customer: 'cust_123',
        payment_intent: 'pi_test_456',
        customer_details: {
          email: 'buyer@example.com',
        },
        metadata: {
          ghost_gift: 'true',
          gift_token: 'abc-123-token',
          tier_id: 'tier_456',
          cadence: 'year',
          duration: '1',
        },
      };

      await service.handleGiftEvent(session);

      sinon.assert.calledOnce(giftService.completePurchase);

      const purchaseData = giftService.completePurchase.getCall(0).args[0];

      assert.equal(purchaseData.token, 'abc-123-token');
      assert.equal(purchaseData.buyerEmail, 'buyer@example.com');
      assert.equal(purchaseData.stripeCustomerId, 'cust_123');
      assert.equal(purchaseData.tierId, 'tier_456');
      assert.equal(purchaseData.cadence, 'year');
      assert.equal(purchaseData.duration, 1);
      assert.equal(purchaseData.currency, 'usd');
      assert.equal(purchaseData.amount, 5000);
      assert.equal(purchaseData.stripeCheckoutSessionId, 'cs_test_123');
      assert.equal(purchaseData.stripePaymentIntentId, 'pi_test_456');
    });

    it('passes null stripeCustomerId for unauthenticated purchasers', async function () {
      const service = createService();
      const session = {
        id: 'cs_test_123',
        mode: 'payment',
        amount_total: 3000,
        currency: 'gbp',
        customer: null,
        payment_intent: 'pi_test_789',
        customer_details: {
          email: 'guest@example.com',
        },
        metadata: {
          ghost_gift: 'true',
          gift_token: 'def-456-token',
          tier_id: 'tier_111',
          cadence: 'month',
          duration: '1',
        },
      };

      await service.handleGiftEvent(session);

      const purchaseData = giftService.completePurchase.getCall(0).args[0];

      assert.equal(purchaseData.stripeCustomerId, null);
    });

    it('normalizes expanded Stripe resources to IDs', async function () {
      const service = createService();
      const session = {
        id: 'cs_test_123',
        amount_total: 5000,
        currency: 'usd',
        customer: { id: 'cust_123' },
        payment_intent: { id: 'pi_test_456' },
        customer_details: { email: 'buyer@example.com' },
        metadata: {
          gift_token: 'abc-123-token',
          tier_id: 'tier_456',
          cadence: 'year',
          duration: '1',
        },
      };

      await service.handleGiftEvent(session);

      sinon.assert.calledOnceWithExactly(
        giftService.completePurchase,
        sinon.match({
          stripeCustomerId: 'cust_123',
          stripePaymentIntentId: 'pi_test_456',
        }),
      );
    });
  });

  describe('handleSubscriptionEvent', function () {
    let service;
    let session;
    let customer;
    let member;

    beforeEach(function () {
      service = createService();
      session = {
        customer: 'cust_123',
        metadata: {
          name: 'Metadata Name',
          newsletters: JSON.stringify([{ id: 1, name: 'Newsletter' }]),
          attribution_id: 'attr_123',
          attribution_url: 'https://example.com',
          attribution_type: 'referral',
          referrer_source: 'google',
          referrer_medium: 'cpc',
          referrer_url: 'https://referrer.com',
          offer: 'offer_123',
          checkoutType: 'new',
        },
      };

      customer = {
        email: 'customer@example.com',
        id: 'cust_123',
        subscriptions: {
          data: [
            {
              default_payment_method: {
                billing_details: { name: 'Customer Name' },
              },
            },
          ],
        },
      };

      member = {
        get: sinon.stub(),
        id: 'member_123',
      };
    });

    it('should get customer and member', async function () {
      api.getCustomer.resolves(customer);
      memberRepository.get.resolves(member);

      await service.handleSubscriptionEvent(session);

      sinon.assert.calledWith(api.getCustomer, 'cust_123', {
        expand: ['subscriptions.data.default_payment_method'],
      });
      sinon.assert.calledWith(memberRepository.get, { email: 'customer@example.com' });
    });

    it('should create new member if not found', async function () {
      api.getCustomer.resolves(customer);
      memberRepository.get.resolves(null);

      await service.handleSubscriptionEvent(session);

      sinon.assert.calledOnce(memberRepository.create);
      const memberData = memberRepository.create.getCall(0).args[0];

      assert.equal(memberData.email, 'customer@example.com');

      assert.equal(memberData.name, 'Metadata Name'); // falls back to metadata name if payerName doesn't exist
      assert.deepEqual(memberData.newsletters, [{ id: 1, name: 'Newsletter' }]);
      assert.deepEqual(memberData.attribution, {
        id: 'attr_123',
        url: 'https://example.com',
        type: 'referral',
        referrerSource: 'google',
        referrerMedium: 'cpc',
        referrerUrl: 'https://referrer.com',
      });
    });

    it('should create new member with payerName if it exists', async function () {
      api.getCustomer.resolves(customer);
      memberRepository.get.resolves(null);
      session.metadata.name = 'Session Name';

      await service.handleSubscriptionEvent(session);

      sinon.assert.calledOnce(memberRepository.create);
      const memberData = memberRepository.create.getCall(0).args[0];

      assert.equal(memberData.email, 'customer@example.com');

      assert.equal(memberData.name, 'Session Name');

      assert.deepEqual(memberData.newsletters, [{ id: 1, name: 'Newsletter' }]);
    });

    it('should create new member with newsletters if metadata newsletters is not valid JSON', async function () {
      api.getCustomer.resolves(customer);
      memberRepository.get.resolves(null);
      session.metadata.newsletters = 'invalid';

      await service.handleSubscriptionEvent(session);

      const memberData = memberRepository.create.getCall(0).args[0];
      assert.equal(memberData.email, 'customer@example.com');
      assert.equal(memberData.name, 'Metadata Name');
      assert.equal(memberData.newsletters, undefined);
    });

    it('should update member if found', async function () {
      api.getCustomer.resolves(customer);
      memberRepository.get.resolves(member);
      // change member name
      customer.subscriptions.data[0].default_payment_method.billing_details.name =
        'New Customer Name';
      await service.handleSubscriptionEvent(session);

      sinon.assert.calledOnce(memberRepository.update);
      const memberData = memberRepository.update.getCall(0).args[0];
      assert.equal(memberData.name, 'New Customer Name');
    });

    it('should update member with payerName if it exists', async function () {
      api.getCustomer.resolves(customer);
      memberRepository.get.resolves(member);
      session.metadata.name = 'Session Name';
      // change member name
      customer.subscriptions.data[0].default_payment_method.billing_details.name =
        'New Customer Name';
      await service.handleSubscriptionEvent(session);

      sinon.assert.calledOnce(memberRepository.update);
      const memberData = memberRepository.update.getCall(0).args[0];
      assert.equal(memberData.name, 'New Customer Name');
    });

    it('should update member with newsletters if metadata newsletters is not valid JSON', async function () {
      api.getCustomer.resolves(customer);
      memberRepository.get.resolves(member);
      session.metadata.newsletters = 'invalid';
      // change member name
      customer.subscriptions.data[0].default_payment_method.billing_details.name =
        'New Customer Name';
      await service.handleSubscriptionEvent(session);

      sinon.assert.calledOnce(memberRepository.update);
      const memberData = memberRepository.update.getCall(0).args[0];
      assert.equal(memberData.newsletters, undefined);
    });

    describe('signup email logic', function () {
      it('should send signup email for direct checkout flow even when welcome email is active', async function () {
        api.getCustomer.resolves(customer);
        memberRepository.get.resolves(null);
        session.metadata.ghostSignupContext = 'needs_magic_link_email';
        isPaidWelcomeEmailActive.resolves(true);

        await service.handleSubscriptionEvent(session);

        sinon.assert.calledOnce(sendSignupEmail);
        sinon.assert.calledWith(sendSignupEmail, 'customer@example.com');
        sinon.assert.notCalled(isPaidWelcomeEmailActive);
      });

      it('should send signup email when flow is has_precheckout_magic_link and welcome email is not active', async function () {
        api.getCustomer.resolves(customer);
        memberRepository.get.resolves(null);
        session.metadata.ghostSignupContext = 'has_precheckout_magic_link';
        isPaidWelcomeEmailActive.resolves(false);

        await service.handleSubscriptionEvent(session);

        sinon.assert.calledOnce(sendSignupEmail);
        sinon.assert.calledWith(sendSignupEmail, 'customer@example.com');
      });

      it('should NOT send signup email when flow is has_precheckout_magic_link and welcome email is active', async function () {
        api.getCustomer.resolves(customer);
        memberRepository.get.resolves(null);
        session.metadata.ghostSignupContext = 'has_precheckout_magic_link';
        isPaidWelcomeEmailActive.resolves(true);

        await service.handleSubscriptionEvent(session);

        sinon.assert.notCalled(sendSignupEmail);
      });

      it('should send signup email when flow is already_authenticated and welcome email is not active', async function () {
        api.getCustomer.resolves(customer);
        memberRepository.get.resolves(null);
        session.metadata.ghostSignupContext = 'already_authenticated';
        isPaidWelcomeEmailActive.resolves(false);

        await service.handleSubscriptionEvent(session);

        sinon.assert.calledOnce(sendSignupEmail);
        sinon.assert.calledWith(sendSignupEmail, 'customer@example.com');
      });

      it('should NOT send signup email when flow is already_authenticated and welcome email is active', async function () {
        api.getCustomer.resolves(customer);
        memberRepository.get.resolves(null);
        session.metadata.ghostSignupContext = 'already_authenticated';
        isPaidWelcomeEmailActive.resolves(true);

        await service.handleSubscriptionEvent(session);

        sinon.assert.notCalled(sendSignupEmail);
      });

      it('should send signup email when flow metadata is missing for backward compatibility', async function () {
        api.getCustomer.resolves(customer);
        memberRepository.get.resolves(null);
        delete session.metadata.ghostSignupContext;
        isPaidWelcomeEmailActive.resolves(true);

        await service.handleSubscriptionEvent(session);

        sinon.assert.calledOnce(sendSignupEmail);
        sinon.assert.calledWith(sendSignupEmail, 'customer@example.com');
        sinon.assert.notCalled(isPaidWelcomeEmailActive);
      });

      it('should NOT send signup email on upgrade regardless of flow or welcome email', async function () {
        api.getCustomer.resolves(customer);
        memberRepository.get.resolves(member);
        session.metadata.checkoutType = 'upgrade';
        session.metadata.ghostSignupContext = 'has_precheckout_magic_link';
        isPaidWelcomeEmailActive.resolves(false);

        await service.handleSubscriptionEvent(session);

        sinon.assert.notCalled(sendSignupEmail);
      });
    });

    // A checkout session can be created for any email address without proof the buyer
    // owns it, so what gates the write is whether the target record predates the
    // checkout, and whether the session was started by a signed-in member.
    describe('collected fields writeback', function () {
      let labsService;
      let metafieldBindings;

      beforeEach(function () {
        labsService = { isSet: sinon.stub().returns(true) };
        metafieldBindings = { writeCollected: sinon.stub().resolves() };
        service = createService({ labsService, metafieldBindings });
        session.metadata.ghostTierId = 'tier_123';
        api.getCustomer.resolves(customer);
        sinon.stub(logging, 'warn');
        sinon.stub(logging, 'error');
      });

      afterEach(function () {
        sinon.restore();
      });

      it('writes onto the member this event created, even unverified', async function () {
        memberRepository.get.resolves(null);
        session.metadata.ghostSignupContext = 'needs_magic_link_email';

        await service.handleSubscriptionEvent(session);

        sinon.assert.calledOnce(metafieldBindings.writeCollected);
        sinon.assert.calledWith(
          metafieldBindings.writeCollected,
          'created_member',
          'tier_123',
          sinon.match.array,
        );
      });

      it('does not write onto a member that existed before an unverified checkout', async function () {
        memberRepository.get.resolves(member);
        session.metadata.ghostSignupContext = 'needs_magic_link_email';

        await service.handleSubscriptionEvent(session);

        sinon.assert.notCalled(metafieldBindings.writeCollected);
      });

      it('treats a session carrying no signup context as unverified', async function () {
        memberRepository.get.resolves(member);
        delete session.metadata.ghostSignupContext;

        await service.handleSubscriptionEvent(session);

        sinon.assert.notCalled(metafieldBindings.writeCollected);
      });

      it('writes onto an existing member when the checkout was started signed in', async function () {
        memberRepository.get.resolves(member);
        session.metadata.ghostSignupContext = 'already_authenticated';

        await service.handleSubscriptionEvent(session);

        sinon.assert.calledOnce(metafieldBindings.writeCollected);
        sinon.assert.calledWith(
          metafieldBindings.writeCollected,
          'member_123',
          'tier_123',
          sinon.match.array,
        );
      });

      it('does not write when the session names no tier', async function () {
        memberRepository.get.resolves(null);
        delete session.metadata.ghostTierId;

        await service.handleSubscriptionEvent(session);

        sinon.assert.notCalled(metafieldBindings.writeCollected);
      });

      it('does not fail the webhook when the write is rejected', async function () {
        memberRepository.get.resolves(null);
        metafieldBindings.writeCollected.rejects(new Error('storage broke'));

        await service.handleSubscriptionEvent(session);

        sinon.assert.calledOnce(metafieldBindings.writeCollected);
      });
    });
  });

  // fork(salvare): one-time tier purchases
  describe('purchase checkout sessions', function () {
    let purchaseService;
    let warnStub;
    let errorStub;

    beforeEach(function () {
      purchaseService = {
        fulfil: sinon.stub().resolves({ outcome: 'fulfilled' }),
        refund: sinon.stub().resolves(true),
      };
      api.getPaymentIntent = sinon.stub().resolves({
        id: 'pi_p1',
        charges: { data: [{ id: 'ch_p1', refunded: false }] },
      });
      warnStub = sinon.stub(logging, 'warn');
      errorStub = sinon.stub(logging, 'error');
    });

    afterEach(function () {
      sinon.restore();
    });

    function createPurchaseService(deps = {}) {
      return createService({ purchaseService, ...deps });
    }

    function purchaseSession(overrides = {}) {
      return {
        id: 'cs_p1',
        mode: 'payment',
        payment_status: 'paid',
        amount_total: 9900,
        currency: 'usd',
        customer: 'cus_p1',
        customer_details: { email: 'buyer@example.com', name: 'Buyer Name' },
        payment_intent: 'pi_p1',
        metadata: {
          ghost_purchase_tier_id: 'tier_course',
          attribution_id: 'post_1',
          attribution_url: '/course-landing/',
          attribution_type: 'post',
          referrer_source: 'newsletter',
          referrer_medium: 'email',
          referrer_url: 'https://example.com/newsletter/',
          utm_source: 'spring',
          utm_medium: 'email',
          utm_campaign: 'launch',
          utm_term: 'course',
          utm_content: 'cta',
        },
        ...overrides,
      };
    }

    it('fulfils a paid purchase session with the exact input shape', async function () {
      const service = createPurchaseService();

      await service.handleEvent(purchaseSession());

      // Once before fulfilment and once after commit.
      sinon.assert.calledTwice(api.getPaymentIntent);
      sinon.assert.alwaysCalledWithExactly(api.getPaymentIntent, 'pi_p1');
      sinon.assert.notCalled(purchaseService.refund);
      sinon.assert.calledOnce(purchaseService.fulfil);
      assert.deepEqual(purchaseService.fulfil.firstCall.firstArg, {
        stripeCheckoutSessionId: 'cs_p1',
        stripePaymentIntentId: 'pi_p1',
        stripeCustomerId: 'cus_p1',
        tierId: 'tier_course',
        memberUuid: null,
        email: 'buyer@example.com',
        name: 'Buyer Name',
        amount: 9900,
        currency: 'usd',
        alreadyRefunded: false,
        attribution: {
          id: 'post_1',
          url: '/course-landing/',
          type: 'post',
          referrerSource: 'newsletter',
          referrerMedium: 'email',
          referrerUrl: 'https://example.com/newsletter/',
          utmSource: 'spring',
          utmMedium: 'email',
          utmCampaign: 'launch',
          utmTerm: 'course',
          utmContent: 'cta',
        },
      });
      sinon.assert.notCalled(giftService.completePurchase);
      sinon.assert.notCalled(donationRepository.save);
    });

    it('passes the member uuid and nulls missing attribution', async function () {
      const service = createPurchaseService();

      await service.handleEvent(
        purchaseSession({
          metadata: {
            ghost_purchase_tier_id: 'tier_course',
            ghost_purchase_member_uuid: 'member-uuid-1',
          },
        }),
      );

      const input = purchaseService.fulfil.firstCall.firstArg;
      assert.equal(input.memberUuid, 'member-uuid-1');
      assert.deepEqual(input.attribution, {
        id: null,
        url: null,
        type: null,
        referrerSource: null,
        referrerMedium: null,
        referrerUrl: null,
        utmSource: null,
        utmMedium: null,
        utmCampaign: null,
        utmTerm: null,
        utmContent: null,
      });
    });

    it('normalises expanded customer and payment intent objects to ids', async function () {
      const service = createPurchaseService();

      await service.handleEvent(
        purchaseSession({
          customer: { id: 'cus_expanded', email: 'customer@example.com' },
          customer_details: null,
          payment_intent: { id: 'pi_expanded' },
        }),
      );

      sinon.assert.alwaysCalledWithExactly(api.getPaymentIntent, 'pi_expanded');
      const input = purchaseService.fulfil.firstCall.firstArg;
      assert.equal(input.stripeCustomerId, 'cus_expanded');
      assert.equal(input.stripePaymentIntentId, 'pi_expanded');
      assert.equal(input.email, 'customer@example.com');
      assert.equal(input.name, null);
    });

    it('recovers the buyer email from the Stripe Customer when the session has none', async function () {
      api.getCustomer.resolves({ id: 'cus_p1', email: 'customer@example.com' });
      const service = createPurchaseService();

      await service.handleEvent(purchaseSession({ customer_details: null }));

      sinon.assert.calledOnceWithExactly(api.getCustomer, 'cus_p1');
      assert.equal(purchaseService.fulfil.firstCall.firstArg.email, 'customer@example.com');
    });

    it('passes null ids when the session has no customer or payment intent', async function () {
      const service = createPurchaseService();

      await service.handleEvent(purchaseSession({ customer: null, payment_intent: null }));

      sinon.assert.notCalled(api.getPaymentIntent);
      const input = purchaseService.fulfil.firstCall.firstArg;
      assert.equal(input.stripeCustomerId, null);
      assert.equal(input.stripePaymentIntentId, null);
      assert.equal(input.alreadyRefunded, false);
    });

    it('marks the purchase as already refunded when a charge was refunded before fulfilment', async function () {
      api.getPaymentIntent.resolves({
        id: 'pi_p1',
        charges: {
          data: [
            { id: 'ch_failed', refunded: false },
            { id: 'ch_p1', refunded: true },
          ],
        },
      });
      const service = createPurchaseService();

      await service.handleEvent(purchaseSession());

      assert.equal(purchaseService.fulfil.firstCall.firstArg.alreadyRefunded, true);
    });

    it('does not treat a partially refunded charge as already refunded', async function () {
      api.getPaymentIntent.resolves({
        id: 'pi_p1',
        charges: { data: [{ id: 'ch_p1', refunded: false, amount_refunded: 100 }] },
      });
      const service = createPurchaseService();

      await service.handleEvent(purchaseSession());

      assert.equal(purchaseService.fulfil.firstCall.firstArg.alreadyRefunded, false);
    });

    it('treats a payment intent with an empty charges list as not refunded', async function () {
      api.getPaymentIntent.resolves({ id: 'pi_p1', charges: { data: [] } });
      const service = createPurchaseService();

      await service.handleEvent(purchaseSession());

      assert.equal(purchaseService.fulfil.firstCall.firstArg.alreadyRefunded, false);
    });

    it('fails without fulfilling when the payment intent has no charges list (newer Stripe API)', async function () {
      api.getPaymentIntent.resolves({ id: 'pi_p1', latest_charge: 'ch_p1' });
      const service = createPurchaseService();

      await assert.rejects(
        () => service.handleEvent(purchaseSession()),
        (err) => {
          assert.equal(err.errorType, 'InternalServerError');
          assert.match(err.message, /refund state unknown/);
          return true;
        },
      );
      sinon.assert.notCalled(purchaseService.fulfil);
    });

    it('reads an expanded latest_charge when the charges list is absent', async function () {
      api.getPaymentIntent.resolves({
        id: 'pi_p1',
        latest_charge: { id: 'ch_p1', refunded: true },
      });
      const service = createPurchaseService();
      purchaseService.fulfil.resolves({ outcome: 'refunded', purchaseId: 'purchase_1' });

      await service.handleEvent(purchaseSession());

      assert.equal(purchaseService.fulfil.firstCall.firstArg.alreadyRefunded, true);
    });

    it('revokes a purchase that was fully refunded while it was being fulfilled', async function () {
      api.getPaymentIntent
        .onFirstCall()
        .resolves({ id: 'pi_p1', charges: { data: [{ id: 'ch_p1', refunded: false }] } });
      api.getPaymentIntent
        .onSecondCall()
        .resolves({ id: 'pi_p1', charges: { data: [{ id: 'ch_p1', refunded: true }] } });
      const service = createPurchaseService();

      await service.handleEvent(purchaseSession());

      assert.equal(purchaseService.fulfil.firstCall.firstArg.alreadyRefunded, false);
      sinon.assert.calledOnceWithExactly(purchaseService.refund, {
        paymentIntentId: 'pi_p1',
        fullyRefunded: true,
      });
      sinon.assert.callOrder(purchaseService.fulfil, api.getPaymentIntent, purchaseService.refund);
      sinon.assert.calledWith(
        warnStub,
        sinon.match({ event: { name: 'purchase.refunded_during_fulfilment' } }),
      );
    });

    it('propagates a failed post-commit revoke so Stripe retries the session', async function () {
      api.getPaymentIntent
        .onSecondCall()
        .resolves({ id: 'pi_p1', charges: { data: [{ id: 'ch_p1', refunded: true }] } });
      purchaseService.refund.rejects(new Error('database unavailable'));
      const service = createPurchaseService();

      await assert.rejects(() => service.handleEvent(purchaseSession()), /database unavailable/);
    });

    for (const outcome of ['duplicate', 'refunded', 'ignored']) {
      it(`skips the post-commit re-check when fulfil returns ${outcome}`, async function () {
        purchaseService.fulfil.resolves({ outcome });
        const service = createPurchaseService();

        await service.handleEvent(purchaseSession());

        sinon.assert.calledOnce(api.getPaymentIntent);
        sinon.assert.notCalled(purchaseService.refund);
      });
    }

    it('throws without fulfilling when the payment intent cannot be fetched', async function () {
      api.getPaymentIntent.rejects(new Error('Stripe unavailable'));
      const service = createPurchaseService();

      await assert.rejects(() => service.handleEvent(purchaseSession()), /Stripe unavailable/);
      sinon.assert.notCalled(purchaseService.fulfil);
    });

    it('propagates fulfil errors so Stripe retries', async function () {
      purchaseService.fulfil.rejects(new Error('database unavailable'));
      const service = createPurchaseService();

      await assert.rejects(() => service.handleEvent(purchaseSession()), /database unavailable/);
    });

    it('does nothing for an unpaid purchase session', async function () {
      const service = createPurchaseService();

      await service.handleEvent(purchaseSession({ payment_status: 'unpaid' }));

      sinon.assert.notCalled(api.getPaymentIntent);
      sinon.assert.notCalled(purchaseService.fulfil);
    });

    it('fulfils on async payment success once Stripe reports the session as paid', async function () {
      const service = createPurchaseService();

      await service.handleEvent(purchaseSession({ payment_status: 'unpaid' }));
      sinon.assert.notCalled(purchaseService.fulfil);

      await service.handleEvent(purchaseSession(), 'checkout.session.async_payment_succeeded');
      sinon.assert.calledOnce(purchaseService.fulfil);
    });

    it('ignores async payment success while the session is still unpaid', async function () {
      const service = createPurchaseService();

      await service.handleEvent(
        purchaseSession({ payment_status: 'unpaid' }),
        'checkout.session.async_payment_succeeded',
      );

      sinon.assert.notCalled(purchaseService.fulfil);
    });

    it('ignores failed async purchase payments', async function () {
      const service = createPurchaseService();

      await service.handleEvent(
        purchaseSession({ payment_status: 'unpaid' }),
        'checkout.session.async_payment_failed',
      );

      sinon.assert.notCalled(purchaseService.fulfil);
    });

    it('ignores a purchase session that also carries a donation marker', async function () {
      const service = createPurchaseService();
      const handleDonationEventStub = sinon.stub(service, 'handleDonationEvent');
      const session = purchaseSession();
      session.metadata.ghost_donation = 'true';

      await service.handleEvent(session);

      sinon.assert.notCalled(purchaseService.fulfil);
      sinon.assert.notCalled(handleDonationEventStub);
      sinon.assert.calledWith(
        warnStub,
        'Ignoring checkout session with conflicting payment flow metadata',
      );
    });

    it('ignores a purchase session that also carries a gift marker', async function () {
      const service = createPurchaseService();
      const handleGiftEventStub = sinon.stub(service, 'handleGiftEvent');

      for (const giftMarker of [{ ghost_gift_id: 'gift_1' }, { ghost_gift: 'true' }]) {
        const session = purchaseSession();
        Object.assign(session.metadata, giftMarker);

        await service.handleEvent(session);
        await service.handleEvent(session, 'checkout.session.async_payment_succeeded');
      }

      sinon.assert.notCalled(purchaseService.fulfil);
      sinon.assert.notCalled(handleGiftEventStub);
      sinon.assert.callCount(warnStub, 4);
    });

    it('never fulfils a purchase marker on a non-payment session', async function () {
      const service = createPurchaseService();
      const handleSubscriptionEventStub = sinon.stub(service, 'handleSubscriptionEvent');
      const handleSetupEventStub = sinon.stub(service, 'handleSetupEvent');

      await service.handleEvent(purchaseSession({ mode: 'subscription' }));
      await service.handleEvent(purchaseSession({ mode: 'setup' }));
      await service.handleEvent(
        purchaseSession({ mode: 'subscription' }),
        'checkout.session.async_payment_succeeded',
      );

      sinon.assert.notCalled(purchaseService.fulfil);
      sinon.assert.notCalled(api.getPaymentIntent);
      sinon.assert.calledOnce(handleSubscriptionEventStub);
      sinon.assert.calledOnce(handleSetupEventStub);
      sinon.assert.calledWith(
        warnStub,
        'Ignoring purchase metadata on checkout session cs_p1 with mode subscription',
      );
    });

    it('keeps donation and gift routing unchanged when a purchase service is wired', async function () {
      const service = createPurchaseService();
      const handleDonationEventStub = sinon.stub(service, 'handleDonationEvent');
      const handleGiftEventStub = sinon.stub(service, 'handleGiftEvent');

      await service.handleEvent({ mode: 'payment', metadata: { ghost_donation: true } });
      await service.handleEvent({
        mode: 'payment',
        payment_status: 'paid',
        metadata: { ghost_gift_id: 'gift_1' },
      });

      sinon.assert.calledOnce(handleDonationEventStub);
      sinon.assert.calledOnce(handleGiftEventStub);
      sinon.assert.notCalled(purchaseService.fulfil);
    });

    it('logs and ignores a purchase session when the dependency is absent', async function () {
      const service = createService();

      await assert.doesNotReject(() => service.handleEvent(purchaseSession()));

      sinon.assert.calledOnce(errorStub);
      sinon.assert.notCalled(api.getPaymentIntent);
    });

    it('throws when the purchase service is wired but not initialised', async function () {
      const service = createService({
        get purchaseService() {
          return undefined;
        },
      });

      await assert.rejects(
        () => service.handleEvent(purchaseSession()),
        errors.InternalServerError,
      );
      sinon.assert.notCalled(api.getPaymentIntent);
    });
  });
});
