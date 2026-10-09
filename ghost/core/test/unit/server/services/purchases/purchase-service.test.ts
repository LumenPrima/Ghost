import assert from 'node:assert/strict';
import errors from '@tryghost/errors';
import logging from '@tryghost/logging';
import sinon from 'sinon';
import type { Knex } from 'knex';
import {
  PurchaseService,
  type FulfilPurchaseInput,
  type PurchaseServiceDeps,
  type StartPurchaseCheckoutInput,
} from '../../../../../core/server/services/purchases/purchase-service';
import { DuplicatePurchaseError } from '../../../../../core/server/services/purchases/purchase-knex-repository';
import { TIER_ID, buildMember, buildPurchase, buildTier } from './utils';

const transacting = 'trx' as unknown as Knex.Transaction;
const SITE_URL = 'https://example.com/';

describe('PurchaseService', function () {
  let purchaseRepository: {
    getByCheckoutSessionId: sinon.SinonStub;
    getByPaymentIntentId: sinon.SinonStub;
    hasActivePurchase: sinon.SinonStub;
    create: sinon.SinonStub;
    markRefunded: sinon.SinonStub;
    transaction: sinon.SinonStub;
  };
  let checkoutAdapter: {
    getCustomerForMember: sinon.SinonStub;
    getOneTimePriceId: sinon.SinonStub;
    createSession: sinon.SinonStub;
  };
  let memberRepository: {
    get: sinon.SinonStub;
    create: sinon.SinonStub;
    upsertCustomer: sinon.SinonStub;
    grantPurchasedProduct: sinon.SinonStub;
    revokePurchasedProduct: sinon.SinonStub;
  };
  let tiersService: { api: { read: sinon.SinonStub; browse: sinon.SinonStub } };
  let magicLinks: {
    getSignupLink: sinon.SinonStub;
    getSigninLink: sinon.SinonStub;
    sendSigninEmail: sinon.SinonStub;
  };
  let purchaseEmailService: { sendAccessEmail: sinon.SinonStub };
  let staffServiceEmails: { notifyPurchaseReceived: sinon.SinonStub };
  let service: PurchaseService;
  // Set when the transaction callback has resolved: the stub's commit point.
  let committed: boolean;

  beforeEach(function () {
    committed = false;
    purchaseRepository = {
      getByCheckoutSessionId: sinon.stub().resolves(null),
      getByPaymentIntentId: sinon.stub().resolves(null),
      hasActivePurchase: sinon.stub().resolves(false),
      create: sinon.stub().callsFake(async () => buildPurchase({ id: 'purchase_new' })),
      markRefunded: sinon.stub().resolves(),
      transaction: sinon
        .stub()
        .callsFake(async (callback: (trx: Knex.Transaction) => Promise<unknown>) => {
          const result = await callback(transacting);
          committed = true;
          return result;
        }),
    };
    checkoutAdapter = {
      getCustomerForMember: sinon.stub().resolves({ id: 'cus_existing' }),
      getOneTimePriceId: sinon.stub().resolves('price_one_time'),
      createSession: sinon
        .stub()
        .resolves({ id: 'cs_new', url: 'https://checkout.stripe.com/c/cs_new' }),
    };
    memberRepository = {
      get: sinon.stub().resolves(null),
      create: sinon.stub(),
      upsertCustomer: sinon.stub().resolves(),
      grantPurchasedProduct: sinon.stub().resolves(),
      revokePurchasedProduct: sinon.stub().resolves(),
    };
    tiersService = {
      api: {
        read: sinon.stub().resolves(buildTier()),
        browse: sinon.stub().resolves({ data: [buildTier()] }),
      },
    };
    magicLinks = {
      getSignupLink: sinon
        .stub()
        .resolves('https://example.com/members/?token=signup&action=signup'),
      getSigninLink: sinon
        .stub()
        .resolves('https://example.com/members/?token=signin&action=signin'),
      sendSigninEmail: sinon.stub().resolves(),
    };
    purchaseEmailService = { sendAccessEmail: sinon.stub().resolves() };
    staffServiceEmails = { notifyPurchaseReceived: sinon.stub().resolves() };

    service = new PurchaseService({
      purchaseRepository,
      checkoutAdapter,
      memberRepository,
      tiersService,
      magicLinks,
      purchaseEmailService,
      staffServiceEmails,
      urlUtils: { getSiteUrl: () => SITE_URL },
    } as unknown as PurchaseServiceDeps);

    sinon.stub(logging, 'error');
    sinon.stub(logging, 'warn');
    sinon.stub(logging, 'info');
  });

  afterEach(function () {
    sinon.restore();
  });

  describe('startCheckout', function () {
    function checkoutInput(
      overrides: Partial<StartPurchaseCheckoutInput> = {},
    ): StartPurchaseCheckoutInput {
      return {
        tierId: TIER_ID,
        metadata: {
          attribution_id: 'post_1',
          attribution_type: 'post',
          attribution_url: '/course-intro/',
          referrer_source: 'newsletter',
          utm_campaign: 'launch',
        },
        buyer: { memberId: null, email: 'new@example.com', isAuthenticated: false },
        ...overrides,
      };
    }

    function sessionArgs() {
      sinon.assert.calledOnce(checkoutAdapter.createSession);
      return checkoutAdapter.createSession.firstCall.args[0];
    }

    it('rejects an empty tier id', async function () {
      await assert.rejects(
        service.startCheckout(checkoutInput({ tierId: '' })),
        errors.BadRequestError,
      );
      sinon.assert.notCalled(tiersService.api.read);
    });

    it('rejects a missing tier', async function () {
      tiersService.api.read.resolves(null);

      await assert.rejects(service.startCheckout(checkoutInput()), {
        name: 'BadRequestError',
        message: 'This tier does not exist.',
      });
    });

    it('rejects an invalid tier id that the tiers service cannot read', async function () {
      tiersService.api.read.rejects(new Error('Invalid ObjectId'));

      await assert.rejects(service.startCheckout(checkoutInput({ tierId: 'nope' })), {
        name: 'BadRequestError',
        message: 'This tier does not exist.',
      });
    });

    describe('tier lookup by slug (tierId wins)', function () {
      function slugInput(overrides: Partial<StartPurchaseCheckoutInput> = {}) {
        const input = checkoutInput({ tierSlug: 'breaking-free', ...overrides });
        if (!('tierId' in overrides)) {
          delete input.tierId;
        }
        return input;
      }

      it('resolves a slug-only request through the tiers browse filter', async function () {
        const result = await service.startCheckout(slugInput());

        sinon.assert.notCalled(tiersService.api.read);
        sinon.assert.calledOnceWithExactly(tiersService.api.browse, {
          filter: { slug: 'breaking-free' },
        });
        assert.equal(result.url, 'https://checkout.stripe.com/c/cs_new');
        assert.equal(sessionArgs().priceId, 'price_one_time');
        assert.equal(sessionArgs().metadata.ghost_purchase_tier_id, TIER_ID);
      });

      it('trims the slug before looking it up', async function () {
        await service.startCheckout(slugInput({ tierSlug: '  breaking-free ' }));

        sinon.assert.calledOnceWithExactly(tiersService.api.browse, {
          filter: { slug: 'breaking-free' },
        });
      });

      it('treats a null tierId as absent', async function () {
        await service.startCheckout(slugInput({ tierId: null }));

        sinon.assert.notCalled(tiersService.api.read);
        sinon.assert.calledOnce(tiersService.api.browse);
      });

      it('uses only the tierId when both are sent', async function () {
        await service.startCheckout(slugInput({ tierId: TIER_ID, tierSlug: 'other-course' }));

        sinon.assert.calledOnceWithExactly(tiersService.api.read, TIER_ID);
        sinon.assert.notCalled(tiersService.api.browse);
      });

      it('does not fall back to the slug when the tierId is unknown', async function () {
        tiersService.api.read.resolves(null);

        await assert.rejects(service.startCheckout(slugInput({ tierId: TIER_ID })), {
          name: 'BadRequestError',
          message: 'This tier does not exist.',
          context: `Tier with id "${TIER_ID}" not found`,
        });
        sinon.assert.notCalled(tiersService.api.browse);
      });

      it('does not fall back to the slug when the tierId is malformed', async function () {
        for (const tierId of ['', '   ']) {
          await assert.rejects(
            service.startCheckout(slugInput({ tierId })),
            errors.BadRequestError,
          );
        }
        sinon.assert.notCalled(tiersService.api.read);
        sinon.assert.notCalled(tiersService.api.browse);
      });

      it('ignores a malformed slug when a tierId is present', async function () {
        for (const tierSlug of ['', 'x'.repeat(300), 42 as unknown as string]) {
          await service.startCheckout(slugInput({ tierId: TIER_ID, tierSlug }));
        }

        sinon.assert.calledThrice(tiersService.api.read);
        sinon.assert.notCalled(tiersService.api.browse);
      });

      it('rejects a request with neither a tierId nor a tierSlug', async function () {
        for (const overrides of [{}, { tierId: null, tierSlug: null }, { tierSlug: '  ' }]) {
          const input = slugInput(overrides);
          if (!('tierSlug' in overrides)) {
            delete input.tierSlug;
          }

          await assert.rejects(service.startCheckout(input), errors.BadRequestError);
        }
        sinon.assert.notCalled(tiersService.api.read);
        sinon.assert.notCalled(tiersService.api.browse);
      });

      it('rejects a slug longer than a tier slug can be', async function () {
        await assert.rejects(
          service.startCheckout(slugInput({ tierSlug: 'x'.repeat(192) })),
          errors.BadRequestError,
        );
        sinon.assert.notCalled(tiersService.api.browse);
      });

      it('rejects an unknown slug as a missing tier', async function () {
        tiersService.api.browse.resolves({ data: [] });

        await assert.rejects(service.startCheckout(slugInput({ tierSlug: 'nope' })), {
          name: 'BadRequestError',
          message: 'This tier does not exist.',
          context: 'Tier with slug "nope" not found',
        });
        sinon.assert.notCalled(checkoutAdapter.createSession);
      });

      it('logs a browse failure and rejects it as a missing tier', async function () {
        tiersService.api.browse.rejects(new Error('boom'));

        await assert.rejects(service.startCheckout(slugInput()), {
          name: 'BadRequestError',
          message: 'This tier does not exist.',
        });
        sinon.assert.calledOnce(logging.error as sinon.SinonStub);
      });

      it('still applies the archived and one-time price checks to a slug lookup', async function () {
        tiersService.api.browse.resolves({ data: [buildTier({ status: 'archived' })] });
        await assert.rejects(service.startCheckout(slugInput()), errors.NoPermissionError);

        tiersService.api.browse.resolves({ data: [buildTier({ oneTimePrice: null })] });
        await assert.rejects(service.startCheckout(slugInput()), {
          name: 'BadRequestError',
          message: 'This tier is not available as a one-time purchase.',
          context: 'Tier with slug "breaking-free" has no one-time price',
        });
        sinon.assert.notCalled(checkoutAdapter.createSession);
      });
    });

    it('rejects an archived tier', async function () {
      tiersService.api.read.resolves(buildTier({ status: 'archived' }));

      await assert.rejects(service.startCheckout(checkoutInput()), errors.NoPermissionError);
    });

    it('rejects a free tier', async function () {
      tiersService.api.read.resolves(buildTier({ type: 'free', oneTimePrice: null }));

      await assert.rejects(service.startCheckout(checkoutInput()), errors.BadRequestError);
    });

    for (const oneTimePrice of [null, 0, -100, 99.5]) {
      it(`rejects a tier whose one-time price is ${oneTimePrice}`, async function () {
        tiersService.api.read.resolves(buildTier({ oneTimePrice }));

        await assert.rejects(service.startCheckout(checkoutInput()), errors.BadRequestError);
        sinon.assert.notCalled(checkoutAdapter.createSession);
      });
    }

    it('rejects a tier without a currency', async function () {
      tiersService.api.read.resolves(buildTier({ currency: null }));

      await assert.rejects(service.startCheckout(checkoutInput()), errors.BadRequestError);
    });

    it('rejects an invalid buyer email', async function () {
      await assert.rejects(
        service.startCheckout(
          checkoutInput({
            buyer: { memberId: null, email: 'not-an-email', isAuthenticated: false },
          }),
        ),
        errors.BadRequestError,
      );
    });

    it('charges the stored one-time price and ignores any client amount', async function () {
      const result = await service.startCheckout(
        checkoutInput({ metadata: { amount: '1', price: 'price_cheap' } }),
      );

      assert.deepEqual(result, { url: 'https://checkout.stripe.com/c/cs_new' });
      sinon.assert.calledOnceWithExactly(
        checkoutAdapter.getOneTimePriceId,
        sinon.match({ oneTimePrice: 9900 }),
      );
      const args = sessionArgs();
      assert.equal(args.priceId, 'price_one_time');
      assert.equal('amount' in args, false);
    });

    it('sets the tier marker and passes the attribution metadata', async function () {
      await service.startCheckout(checkoutInput());

      assert.deepEqual(sessionArgs().metadata, {
        attribution_id: 'post_1',
        attribution_type: 'post',
        attribution_url: '/course-intro/',
        referrer_source: 'newsletter',
        utm_campaign: 'launch',
        ghost_purchase_tier_id: TIER_ID,
      });
    });

    it('drops client-supplied purchase keys and non-string metadata values', async function () {
      await service.startCheckout(
        checkoutInput({
          metadata: {
            ghost_purchase_tier_id: 'other_tier',
            ghost_purchase_member_uuid: 'victim-uuid',
            ghost_purchase_anything: 'x',
            newsletters: [{ id: 'n1' }],
            name: 'Ann',
          },
        }),
      );

      assert.deepEqual(sessionArgs().metadata, {
        name: 'Ann',
        ghost_purchase_tier_id: TIER_ID,
      });
    });

    it('uses the authenticated member as Stripe customer and records their uuid', async function () {
      const member = buildMember({ uuid: 'auth-uuid' });
      memberRepository.get.withArgs({ id: 'member_1' }).resolves(member);

      await service.startCheckout(
        checkoutInput({
          buyer: { memberId: 'member_1', email: 'member@example.com', isAuthenticated: true },
        }),
      );

      sinon.assert.calledOnceWithExactly(checkoutAdapter.getCustomerForMember, member);
      const args = sessionArgs();
      assert.deepEqual(args.customer, { id: 'cus_existing' });
      assert.equal(args.customerEmail, null);
      assert.equal(args.metadata.ghost_purchase_member_uuid, 'auth-uuid');
      sinon.assert.notCalled(magicLinks.getSignupLink);
    });

    it('asks an existing but unauthenticated member to sign in instead of checking out', async function () {
      memberRepository.get.withArgs({ id: 'member_1' }).resolves(buildMember());

      await assert.rejects(
        service.startCheckout(
          checkoutInput({
            buyer: { memberId: 'member_1', email: 'member@example.com', isAuthenticated: false },
          }),
        ),
        { name: 'NoPermissionError', code: 'PURCHASE_SIGNIN_REQUIRED' },
      );

      sinon.assert.calledOnceWithExactly(magicLinks.sendSigninEmail, 'member@example.com');
      sinon.assert.notCalled(purchaseRepository.hasActivePurchase);
      sinon.assert.notCalled(magicLinks.getSignupLink);
      sinon.assert.notCalled(checkoutAdapter.createSession);
    });

    for (const rawEmail of [
      ' member@example.com',
      '\tmember@example.com',
      'member@example.com ',
      '\nmember@example.com',
    ]) {
      it(`never mints a signup link for an existing member's email padded as ${JSON.stringify(rawEmail)}`, async function () {
        // The router's raw-string lookup missed the member, so memberId is null.
        memberRepository.get.withArgs({ email: 'member@example.com' }).resolves(buildMember());

        await assert.rejects(
          service.startCheckout(
            checkoutInput({
              buyer: { memberId: null, email: rawEmail, isAuthenticated: false },
            }),
          ),
          { code: 'PURCHASE_SIGNIN_REQUIRED' },
        );

        sinon.assert.calledWith(memberRepository.get, { email: 'member@example.com' });
        sinon.assert.notCalled(magicLinks.getSignupLink);
        sinon.assert.notCalled(checkoutAdapter.createSession);
      });
    }

    it('gives the same answer to an unauthenticated owner, without revealing ownership', async function () {
      memberRepository.get.resolves(buildMember());
      purchaseRepository.hasActivePurchase.resolves(true);

      await assert.rejects(
        service.startCheckout(
          checkoutInput({
            buyer: { memberId: null, email: 'member@example.com', isAuthenticated: false },
          }),
        ),
        { code: 'PURCHASE_SIGNIN_REQUIRED' },
      );
    });

    it('rejects an authenticated buyer whose member cannot be found', async function () {
      await assert.rejects(
        service.startCheckout(
          checkoutInput({
            buyer: { memberId: null, email: 'victim@example.com', isAuthenticated: true },
          }),
        ),
        errors.UnauthorizedError,
      );
      sinon.assert.notCalled(magicLinks.getSignupLink);
      sinon.assert.notCalled(checkoutAdapter.createSession);
    });

    it('wraps the success URL in a signup magic link for a new email', async function () {
      await service.startCheckout(checkoutInput());

      sinon.assert.calledOnceWithExactly(
        magicLinks.getSignupLink,
        'new@example.com',
        { id: 'post_1', type: 'post', url: '/course-intro/' },
        'https://example.com/start/?stripe=purchase-success&purchase_tier=breaking-free',
      );
      const args = sessionArgs();
      assert.equal(args.successUrl, 'https://example.com/members/?token=signup&action=signup');
      assert.equal(args.customer, null);
      assert.equal(args.customerEmail, 'new@example.com');
    });

    it('defaults the success URL to the site URL when the tier has no welcome page', async function () {
      tiersService.api.read.resolves(buildTier({ welcomePageURL: null }));

      await service.startCheckout(
        checkoutInput({ buyer: { memberId: null, email: null, isAuthenticated: false } }),
      );

      const args = sessionArgs();
      assert.equal(
        args.successUrl,
        'https://example.com/?stripe=purchase-success&purchase_tier=breaking-free',
      );
      assert.equal(args.cancelUrl, SITE_URL);
      assert.equal(args.customerEmail, null);
      sinon.assert.notCalled(magicLinks.getSignupLink);
    });

    it('builds on the given success and cancel URLs', async function () {
      await service.startCheckout(
        checkoutInput({
          successUrl: 'https://example.com/course/?ref=buy',
          cancelUrl: 'https://example.com/course/',
          buyer: { memberId: null, email: null, isAuthenticated: false },
        }),
      );

      const args = sessionArgs();
      assert.equal(
        args.successUrl,
        'https://example.com/course/?ref=buy&stripe=purchase-success&purchase_tier=breaking-free',
      );
      assert.equal(args.cancelUrl, 'https://example.com/course/');
    });

    it('refuses an authenticated member who already owns the tier without emailing them', async function () {
      memberRepository.get.resolves(buildMember());
      purchaseRepository.hasActivePurchase.withArgs('member_1', TIER_ID).resolves(true);

      await assert.rejects(
        service.startCheckout(
          checkoutInput({
            buyer: { memberId: 'member_1', email: 'member@example.com', isAuthenticated: true },
          }),
        ),
        { name: 'NoPermissionError', code: 'PURCHASE_ALREADY_OWNED' },
      );
      sinon.assert.notCalled(magicLinks.sendSigninEmail);
      sinon.assert.notCalled(checkoutAdapter.createSession);
    });

    it('still sends the sign-in email when an unauthenticated owner retries and mail fails', async function () {
      memberRepository.get.resolves(buildMember());
      purchaseRepository.hasActivePurchase.resolves(true);
      magicLinks.sendSigninEmail.rejects(new Error('mail down'));

      await assert.rejects(
        service.startCheckout(
          checkoutInput({
            buyer: { memberId: 'member_1', email: 'member@example.com', isAuthenticated: false },
          }),
        ),
        { code: 'PURCHASE_SIGNIN_REQUIRED' },
      );
      sinon.assert.calledOnceWithExactly(magicLinks.sendSigninEmail, 'member@example.com');
    });

    it('propagates Stripe errors from price resolution', async function () {
      const stripeError = new Error('Stripe is down');
      checkoutAdapter.getOneTimePriceId.rejects(stripeError);

      await assert.rejects(service.startCheckout(checkoutInput()), stripeError);
      sinon.assert.notCalled(checkoutAdapter.createSession);
    });

    it('propagates Stripe errors from session creation', async function () {
      const stripeError = new Error('Stripe is down');
      checkoutAdapter.createSession.rejects(stripeError);

      await assert.rejects(service.startCheckout(checkoutInput()), stripeError);
    });
  });

  describe('fulfil', function () {
    const attribution = {
      id: 'post_1',
      url: '/course-intro/',
      type: 'post',
      referrerSource: 'newsletter',
      referrerMedium: 'email',
      referrerUrl: 'https://mail.example.com/',
      utmSource: 'mail',
      utmMedium: 'email',
      utmCampaign: 'launch',
      utmTerm: 'course',
      utmContent: 'button',
    };

    function fulfilInput(overrides: Partial<FulfilPurchaseInput> = {}): FulfilPurchaseInput {
      return {
        stripeCheckoutSessionId: 'cs_1',
        stripePaymentIntentId: 'pi_1',
        stripeCustomerId: 'cus_1',
        tierId: TIER_ID,
        memberUuid: null,
        email: 'buyer@example.com',
        name: 'Buyer Name',
        amount: 9900,
        currency: 'USD',
        attribution,
        ...overrides,
      };
    }

    it('rejects malformed input with a ValidationError', async function () {
      await assert.rejects(
        service.fulfil(fulfilInput({ stripeCheckoutSessionId: '' })),
        errors.ValidationError,
      );
      await assert.rejects(service.fulfil(fulfilInput({ amount: -1 })), errors.ValidationError);
    });

    it('is a no-op for a checkout session that is already recorded', async function () {
      purchaseRepository.getByCheckoutSessionId.withArgs('cs_1').resolves(buildPurchase());

      const result = await service.fulfil(fulfilInput());

      assert.deepEqual(result, { outcome: 'duplicate' });
      sinon.assert.notCalled(purchaseRepository.transaction);
      sinon.assert.notCalled(purchaseRepository.create);
      sinon.assert.notCalled(memberRepository.grantPurchasedProduct);
      sinon.assert.notCalled(purchaseEmailService.sendAccessEmail);
      sinon.assert.notCalled(staffServiceEmails.notifyPurchaseReceived);
    });

    it('ignores and logs a tier that does not exist', async function () {
      tiersService.api.read.resolves(null);

      const result = await service.fulfil(fulfilInput());

      assert.deepEqual(result, { outcome: 'ignored', reason: 'tier_not_found' });
      sinon.assert.calledOnce(logging.error as sinon.SinonStub);
      sinon.assert.notCalled(purchaseRepository.transaction);
    });

    it('ignores a malformed tier id without reading it', async function () {
      const result = await service.fulfil(fulfilInput({ tierId: 'not-an-object-id' }));

      assert.deepEqual(result, { outcome: 'ignored', reason: 'tier_not_found' });
      sinon.assert.notCalled(tiersService.api.read);
    });

    it('propagates a tier read error so Stripe retries', async function () {
      tiersService.api.read.rejects(new Error('db down'));

      await assert.rejects(service.fulfil(fulfilInput()), /db down/);
    });

    it('creates a new member as a free signup and links their Stripe customer', async function () {
      const member = buildMember({ id: 'member_new', email: 'buyer@example.com' });
      memberRepository.create.resolves(member);

      const result = await service.fulfil(fulfilInput());

      assert.deepEqual(result, {
        outcome: 'fulfilled',
        purchaseId: 'purchase_new',
        memberId: 'member_new',
        newMember: true,
      });
      sinon.assert.calledOnceWithExactly(
        memberRepository.get,
        { email: 'buyer@example.com' },
        { transacting },
      );
      sinon.assert.calledOnceWithExactly(
        memberRepository.create,
        { email: 'buyer@example.com', name: 'Buyer Name', attribution },
        { transacting },
      );
      assert.equal('stripeCustomer' in memberRepository.create.firstCall.args[0], false);
      sinon.assert.calledOnceWithExactly(
        memberRepository.upsertCustomer,
        {
          customer_id: 'cus_1',
          member_id: 'member_new',
          name: 'Buyer Name',
          email: 'buyer@example.com',
        },
        { transacting },
      );
    });

    it('looks the member up by uuid first and trusts it', async function () {
      const member = buildMember({ id: 'member_auth' });
      memberRepository.get.withArgs({ uuid: 'auth-uuid' }).resolves(member);

      const result = await service.fulfil(fulfilInput({ memberUuid: 'auth-uuid' }));

      assert.equal(result.outcome, 'fulfilled');
      sinon.assert.calledOnceWithExactly(
        memberRepository.get,
        { uuid: 'auth-uuid' },
        { transacting },
      );
      sinon.assert.notCalled(memberRepository.create);
      sinon.assert.calledOnceWithExactly(
        memberRepository.upsertCustomer,
        sinon.match({ customer_id: 'cus_1', member_id: 'member_auth' }),
        { transacting },
      );
    });

    it('falls back to the email, untrusted, when the uuid no longer exists', async function () {
      const member = buildMember({ id: 'member_by_email' });
      memberRepository.get.withArgs({ email: 'buyer@example.com' }).resolves(member);

      const result = await service.fulfil(fulfilInput({ memberUuid: 'deleted-uuid' }));

      assert.equal(result.outcome, 'fulfilled');
      sinon.assert.calledWith(memberRepository.get.firstCall, { uuid: 'deleted-uuid' });
      sinon.assert.calledWith(memberRepository.get.secondCall, { email: 'buyer@example.com' });
      sinon.assert.notCalled(memberRepository.upsertCustomer);
      sinon.assert.calledWith(
        memberRepository.grantPurchasedProduct,
        sinon.match({ memberId: 'member_by_email' }),
      );
    });

    it('grants to an existing member found by email without linking the guest customer', async function () {
      memberRepository.get.withArgs({ email: 'buyer@example.com' }).resolves(buildMember());

      const result = await service.fulfil(fulfilInput());

      assert.deepEqual(result, {
        outcome: 'fulfilled',
        purchaseId: 'purchase_new',
        memberId: 'member_1',
        newMember: false,
      });
      sinon.assert.notCalled(memberRepository.create);
      sinon.assert.notCalled(memberRepository.upsertCustomer);
    });

    it('does not link a customer when the session has none', async function () {
      memberRepository.create.resolves(buildMember({ id: 'member_new' }));

      await service.fulfil(fulfilInput({ stripeCustomerId: null }));

      sinon.assert.notCalled(memberRepository.upsertCustomer);
    });

    it('retries once when the email was registered concurrently', async function () {
      const member = buildMember({ id: 'member_raced' });
      memberRepository.get.onFirstCall().resolves(null);
      memberRepository.get.onSecondCall().resolves(member);
      memberRepository.create.rejects(
        Object.assign(new Error('Duplicate entry'), { code: 'ER_DUP_ENTRY' }),
      );

      const result = await service.fulfil(fulfilInput());

      assert.deepEqual(result, {
        outcome: 'fulfilled',
        purchaseId: 'purchase_new',
        memberId: 'member_raced',
        newMember: false,
      });
      sinon.assert.calledTwice(purchaseRepository.transaction);
      sinon.assert.calledOnce(memberRepository.create);
      sinon.assert.notCalled(memberRepository.upsertCustomer);
      sinon.assert.calledOnce(purchaseRepository.create);
    });

    it('gives up after one retry', async function () {
      const duplicate = Object.assign(new Error('UNIQUE constraint failed: members.email'), {
        code: 'SQLITE_CONSTRAINT',
      });
      memberRepository.create.rejects(duplicate);

      await assert.rejects(service.fulfil(fulfilInput()), { name: 'MemberCreationRaceError' });
      sinon.assert.calledTwice(purchaseRepository.transaction);
      sinon.assert.notCalled(purchaseEmailService.sendAccessEmail);
    });

    it('does not retry other member creation errors', async function () {
      memberRepository.create.rejects(new errors.ValidationError({ message: 'Invalid email' }));

      await assert.rejects(service.fulfil(fulfilInput()), errors.ValidationError);
      sinon.assert.calledOnce(purchaseRepository.transaction);
    });

    it('throws when there is neither a member uuid nor an email', async function () {
      await assert.rejects(
        service.fulfil(fulfilInput({ email: null, memberUuid: null })),
        errors.InternalServerError,
      );
      sinon.assert.notCalled(purchaseRepository.create);
    });

    it('records every payment and attribution field on the purchase row', async function () {
      memberRepository.create.resolves(buildMember({ id: 'member_new' }));

      await service.fulfil(fulfilInput());

      sinon.assert.calledOnceWithExactly(
        purchaseRepository.create,
        {
          memberId: 'member_new',
          productId: TIER_ID,
          stripeCheckoutSessionId: 'cs_1',
          stripePaymentIntentId: 'pi_1',
          stripeCustomerId: 'cus_1',
          amount: 9900,
          currency: 'usd',
          status: 'paid',
          expiresAt: null,
          attributionId: 'post_1',
          attributionType: 'post',
          attributionUrl: '/course-intro/',
          referrerSource: 'newsletter',
          referrerMedium: 'email',
          referrerUrl: 'https://mail.example.com/',
          utmSource: 'mail',
          utmMedium: 'email',
          utmCampaign: 'launch',
          utmTerm: 'course',
          utmContent: 'button',
        },
        { transacting },
      );
    });

    it('drops attribution values the columns cannot hold', async function () {
      memberRepository.create.resolves(buildMember({ id: 'member_new' }));

      await service.fulfil(
        fulfilInput({
          attribution: {
            ...attribution,
            id: 'x'.repeat(25),
            type: 'newsletter',
            utmSource: 's'.repeat(300),
          },
        }),
      );

      const row = purchaseRepository.create.firstCall.args[0];
      assert.equal(row.attributionId, null);
      assert.equal(row.attributionType, null);
      assert.equal(row.utmSource, 's'.repeat(191));
    });

    it('locks the member with the grant before writing anything that references it', async function () {
      const member = buildMember({ id: 'member_new' });
      memberRepository.create.resolves(member);

      await service.fulfil(fulfilInput());

      sinon.assert.calledOnceWithExactly(
        memberRepository.grantPurchasedProduct,
        { memberId: 'member_new', productId: TIER_ID, expiresAt: null },
        { transacting },
      );
      sinon.assert.callOrder(
        memberRepository.create,
        memberRepository.grantPurchasedProduct,
        memberRepository.upsertCustomer,
        purchaseRepository.create,
      );
    });

    it('maps a confirmed duplicate insert to duplicate without sending email', async function () {
      memberRepository.get.resolves(buildMember());
      purchaseRepository.create.rejects(new DuplicatePurchaseError());
      purchaseRepository.getByCheckoutSessionId.onSecondCall().resolves(buildPurchase());

      const result = await service.fulfil(fulfilInput());

      assert.deepEqual(result, { outcome: 'duplicate' });
      sinon.assert.notCalled(purchaseEmailService.sendAccessEmail);
      sinon.assert.notCalled(staffServiceEmails.notifyPurchaseReceived);
    });

    it('rethrows a duplicate insert when this session is not recorded', async function () {
      memberRepository.get.resolves(buildMember());
      const duplicate = new DuplicatePurchaseError();
      purchaseRepository.create.rejects(duplicate);

      await assert.rejects(service.fulfil(fulfilInput()), duplicate);
    });

    it('logs but still fulfils a purchase without a payment intent', async function () {
      memberRepository.get.resolves(buildMember());

      const result = await service.fulfil(fulfilInput({ stripePaymentIntentId: null }));

      assert.equal(result.outcome, 'fulfilled');
      sinon.assert.calledWith(
        logging.error as sinon.SinonStub,
        sinon.match({ event: { name: 'purchase.fulfil_payment_intent_missing' } }),
      );
      sinon.assert.calledWith(
        purchaseRepository.create,
        sinon.match({ stripePaymentIntentId: null }),
      );
    });

    it('records a second purchase of an owned tier and flags it to staff', async function () {
      memberRepository.get.resolves(buildMember());
      purchaseRepository.hasActivePurchase.withArgs('member_1', TIER_ID).resolves(true);
      staffServiceEmails.notifyPurchaseReceived.callsFake(async () => {
        assert.equal(committed, true, 'staff email sent before commit');
      });

      const result = await service.fulfil(fulfilInput());

      assert.equal(result.outcome, 'fulfilled');
      sinon.assert.calledOnce(purchaseRepository.create);
      sinon.assert.calledWith(purchaseRepository.hasActivePurchase, 'member_1', TIER_ID, {
        transacting,
      });
      sinon.assert.calledWith(
        logging.warn as sinon.SinonStub,
        sinon.match({ event: { name: 'purchase.possible_duplicate' } }),
      );
      sinon.assert.calledWith(
        staffServiceEmails.notifyPurchaseReceived,
        sinon.match({ possibleDuplicate: true }),
      );
    });

    it('sends the access email and the staff notification after commit', async function () {
      memberRepository.create.resolves(
        buildMember({ id: 'member_new', email: 'buyer@example.com', name: null }),
      );
      const emailedAfterCommit: boolean[] = [];
      purchaseEmailService.sendAccessEmail.callsFake(async () => {
        emailedAfterCommit.push(committed);
      });
      staffServiceEmails.notifyPurchaseReceived.callsFake(async () => {
        emailedAfterCommit.push(committed);
      });

      await service.fulfil(fulfilInput());

      // Both emails ran, and only once the transaction had committed.
      assert.deepEqual(emailedAfterCommit, [true, true]);

      sinon.assert.calledOnceWithExactly(
        magicLinks.getSigninLink,
        'buyer@example.com',
        'https://example.com/start/',
      );
      sinon.assert.calledOnceWithExactly(purchaseEmailService.sendAccessEmail, {
        toEmail: 'buyer@example.com',
        tierName: 'Breaking Free',
        isNewMember: true,
        accessUrl: 'https://example.com/members/?token=signin&action=signin',
        amount: 9900,
        currency: 'usd',
      });
      sinon.assert.calledOnceWithExactly(staffServiceEmails.notifyPurchaseReceived, {
        name: 'Buyer Name',
        email: 'buyer@example.com',
        memberId: 'member_new',
        amount: 9900,
        currency: 'usd',
        tierName: 'Breaking Free',
        possibleDuplicate: false,
      });
      sinon.assert.callOrder(purchaseRepository.create, purchaseEmailService.sendAccessEmail);
    });

    it('tells an existing member they are not new', async function () {
      memberRepository.get.resolves(buildMember());

      await service.fulfil(fulfilInput());

      sinon.assert.calledWith(
        purchaseEmailService.sendAccessEmail,
        sinon.match({ toEmail: 'member@example.com', isNewMember: false }),
      );
    });

    it('still resolves when the access email fails', async function () {
      memberRepository.get.resolves(buildMember());
      purchaseEmailService.sendAccessEmail.rejects(new Error('mail down'));

      const result = await service.fulfil(fulfilInput());

      assert.equal(result.outcome, 'fulfilled');
      sinon.assert.calledOnce(staffServiceEmails.notifyPurchaseReceived);
    });

    it('still resolves when the magic link cannot be created', async function () {
      memberRepository.get.resolves(buildMember());
      magicLinks.getSigninLink.rejects(new Error('token store down'));

      const result = await service.fulfil(fulfilInput());

      assert.equal(result.outcome, 'fulfilled');
      sinon.assert.notCalled(purchaseEmailService.sendAccessEmail);
      sinon.assert.calledOnce(staffServiceEmails.notifyPurchaseReceived);
    });

    it('still resolves when the staff notification fails', async function () {
      memberRepository.get.resolves(buildMember());
      staffServiceEmails.notifyPurchaseReceived.rejects(new Error('mail down'));

      const result = await service.fulfil(fulfilInput());

      assert.equal(result.outcome, 'fulfilled');
      sinon.assert.calledOnce(purchaseEmailService.sendAccessEmail);
    });

    describe('a payment refunded before fulfilment', function () {
      it('records the purchase as refunded and grants nothing', async function () {
        memberRepository.get.withArgs({ email: 'buyer@example.com' }).resolves(buildMember());

        const result = await service.fulfil(fulfilInput({ alreadyRefunded: true }));

        assert.deepEqual(result, { outcome: 'refunded', purchaseId: 'purchase_new' });
        sinon.assert.calledOnce(purchaseRepository.create);
        const row = purchaseRepository.create.firstCall.args[0];
        assert.equal(row.status, 'refunded');
        assert.ok(row.refundedAt instanceof Date);
        assert.equal(row.memberId, 'member_1');
        assert.equal(row.stripePaymentIntentId, 'pi_1');
        sinon.assert.notCalled(purchaseRepository.transaction);
        sinon.assert.notCalled(memberRepository.grantPurchasedProduct);
        sinon.assert.notCalled(memberRepository.create);
        sinon.assert.notCalled(memberRepository.upsertCustomer);
        sinon.assert.notCalled(purchaseEmailService.sendAccessEmail);
        sinon.assert.notCalled(staffServiceEmails.notifyPurchaseReceived);
        sinon.assert.calledWith(
          logging.warn as sinon.SinonStub,
          sinon.match({ event: { name: 'purchase.fulfil_already_refunded' } }),
        );
      });

      it('does not create a member for an unknown email', async function () {
        await service.fulfil(fulfilInput({ alreadyRefunded: true }));

        sinon.assert.notCalled(memberRepository.create);
        assert.equal(purchaseRepository.create.firstCall.args[0].memberId, null);
      });

      it('treats a confirmed duplicate of an already refunded row as duplicate', async function () {
        purchaseRepository.create.rejects(new DuplicatePurchaseError());
        purchaseRepository.getByCheckoutSessionId.onFirstCall().resolves(null);
        purchaseRepository.getByCheckoutSessionId.resolves(buildPurchase({ status: 'refunded' }));

        const result = await service.fulfil(fulfilInput({ alreadyRefunded: true }));

        assert.deepEqual(result, { outcome: 'duplicate' });
        sinon.assert.notCalled(purchaseRepository.markRefunded);
        sinon.assert.notCalled(memberRepository.revokePurchasedProduct);
      });

      it('revokes a paid row that a concurrent delivery committed first', async function () {
        const paid = buildPurchase({ id: 'purchase_paid', stripePaymentIntentId: 'pi_recorded' });
        purchaseRepository.create.rejects(new DuplicatePurchaseError());
        purchaseRepository.getByCheckoutSessionId.onFirstCall().resolves(null);
        purchaseRepository.getByCheckoutSessionId.resolves(paid);
        purchaseRepository.getByPaymentIntentId.withArgs('pi_recorded').resolves(paid);

        const result = await service.fulfil(fulfilInput({ alreadyRefunded: true }));

        assert.deepEqual(result, { outcome: 'duplicate' });
        sinon.assert.calledOnceWithMatch(purchaseRepository.markRefunded, 'purchase_paid');
        sinon.assert.calledOnceWithExactly(
          memberRepository.revokePurchasedProduct,
          { memberId: 'member_1', productId: TIER_ID },
          { transacting },
        );
      });
    });

    describe('a redelivered session that is already recorded', function () {
      it('revokes a paid row when the redelivery shows a full refund', async function () {
        const paid = buildPurchase({ id: 'purchase_paid', stripePaymentIntentId: 'pi_recorded' });
        purchaseRepository.getByCheckoutSessionId.withArgs('cs_1').resolves(paid);
        purchaseRepository.getByPaymentIntentId.withArgs('pi_recorded').resolves(paid);

        const result = await service.fulfil(
          fulfilInput({ stripePaymentIntentId: 'pi_input', alreadyRefunded: true }),
        );

        assert.deepEqual(result, { outcome: 'duplicate' });
        // The recorded payment intent is used, not the input's.
        sinon.assert.neverCalledWith(purchaseRepository.getByPaymentIntentId, 'pi_input');
        sinon.assert.calledOnceWithMatch(purchaseRepository.markRefunded, 'purchase_paid');
        sinon.assert.calledOnce(memberRepository.revokePurchasedProduct);
        sinon.assert.calledWith(
          logging.warn as sinon.SinonStub,
          sinon.match({ event: { name: 'purchase.duplicate_refund_reconciled' } }),
        );
      });

      it('does nothing more for a row that is already refunded', async function () {
        purchaseRepository.getByCheckoutSessionId
          .withArgs('cs_1')
          .resolves(buildPurchase({ status: 'refunded' }));

        const result = await service.fulfil(fulfilInput({ alreadyRefunded: true }));

        assert.deepEqual(result, { outcome: 'duplicate' });
        sinon.assert.notCalled(purchaseRepository.getByPaymentIntentId);
        sinon.assert.notCalled(purchaseRepository.markRefunded);
        sinon.assert.notCalled(memberRepository.revokePurchasedProduct);
      });

      it('leaves a paid row alone when the redelivery shows no refund', async function () {
        purchaseRepository.getByCheckoutSessionId.withArgs('cs_1').resolves(buildPurchase());

        const result = await service.fulfil(fulfilInput());

        assert.deepEqual(result, { outcome: 'duplicate' });
        sinon.assert.notCalled(purchaseRepository.markRefunded);
      });
    });
  });

  describe('refund', function () {
    it('returns false for a payment intent that is not a purchase', async function () {
      const result = await service.refund({ paymentIntentId: 'pi_unknown', fullyRefunded: true });

      assert.equal(result, false);
      sinon.assert.notCalled(purchaseRepository.transaction);
    });

    it('rejects malformed input', async function () {
      await assert.rejects(
        service.refund({ paymentIntentId: '', fullyRefunded: true }),
        errors.ValidationError,
      );
    });

    it('ignores a partial refund', async function () {
      purchaseRepository.getByPaymentIntentId.resolves(buildPurchase());

      const result = await service.refund({ paymentIntentId: 'pi_1', fullyRefunded: false });

      assert.equal(result, true);
      sinon.assert.notCalled(purchaseRepository.transaction);
      sinon.assert.notCalled(purchaseRepository.markRefunded);
      sinon.assert.notCalled(memberRepository.revokePurchasedProduct);
    });

    it('does nothing for a purchase that is already refunded', async function () {
      purchaseRepository.getByPaymentIntentId.resolves(buildPurchase({ status: 'refunded' }));

      const result = await service.refund({ paymentIntentId: 'pi_1', fullyRefunded: true });

      assert.equal(result, true);
      sinon.assert.notCalled(purchaseRepository.transaction);
      sinon.assert.notCalled(purchaseRepository.markRefunded);
    });

    it('marks a full refund and then revokes the tier in the same transaction', async function () {
      purchaseRepository.getByPaymentIntentId.resolves(buildPurchase());

      const result = await service.refund({ paymentIntentId: 'pi_1', fullyRefunded: true });

      assert.equal(result, true);
      sinon.assert.calledWith(purchaseRepository.getByPaymentIntentId.secondCall, 'pi_1', {
        transacting,
        forUpdate: true,
      });
      sinon.assert.calledOnceWithExactly(
        purchaseRepository.markRefunded,
        'purchase_1',
        sinon.match.date,
        { transacting },
      );
      sinon.assert.calledOnceWithExactly(
        memberRepository.revokePurchasedProduct,
        { memberId: 'member_1', productId: TIER_ID },
        { transacting },
      );
      sinon.assert.callOrder(
        purchaseRepository.markRefunded,
        memberRepository.revokePurchasedProduct,
      );
    });

    it('stops when the locked re-read finds it already refunded', async function () {
      purchaseRepository.getByPaymentIntentId.onFirstCall().resolves(buildPurchase());
      purchaseRepository.getByPaymentIntentId
        .onSecondCall()
        .resolves(buildPurchase({ status: 'refunded' }));

      const result = await service.refund({ paymentIntentId: 'pi_1', fullyRefunded: true });

      assert.equal(result, true);
      sinon.assert.notCalled(purchaseRepository.markRefunded);
      sinon.assert.notCalled(memberRepository.revokePurchasedProduct);
    });

    it('skips the revoke when the member was deleted', async function () {
      purchaseRepository.getByPaymentIntentId.resolves(buildPurchase({ memberId: null }));

      await service.refund({ paymentIntentId: 'pi_1', fullyRefunded: true });

      sinon.assert.calledOnce(purchaseRepository.markRefunded);
      sinon.assert.notCalled(memberRepository.revokePurchasedProduct);
    });
  });
});
