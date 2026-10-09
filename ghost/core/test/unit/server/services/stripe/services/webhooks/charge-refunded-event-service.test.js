const assert = require('node:assert/strict');
const errors = require('@tryghost/errors'); // fork(salvare)
const logging = require('@tryghost/logging'); // fork(salvare)
const sinon = require('sinon');

const ChargeRefundedEventService = require('../../../../../../../core/server/services/stripe/services/webhook/charge-refunded-event-service');

describe('ChargeRefundedEventService', function () {
  let giftService;

  beforeEach(function () {
    giftService = {
      handlePaymentRefund: sinon.stub(),
    };
  });

  afterEach(function () {
    sinon.restore();
  });

  it('calls giftService.handlePaymentRefund with the payment_intent from the charge', async function () {
    giftService.handlePaymentRefund.resolves(true);

    const service = new ChargeRefundedEventService({ giftService });
    await service.handleEvent({ payment_intent: 'pi_123', invoice: null });

    sinon.assert.calledOnce(giftService.handlePaymentRefund);
    sinon.assert.calledWith(giftService.handlePaymentRefund, { paymentIntentId: 'pi_123' });
  });

  it('does not throw when no gift matches the payment intent', async function () {
    giftService.handlePaymentRefund.resolves(false);

    const service = new ChargeRefundedEventService({ giftService });

    await assert.doesNotReject(() =>
      service.handleEvent({ payment_intent: 'pi_unknown', invoice: null }),
    );

    sinon.assert.calledOnce(giftService.handlePaymentRefund);
  });

  it('extracts id from an expanded payment_intent object', async function () {
    giftService.handlePaymentRefund.resolves(true);

    const service = new ChargeRefundedEventService({ giftService });
    await service.handleEvent({ payment_intent: { id: 'pi_expanded' }, invoice: null });

    sinon.assert.calledOnce(giftService.handlePaymentRefund);
    sinon.assert.calledWith(giftService.handlePaymentRefund, { paymentIntentId: 'pi_expanded' });
  });

  it('skips processing when the charge has no payment_intent', async function () {
    const service = new ChargeRefundedEventService({ giftService });

    await service.handleEvent({ payment_intent: null, invoice: null });

    sinon.assert.notCalled(giftService.handlePaymentRefund);
  });

  // fork(salvare): one-time tier purchases
  describe('purchase refunds', function () {
    let purchaseService;

    beforeEach(function () {
      giftService.handlePaymentRefund.resolves(false);
      purchaseService = {
        refund: sinon.stub().resolves(true),
      };
    });

    it('calls purchaseService.refund with fullyRefunded true for a full refund', async function () {
      const service = new ChargeRefundedEventService({ giftService, purchaseService });

      await service.handleEvent({ payment_intent: 'pi_p1', refunded: true, invoice: 'in_x' });

      sinon.assert.calledOnceWithExactly(purchaseService.refund, {
        paymentIntentId: 'pi_p1',
        fullyRefunded: true,
      });
    });

    it('calls purchaseService.refund with fullyRefunded false for a partial refund', async function () {
      const service = new ChargeRefundedEventService({ giftService, purchaseService });

      await service.handleEvent({ payment_intent: 'pi_p1', refunded: false });
      await service.handleEvent({ payment_intent: { id: 'pi_p2' } });

      sinon.assert.calledTwice(purchaseService.refund);
      sinon.assert.calledWithExactly(purchaseService.refund.firstCall, {
        paymentIntentId: 'pi_p1',
        fullyRefunded: false,
      });
      sinon.assert.calledWithExactly(purchaseService.refund.secondCall, {
        paymentIntentId: 'pi_p2',
        fullyRefunded: false,
      });
    });

    it('calls both the gift and the purchase handlers', async function () {
      const service = new ChargeRefundedEventService({ giftService, purchaseService });

      await service.handleEvent({ payment_intent: 'pi_p1', refunded: true });

      sinon.assert.calledOnceWithExactly(giftService.handlePaymentRefund, {
        paymentIntentId: 'pi_p1',
      });
      sinon.assert.calledOnce(purchaseService.refund);
      sinon.assert.callOrder(giftService.handlePaymentRefund, purchaseService.refund);
    });

    it('logs and resolves when no purchase matches the payment intent', async function () {
      const infoStub = sinon.stub(logging, 'info');
      purchaseService.refund.resolves(false);
      const service = new ChargeRefundedEventService({ giftService, purchaseService });

      await assert.doesNotReject(() =>
        service.handleEvent({ payment_intent: 'pi_unknown', refunded: true }),
      );

      sinon.assert.calledWith(
        infoStub,
        'charge.refunded: no purchase found for payment_intent pi_unknown, skipping',
      );
    });

    it('does not call purchaseService.refund when the charge has no payment_intent', async function () {
      const service = new ChargeRefundedEventService({ giftService, purchaseService });

      await service.handleEvent({ payment_intent: null, refunded: true });

      sinon.assert.notCalled(purchaseService.refund);
    });

    it('tolerates a missing purchaseService dependency', async function () {
      const service = new ChargeRefundedEventService({ giftService });

      await assert.doesNotReject(() =>
        service.handleEvent({ payment_intent: 'pi_p1', refunded: true }),
      );
    });

    it('throws when the purchaseService dependency is wired but not initialised', async function () {
      const service = new ChargeRefundedEventService({
        giftService,
        get purchaseService() {
          return undefined;
        },
      });

      await assert.rejects(
        () => service.handleEvent({ payment_intent: 'pi_p1', refunded: true }),
        errors.InternalServerError,
      );
    });

    it('propagates errors from purchaseService.refund so Stripe retries', async function () {
      purchaseService.refund.rejects(new Error('database unavailable'));
      const service = new ChargeRefundedEventService({ giftService, purchaseService });

      await assert.rejects(
        () => service.handleEvent({ payment_intent: 'pi_p1', refunded: true }),
        /database unavailable/,
      );
    });
  });
});
