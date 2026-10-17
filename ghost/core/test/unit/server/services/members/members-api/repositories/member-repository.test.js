const assert = require('node:assert/strict');
const sinon = require('sinon');
const errors = require('@tryghost/errors');
const logging = require('@tryghost/logging');
const DomainEvents = require('@tryghost/domain-events');
const labs = require('../../../../../../../core/shared/labs');
const MemberRepository = require('../../../../../../../core/server/services/members/members-api/repositories/member-repository');
const {
  SubscriptionCreatedEvent,
  OfferRedemptionEvent,
} = require('../../../../../../../core/shared/events');

describe('MemberRepository', function () {
  let Automation;
  let Member;
  let MemberCancelEvent;
  let MemberEmailChangeEvent;
  let MemberNewsletter;
  let MemberPaidSubscriptionEvent;
  let MemberProductEvent;
  let MemberStatusEvent;
  let MemberSubscribeEvent;
  let mockOfferRedemption;
  let StripeCustomer;
  let StripeCustomerSubscription;
  let WelcomeEmailAutomationRun;
  let newslettersService;
  let offersAPI;
  let automationsApi;
  let productRepository;
  let stripeAPIService;
  let tokenService;
  let labsIsSet;

  /**
   * @param {Partial<Record<keyof ConstructorParameters<typeof MemberRepository>[0], any>>} overrides
   * @returns {MemberRepository}
   */
  const buildRepo = (overrides = {}) =>
    new MemberRepository({
      Automation,
      Member,
      MemberCancelEvent,
      MemberEmailChangeEvent,
      MemberNewsletter,
      MemberPaidSubscriptionEvent,
      MemberProductEvent,
      MemberStatusEvent,
      MemberSubscribeEventModel: MemberSubscribeEvent,
      OfferRedemption: mockOfferRedemption,
      StripeCustomer,
      StripeCustomerSubscription,
      WelcomeEmailAutomationRun,
      newslettersService,
      offersAPI,
      automationsApi,
      productRepository,
      stripeAPIService,
      tokenService,
      ...overrides,
    });

  beforeEach(function () {
    labsIsSet = sinon.stub(labs, 'isSet').returns(false);

    mockOfferRedemption = {
      add: sinon.stub().resolves(),
      findOne: sinon.stub().resolves(null),
    };

    Member = {
      transaction: sinon.stub().callsFake((callback) => {
        return callback({ executionPromise: Promise.resolve() });
      }),
      add: sinon.stub().resolves({
        id: 'member_id_123',
        get: sinon.stub().callsFake((key) => {
          const data = {
            email: 'test@example.com',
            name: 'Test Member',
            status: 'free',
            created_at: new Date(),
          };
          return data[key];
        }),
        related: sinon.stub().callsFake((relation) => {
          if (relation === 'products') {
            return { models: [] };
          }
          if (relation === 'newsletters') {
            return { models: [] };
          }
          return { models: [] };
        }),
        toJSON: sinon.stub().returns({
          id: 'member_id_123',
          email: 'test@example.com',
          name: 'Test Member',
          status: 'free',
        }),
      }),
    };

    MemberNewsletter = {
      bulkDestroy: sinon.stub().resolves(),
      getFilteredCollectionQuery: sinon.stub().resolves([]),
    };

    MemberCancelEvent = {
      add: sinon.stub().resolves(),
    };

    MemberEmailChangeEvent = {
      add: sinon.stub().resolves(),
    };

    MemberPaidSubscriptionEvent = {
      add: sinon.stub().resolves(),
      query: sinon.stub().returns({
        where: sinon.stub().returns({
          delete: sinon.stub().returns({
            transacting: sinon.stub().resolves(),
          }),
        }),
      }),
    };

    MemberProductEvent = {
      add: sinon.stub().resolves(),
    };

    WelcomeEmailAutomationRun = {
      add: sinon.stub().resolves(),
    };

    MemberStatusEvent = {
      add: sinon.stub().resolves(),
    };

    MemberSubscribeEvent = {
      add: sinon.stub().resolves(),
    };

    StripeCustomer = {
      add: sinon.stub().resolves(),
      findOne: sinon.stub().resolves(null),
      upsert: sinon.stub().resolves(),
    };

    StripeCustomerSubscription = {
      add: sinon.stub().resolves({
        get: sinon.stub().returns(),
      }),
      edit: sinon.stub().resolves({
        get: sinon.stub().returns(),
      }),
      findOne: sinon.stub().resolves(null),
      upsert: sinon.stub().resolves(),
    };

    newslettersService = {
      getDefaultNewsletters: sinon.stub().resolves([]),
      getAll: sinon.stub().resolves([]),
    };

    offersAPI = {
      ensureOfferForStripeCoupon: sinon.stub().resolves({
        id: 'offer_new',
      }),
    };

    automationsApi = {
      trigger: sinon.stub().resolves(),
    };

    productRepository = {
      get: sinon.stub().resolves({
        get: sinon.stub().returns(),
        toJSON: sinon.stub().returns({}),
      }),
      update: sinon.stub().resolves({}),
      getDefaultProduct: sinon.stub().resolves(null),
    };

    stripeAPIService = {
      configured: false,
    };

    tokenService = {
      decodeToken: sinon.stub().resolves({}),
    };

    Automation = {
      findOne: sinon.stub().resolves({
        id: 'automation_id_free',
        get: sinon.stub().callsFake((key) => {
          const data = { status: 'active' };
          return data[key];
        }),
        related: sinon.stub().callsFake((relation) => {
          assert.equal(relation, 'welcomeEmailAutomatedEmail');
          return {
            id: 'automated_email_id_free',
            get: sinon.stub().callsFake((key) => {
              const data = { lexical: '{"root":{}}' };
              return data[key];
            }),
          };
        }),
      }),
    };
  });

  afterEach(function () {
    sinon.restore();
    // MemberRepository's constructor subscribes to DomainEvents on every build.
    // These tests construct the repository many times over a shared static
    // EventEmitter, so clear listeners between tests to avoid a leak warning
    // and to stop this file's listeners leaking into other files (isolate:false).
    DomainEvents.ee.removeAllListeners();
  });

  describe('#isComplimentarySubscription', function () {
    it('Does not error when subscription.plan is null', function () {
      const repo = buildRepo();
      repo.isComplimentarySubscription({});
    });
  });

  describe('#resolveContextSource', function () {
    it('Maps context to source', function () {
      const repo = buildRepo();

      let source = repo._resolveContextSource({
        import: true,
      });
      assert.equal(source, 'import');

      source = repo._resolveContextSource({
        importer: true,
      });
      assert.equal(source, 'import');

      source = repo._resolveContextSource({
        user: true,
      });
      assert.equal(source, 'admin');

      source = repo._resolveContextSource({
        user: true,
        api_key: true,
      });
      assert.equal(source, 'api');

      source = repo._resolveContextSource({
        api_key: true,
      });
      assert.equal(source, 'api');

      source = repo._resolveContextSource({});
      assert.equal(source, 'member');

      source = repo._resolveContextSource({
        generic_context: true,
      });
      assert.equal(source, 'member');
    });
  });

  describe('setComplimentarySubscription', function () {
    beforeEach(function () {
      Member = {
        findOne: sinon.stub().resolves({
          id: 'member_id_123',
          related: () => {
            return {
              fetch: () => {
                return {
                  models: [],
                };
              },
            };
          },
        }),
      };
    });

    it('throws an error when there is no default product', async function () {
      const repo = buildRepo({
        Member,
        stripeAPIService: {
          configured: true,
        },
        productRepository,
        OfferRedemption: mockOfferRedemption,
      });

      try {
        await repo.setComplimentarySubscription(
          {
            id: 'member_id_123',
          },
          {
            transacting: true,
          },
        );

        assert.fail('setComplimentarySubscription should have thrown');
      } catch (err) {
        assert.equal(err.message, 'Could not find Product "default"');
      }
    });

    it('uses the right options for fetching default product', async function () {
      productRepository = {
        getDefaultProduct: sinon.stub().resolves({
          toJSON: () => {
            return null;
          },
        }),
      };

      const repo = buildRepo({
        Member,
        stripeAPIService: {
          configured: true,
        },
        productRepository,
        OfferRedemption: mockOfferRedemption,
      });

      try {
        await repo.setComplimentarySubscription(
          {
            id: 'member_id_123',
          },
          {
            transacting: true,
            withRelated: ['labels'],
          },
        );

        assert.fail('setComplimentarySubscription should have thrown');
      } catch (err) {
        sinon.assert.calledWith(productRepository.getDefaultProduct, {
          withRelated: ['stripePrices'],
          transacting: true,
        });
        assert.equal(err.message, 'Could not find Product "default"');
      }
    });

    it('ignores non-complimentary zero-value prices when creating a complimentary subscription', async function () {
      const member = {
        id: 'member_id_123',
        get: sinon.stub().withArgs('email').returns('member@example.com'),
        related: () => {
          return {
            fetch: sinon.stub().resolves({
              models: [],
            }),
          };
        },
      };
      Member.findOne.resolves(member);

      const activeSubscriptionPrice = {
        stripe_price_id: 'price_active_subscription',
        nickname: 'Active Subscription',
        currency: 'usd',
        amount: 0,
      };
      const complimentaryPrice = {
        stripe_price_id: 'price_complimentary',
        nickname: 'Complimentary',
        currency: 'usd',
        amount: 0,
      };

      productRepository = {
        getDefaultProduct: sinon.stub().resolves({
          toJSON: () => {
            return {
              id: 'product_id_123',
              name: 'Default tier',
              description: null,
              stripePrices: [activeSubscriptionPrice],
            };
          },
        }),
        update: sinon.stub().resolves({
          toJSON: () => {
            return {
              stripePrices: [activeSubscriptionPrice, complimentaryPrice],
            };
          },
        }),
      };

      stripeAPIService = {
        configured: true,
        createCustomer: sinon.stub().resolves({
          id: 'cus_123',
          email: 'member@example.com',
          name: null,
        }),
        createSubscription: sinon.stub().resolves({
          id: 'sub_123',
          customer: 'cus_123',
        }),
      };

      StripeCustomer = {
        upsert: sinon.stub().resolves(),
      };

      const repo = buildRepo({
        Member,
        productRepository,
        OfferRedemption: mockOfferRedemption,
      });
      sinon.stub(repo, 'linkSubscription').resolves();

      await repo.setComplimentarySubscription(
        {
          id: 'member_id_123',
        },
        {
          transacting: true,
        },
      );

      sinon.assert.calledOnce(productRepository.update);
      sinon.assert.calledWith(
        stripeAPIService.createSubscription,
        'cus_123',
        'price_complimentary',
      );
      sinon.assert.neverCalledWith(
        stripeAPIService.createSubscription,
        'cus_123',
        'price_active_subscription',
      );
    });
  });

  describe('newsletter subscriptions', function () {
    let existingNewsletters;

    beforeEach(async function () {
      existingNewsletters = [
        {
          id: 'newsletter_id_123',
          attributes: {
            status: 'active',
          },
          get: sinon.stub().withArgs('status').returns('active'),
        },
        {
          id: 'newsletter_id_1234_archive',
          attributes: {
            status: 'archived',
          },
          get: sinon.stub().withArgs('status').returns('archived'),
        },
      ];

      Member = {
        findOne: sinon.stub().resolves({
          get: sinon.stub().returns('member_id_123'),
          related: sinon.stub().withArgs('newsletters').returns({
            models: existingNewsletters,
          }),
          toJSON: sinon.stub().returns({}),
        }),
        edit: sinon.stub().resolves({
          attributes: {},
          _previousAttributes: {},
          // The real _Member.edit resolves a bookshelf model; linkSubscription
          // loads relations off it when a subscription cancel flag changes
          load: sinon.stub().resolvesThis(),
          related: sinon.stub().returns({ models: [] }),
        }),
      };

      stripeAPIService = {
        configured: false,
      };

      MemberSubscribeEvent = {
        add: sinon.stub().resolves(),
      };
    });

    it('Does not create false archived newsletter events', async function () {
      const repo = buildRepo({
        Member,
        MemberProductEvent,
        productRepository,
        stripeAPIService,
        MemberSubscribeEventModel: MemberSubscribeEvent,
        OfferRedemption: mockOfferRedemption,
      });

      await repo.update(
        {
          email: 'test@email.com',
          newsletters: [
            {
              id: 'newsletter_id_123',
            },
            {
              id: 'newsletter_id_456',
            },
            {
              id: 'newsletter_id_new',
            },
            {
              id: 'newsletter_id_1234_archive',
            },
          ],
        },
        {
          transacting: {
            executionPromise: Promise.resolve(),
          },
          context: {},
        },
      );

      sinon.assert.calledTwice(MemberSubscribeEvent.add);
    });
  });

  describe('linkSubscription', function () {
    let subscriptionData;
    let subscriptionCreatedNotifySpy;
    let offerRedemptionNotifySpy;

    afterEach(function () {
      sinon.restore();
    });

    beforeEach(async function () {
      sinon.stub(MemberRepository.prototype, '_updateCurrentSubscription').resolves();
      subscriptionCreatedNotifySpy = sinon.spy();
      offerRedemptionNotifySpy = sinon.spy();

      subscriptionData = {
        id: 'sub_123',
        customer: 'cus_123',
        status: 'active',
        items: {
          type: 'list',
          data: [
            {
              id: 'item_123',
              price: {
                id: 'price_123',
                product: 'product_123',
                active: true,
                nickname: 'Monthly',
                currency: 'usd',
                recurring: {
                  interval: 'month',
                },
                unit_amount: 500,
                type: 'recurring',
              },
            },
          ],
        },
        start_date: Date.now() / 1000,
        current_period_end: Date.now() / 1000 + 60 * 60 * 24 * 31,
        cancel_at_period_end: false,
      };

      Member = {
        findOne: sinon.stub().resolves({
          related: (relation) => {
            return {
              query: sinon.stub().returns({
                fetchOne: sinon.stub().resolves({}),
              }),
              toJSON: sinon.stub().returns(relation === 'products' ? [] : {}),
              fetch: sinon.stub().resolves({
                toJSON: sinon.stub().returns(relation === 'products' ? [] : {}),
                models: [],
              }),
            };
          },
          toJSON: sinon.stub().returns({}),
        }),
        edit: sinon.stub().resolves({
          attributes: {},
          _previousAttributes: {},
          // The real _Member.edit resolves a bookshelf model; linkSubscription
          // loads relations off it when a subscription cancel flag changes
          load: sinon.stub().resolvesThis(),
          related: sinon.stub().returns({ models: [] }),
        }),
      };
      MemberPaidSubscriptionEvent = {
        add: sinon.stub().resolves(),
      };
      StripeCustomerSubscription = {
        add: sinon.stub().resolves({
          get: sinon.stub().returns(),
        }),
        edit: sinon.stub().resolves({
          get: sinon.stub().returns(),
        }),
      };
      MemberProductEvent = {
        add: sinon.stub().resolves({}),
      };

      stripeAPIService = {
        configured: true,
        getSubscription: sinon.stub().resolves(subscriptionData),
        getCustomer: sinon.stub().resolves({
          id: 'cus_123',
          invoice_settings: {
            default_payment_method: null,
          },
          subscriptions: { data: [] },
        }),
      };

      productRepository = {
        get: sinon.stub().resolves({
          get: sinon.stub().returns(),
          toJSON: sinon.stub().returns({}),
        }),
        update: sinon.stub().resolves({}),
      };

      offersAPI = {
        ensureOfferForStripeCoupon: sinon.stub().resolves({
          id: 'offer_new',
        }),
      };
    });

    it('dispatches paid subscription event', async function () {
      const repo = buildRepo({
        stripeAPIService,
        StripeCustomerSubscription,
        MemberPaidSubscriptionEvent,
        MemberProductEvent,
        productRepository,
        Member,
        OfferRedemption: mockOfferRedemption,
      });

      sinon.stub(repo, 'getSubscriptionByStripeID').resolves(null);

      DomainEvents.subscribe(SubscriptionCreatedEvent, subscriptionCreatedNotifySpy);
      DomainEvents.subscribe(OfferRedemptionEvent, offerRedemptionNotifySpy);

      await repo.linkSubscription(
        {
          subscription: subscriptionData,
        },
        {
          transacting: {
            executionPromise: Promise.resolve(),
          },
          context: {},
        },
      );

      sinon.assert.calledOnce(subscriptionCreatedNotifySpy);
      sinon.assert.notCalled(offerRedemptionNotifySpy);
    });

    it('dispatches the offer redemption event for a new member starting a subscription', async function () {
      // When a new member starts a paid subscription, the subscription is created with the offer ID
      const repo = buildRepo({
        stripeAPIService,
        StripeCustomerSubscription,
        MemberPaidSubscriptionEvent,
        MemberProductEvent,
        productRepository,
        offersAPI,
        Member,
        OfferRedemption: mockOfferRedemption,
      });

      // No existing subscription
      sinon.stub(repo, 'getSubscriptionByStripeID').resolves(null);

      DomainEvents.subscribe(SubscriptionCreatedEvent, subscriptionCreatedNotifySpy);
      DomainEvents.subscribe(OfferRedemptionEvent, offerRedemptionNotifySpy);

      await repo.linkSubscription(
        {
          id: 'member_id_123',
          subscription: subscriptionData,
          offerId: 'offer_123',
        },
        {
          transacting: {
            executionPromise: Promise.resolve(),
          },
          context: {},
        },
      );

      sinon.assert.calledOnce(subscriptionCreatedNotifySpy);
      sinon.assert.calledWith(
        subscriptionCreatedNotifySpy,
        sinon.match((event) => {
          if (event.data.offerId === 'offer_123') {
            return true;
          }
          return false;
        }),
      );

      sinon.assert.called(offerRedemptionNotifySpy);
      sinon.assert.calledWith(
        offerRedemptionNotifySpy,
        sinon.match((event) => {
          if (event.data.offerId === 'offer_123') {
            return true;
          }
          return false;
        }),
      );
    });

    it('dispatches the offer redemption event for an existing member upgrading to a paid subscription', async function () {
      // When an existing free member upgrades to a paid subscription, the subscription is first created _without_ the offer id
      // Then it is updated with the offer id after the checkout.completed webhook is received
      const repo = buildRepo({
        stripeAPIService,
        StripeCustomerSubscription,
        MemberPaidSubscriptionEvent,
        MemberProductEvent,
        productRepository,
        Member,
        OfferRedemption: mockOfferRedemption,
      });

      sinon.stub(repo, 'getSubscriptionByStripeID').resolves({
        load: sinon.stub().resolvesThis(),
        get: sinon.stub().withArgs('offer_id').returns(null),
      });

      DomainEvents.subscribe(SubscriptionCreatedEvent, subscriptionCreatedNotifySpy);
      DomainEvents.subscribe(OfferRedemptionEvent, offerRedemptionNotifySpy);

      await repo.linkSubscription(
        {
          id: 'member_id_123',
          subscription: subscriptionData,
          offerId: 'offer_123',
        },
        {
          transacting: {
            executionPromise: Promise.resolve(),
          },
          context: {},
        },
      );

      sinon.assert.notCalled(subscriptionCreatedNotifySpy);

      sinon.assert.called(offerRedemptionNotifySpy);
      sinon.assert.calledWith(
        offerRedemptionNotifySpy,
        sinon.match((event) => {
          if (event.data.offerId === 'offer_123') {
            return true;
          }
          return false;
        }),
      );
    });

    it('creates an offer from a Stripe coupon', async function () {
      offersAPI = {
        ensureOfferForStripeCoupon: sinon.stub().resolves({ id: 'offer_new' }),
      };

      const productRepositoryWithTier = {
        get: sinon.stub().resolves({
          get: sinon.stub().callsFake((key) => {
            if (key === 'id') {
              return 'tier_1';
            }
            if (key === 'name') {
              return 'Tier One';
            }
            return null;
          }),
          toJSON: sinon.stub().returns({}),
        }),
        update: sinon.stub().resolves({}),
      };

      const stripeCoupon = {
        id: 'coupon_abc',
        percent_off: 20,
        duration: 'forever',
      };

      const repo = buildRepo({
        stripeAPIService: {
          ...stripeAPIService,
          getSubscription: sinon.stub().resolves({
            ...subscriptionData,
            discount: {
              coupon: stripeCoupon,
            },
          }),
        },
        StripeCustomerSubscription,
        MemberPaidSubscriptionEvent,
        MemberProductEvent,
        productRepository: productRepositoryWithTier,
        offersAPI,
        Member,
        OfferRedemption: mockOfferRedemption,
      });

      sinon.stub(repo, 'getSubscriptionByStripeID').resolves(null);

      const transacting = {
        executionPromise: Promise.resolve(),
      };

      await repo.linkSubscription(
        {
          id: 'member_id_123',
          subscription: { ...subscriptionData, discount: { coupon: { id: 'coupon_abc' } } },
        },
        {
          transacting,
          context: {},
        },
      );

      sinon.assert.calledOnce(offersAPI.ensureOfferForStripeCoupon);
      // Verify the coupon, cadence, tier, and options are passed correctly
      assert.deepEqual(offersAPI.ensureOfferForStripeCoupon.firstCall.args[0], stripeCoupon);
      assert.equal(offersAPI.ensureOfferForStripeCoupon.firstCall.args[1], 'month');
      assert.deepEqual(offersAPI.ensureOfferForStripeCoupon.firstCall.args[2], {
        id: 'tier_1',
        name: 'Tier One',
      });
      assert.equal(offersAPI.ensureOfferForStripeCoupon.firstCall.args[3].transacting, transacting);
      assert.equal(StripeCustomerSubscription.add.firstCall.args[0].offer_id, 'offer_new');
    });

    it('sets offer_id to null if Stripe coupon is known to be incompatible with Ghost offers', async function () {
      const invalidCouponError = new errors.ValidationError({
        message: 'Offer `duration` must be "once" or "forever" for the "yearly" cadence.',
        code: 'INVALID_YEARLY_DURATION',
      });

      offersAPI = {
        ensureOfferForStripeCoupon: sinon.stub().rejects(invalidCouponError),
      };

      const productRepositoryWithTier = {
        get: sinon.stub().resolves({
          get: sinon.stub().callsFake((key) => {
            if (key === 'id') {
              return 'tier_1';
            }
            if (key === 'name') {
              return 'Tier One';
            }
            return null;
          }),
          toJSON: sinon.stub().returns({}),
        }),
        update: sinon.stub().resolves({}),
      };

      const stripeCoupon = {
        id: 'coupon_invalid',
        percent_off: 20,
        duration: 'repeating',
        duration_in_months: 3,
      };

      const repo = buildRepo({
        stripeAPIService: {
          ...stripeAPIService,
          getSubscription: sinon.stub().resolves({
            ...subscriptionData,
            discount: {
              coupon: stripeCoupon,
            },
          }),
        },
        StripeCustomerSubscription,
        MemberPaidSubscriptionEvent,
        MemberProductEvent,
        productRepository: productRepositoryWithTier,
        offersAPI,
        Member,
        OfferRedemption: mockOfferRedemption,
      });

      sinon.stub(repo, 'getSubscriptionByStripeID').resolves(null);

      const transacting = {
        executionPromise: Promise.resolve(),
      };

      // Should not throw despite the offer validation failure
      await repo.linkSubscription(
        {
          id: 'member_id_123',
          subscription: { ...subscriptionData, discount: { coupon: { id: 'coupon_invalid' } } },
        },
        {
          transacting,
          context: {},
        },
      );

      // Verify ensureOfferForStripeCoupon was called
      sinon.assert.calledOnce(offersAPI.ensureOfferForStripeCoupon);

      // Verify subscription was still created, but without an offer_id
      sinon.assert.calledOnce(StripeCustomerSubscription.add);
      assert.equal(StripeCustomerSubscription.add.firstCall.args[0].offer_id, null);
    });

    it('throws other validation errors from ensureOfferForStripeCoupon', async function () {
      const otherValidationError = new errors.ValidationError({
        message: 'Some other validation error',
      });

      offersAPI = {
        ensureOfferForStripeCoupon: sinon.stub().rejects(otherValidationError),
      };

      const productRepositoryWithTier = {
        get: sinon.stub().resolves({
          get: sinon.stub().callsFake((key) => {
            if (key === 'id') {
              return 'tier_1';
            }
            if (key === 'name') {
              return 'Tier One';
            }
            return null;
          }),
          toJSON: sinon.stub().returns({}),
        }),
        update: sinon.stub().resolves({}),
      };

      const stripeCoupon = {
        id: 'coupon_abc',
        percent_off: 20,
        duration: 'forever',
      };

      const repo = buildRepo({
        stripeAPIService: {
          ...stripeAPIService,
          getSubscription: sinon.stub().resolves({
            ...subscriptionData,
            discount: {
              coupon: stripeCoupon,
            },
          }),
        },
        StripeCustomerSubscription,
        MemberPaidSubscriptionEvent,
        MemberProductEvent,
        productRepository: productRepositoryWithTier,
        offersAPI,
        Member,
        OfferRedemption: mockOfferRedemption,
      });

      sinon.stub(repo, 'getSubscriptionByStripeID').resolves(null);

      const transacting = {
        executionPromise: Promise.resolve(),
      };

      // Should throw because it's not the INVALID_YEARLY_DURATION error
      await assert.rejects(
        repo.linkSubscription(
          {
            id: 'member_id_123',
            subscription: { ...subscriptionData, discount: { coupon: { id: 'coupon_abc' } } },
          },
          {
            transacting,
            context: {},
          },
        ),
        (err) => {
          assert.equal(err.message, 'Some other validation error');
          return true;
        },
      );

      // Verify ensureOfferForStripeCoupon was called
      sinon.assert.calledOnce(offersAPI.ensureOfferForStripeCoupon);

      // Verify subscription was NOT created because the error was rethrown
      sinon.assert.notCalled(StripeCustomerSubscription.add);
    });

    it('persists discount_start and discount_end for a new subscription', async function () {
      const discountStart = 1768940436;
      const discountEnd = 1784578836;

      const subscriptionWithDiscount = {
        ...subscriptionData,
        discount: {
          id: 'di_1SrlPkB8iNXqDnZRX03bQHnQ',
          coupon: {
            id: 'H4H47PbG',
            percent_off: 20,
            duration: 'repeating',
            duration_in_months: 6,
          },
          start: discountStart,
          end: discountEnd,
        },
      };

      const repo = buildRepo({
        stripeAPIService: {
          ...stripeAPIService,
          getSubscription: sinon.stub().resolves(subscriptionWithDiscount),
        },
        StripeCustomerSubscription,
        MemberPaidSubscriptionEvent,
        MemberProductEvent,
        productRepository,
        offersAPI,
        Member,
        OfferRedemption: mockOfferRedemption,
      });

      // No existing subscription
      sinon.stub(repo, 'getSubscriptionByStripeID').resolves(null);

      await repo.linkSubscription(
        {
          subscription: subscriptionWithDiscount,
        },
        {
          transacting: {
            executionPromise: Promise.resolve(),
          },
          context: {},
        },
      );

      // Verify discount_start and discount_end are set correctly
      sinon.assert.calledOnce(StripeCustomerSubscription.add);
      const addedSubscriptionData = StripeCustomerSubscription.add.firstCall.args[0];

      assert.ok(addedSubscriptionData.discount_start instanceof Date);
      assert.ok(addedSubscriptionData.discount_end instanceof Date);
      assert.equal(addedSubscriptionData.discount_start.getTime(), discountStart * 1000);
      assert.equal(addedSubscriptionData.discount_end.getTime(), discountEnd * 1000);
    });

    it('persists discount_start and discount_end for an existing subscription', async function () {
      const discountStart = 1768940436;
      const discountEnd = 1784578836;

      const subscriptionWithDiscount = {
        ...subscriptionData,
        discount: {
          id: 'di_1SrlPkB8iNXqDnZRX03bQHnQ',
          coupon: {
            id: 'H4H47PbG',
            percent_off: 20,
            duration: 'repeating',
            duration_in_months: 6,
          },
          start: discountStart,
          end: discountEnd,
        },
      };

      const repo = buildRepo({
        stripeAPIService: {
          ...stripeAPIService,
          getSubscription: sinon.stub().resolves(subscriptionWithDiscount),
        },
        StripeCustomerSubscription,
        MemberPaidSubscriptionEvent,
        MemberProductEvent,
        productRepository,
        offersAPI,
        Member,
        OfferRedemption: mockOfferRedemption,
      });

      // Existing subscription
      sinon.stub(repo, 'getSubscriptionByStripeID').resolves({
        load: sinon.stub().resolvesThis(),
        get: sinon.stub().withArgs('offer_id').returns(null),
      });

      await repo.linkSubscription(
        {
          subscription: subscriptionWithDiscount,
        },
        {
          transacting: {
            executionPromise: Promise.resolve(),
          },
          context: {},
        },
      );

      // Verify edit was called (not add) since subscription exists
      sinon.assert.notCalled(StripeCustomerSubscription.add);
      sinon.assert.calledOnce(StripeCustomerSubscription.edit);

      const editedSubscriptionData = StripeCustomerSubscription.edit.firstCall.args[0];

      assert.ok(editedSubscriptionData.discount_start instanceof Date);
      assert.ok(editedSubscriptionData.discount_end instanceof Date);
      assert.equal(editedSubscriptionData.discount_start.getTime(), discountStart * 1000);
      assert.equal(editedSubscriptionData.discount_end.getTime(), discountEnd * 1000);
    });

    it('nullifies discount_start and discount_end when discount is removed from Stripe subscription', async function () {
      const repo = buildRepo({
        stripeAPIService,
        StripeCustomerSubscription,
        MemberPaidSubscriptionEvent,
        MemberProductEvent,
        productRepository,
        Member,
        OfferRedemption: mockOfferRedemption,
      });

      sinon.stub(repo, 'getSubscriptionByStripeID').resolves(null);

      const subscriptionWithNoDiscount = {
        ...subscriptionData,
        discount: null,
      };

      await repo.linkSubscription(
        {
          subscription: subscriptionWithNoDiscount,
        },
        {
          transacting: {
            executionPromise: Promise.resolve(),
          },
          context: {},
        },
      );

      sinon.assert.calledOnce(StripeCustomerSubscription.add);
      const addedSubscriptionData = StripeCustomerSubscription.add.firstCall.args[0];

      assert.equal(addedSubscriptionData.discount_start, null);
      assert.equal(addedSubscriptionData.discount_end, null);
    });

    it('falls back to customer default payment method when subscription has none', async function () {
      const repo = buildRepo({
        stripeAPIService: {
          ...stripeAPIService,
          getSubscription: sinon.stub().resolves({
            ...subscriptionData,
            default_payment_method: null,
          }),
          getCustomer: sinon.stub().resolves({
            id: 'cus_123',
            invoice_settings: {
              default_payment_method: 'pm_customer_default',
            },
            subscriptions: { data: [] },
          }),
          getCardPaymentMethod: sinon.stub().resolves({
            id: 'pm_customer_default',
            type: 'card',
            card: {
              last4: '8888',
            },
          }),
        },
        StripeCustomerSubscription,
        MemberPaidSubscriptionEvent,
        MemberProductEvent,
        productRepository,
        Member,
        OfferRedemption: mockOfferRedemption,
      });

      sinon.stub(repo, 'getSubscriptionByStripeID').resolves(null);

      await repo.linkSubscription(
        {
          subscription: subscriptionData,
        },
        {
          transacting: {
            executionPromise: Promise.resolve(),
          },
          context: {},
        },
      );

      sinon.assert.calledOnce(StripeCustomerSubscription.add);
      const addedData = StripeCustomerSubscription.add.firstCall.args[0];
      assert.equal(addedData.default_payment_card_last4, '8888');
    });

    it('sets card last4 to null when neither subscription nor customer has a default payment method', async function () {
      const repo = buildRepo({
        stripeAPIService: {
          ...stripeAPIService,
          getSubscription: sinon.stub().resolves({
            ...subscriptionData,
            default_payment_method: null,
          }),
          getCustomer: sinon.stub().resolves({
            id: 'cus_123',
            invoice_settings: {
              default_payment_method: null,
            },
            subscriptions: { data: [] },
          }),
        },
        StripeCustomerSubscription,
        MemberPaidSubscriptionEvent,
        MemberProductEvent,
        productRepository,
        Member,
        OfferRedemption: mockOfferRedemption,
      });

      sinon.stub(repo, 'getSubscriptionByStripeID').resolves(null);

      await repo.linkSubscription(
        {
          subscription: subscriptionData,
        },
        {
          transacting: {
            executionPromise: Promise.resolve(),
          },
          context: {},
        },
      );

      sinon.assert.calledOnce(StripeCustomerSubscription.add);
      const addedData = StripeCustomerSubscription.add.firstCall.args[0];
      assert.equal(addedData.default_payment_card_last4, null);
    });

    it('uses subscription default payment method when available', async function () {
      const repo = buildRepo({
        stripeAPIService: {
          ...stripeAPIService,
          getSubscription: sinon.stub().resolves({
            ...subscriptionData,
            default_payment_method: 'pm_sub_default',
          }),
          getCardPaymentMethod: sinon.stub().resolves({
            id: 'pm_sub_default',
            type: 'card',
            card: {
              last4: '4242',
            },
          }),
        },
        StripeCustomerSubscription,
        MemberPaidSubscriptionEvent,
        MemberProductEvent,
        productRepository,
        Member,
        OfferRedemption: mockOfferRedemption,
      });

      sinon.stub(repo, 'getSubscriptionByStripeID').resolves(null);

      await repo.linkSubscription(
        {
          subscription: subscriptionData,
        },
        {
          transacting: {
            executionPromise: Promise.resolve(),
          },
          context: {},
        },
      );

      sinon.assert.calledOnce(StripeCustomerSubscription.add);
      const addedData = StripeCustomerSubscription.add.firstCall.args[0];
      assert.equal(addedData.default_payment_card_last4, '4242');
    });

    it('handles expanded customer object on subscription when falling back', async function () {
      const repo = buildRepo({
        stripeAPIService: {
          ...stripeAPIService,
          getSubscription: sinon.stub().resolves({
            ...subscriptionData,
            customer: { id: 'cus_123', object: 'customer' },
            default_payment_method: null,
          }),
          getCustomer: sinon.stub().resolves({
            id: 'cus_123',
            invoice_settings: {
              default_payment_method: { id: 'pm_expanded', type: 'card', card: { last4: '1234' } },
            },
            subscriptions: { data: [] },
          }),
          getCardPaymentMethod: sinon.stub().resolves({
            id: 'pm_expanded',
            type: 'card',
            card: {
              last4: '1234',
            },
          }),
        },
        StripeCustomerSubscription,
        MemberPaidSubscriptionEvent,
        MemberProductEvent,
        productRepository,
        Member,
        OfferRedemption: mockOfferRedemption,
      });

      sinon.stub(repo, 'getSubscriptionByStripeID').resolves(null);

      await repo.linkSubscription(
        {
          subscription: { ...subscriptionData, customer: { id: 'cus_123', object: 'customer' } },
        },
        {
          transacting: {
            executionPromise: Promise.resolve(),
          },
          context: {},
        },
      );

      sinon.assert.calledOnce(StripeCustomerSubscription.add);
      const addedData = StripeCustomerSubscription.add.firstCall.args[0];
      assert.equal(addedData.default_payment_card_last4, '1234');
    });

    it('handles discounts with no end date (e.g. forever discounts)', async function () {
      const discountStart = 1768940436;

      const subscriptionWithForeverDiscount = {
        ...subscriptionData,
        discount: {
          id: 'di_forever',
          coupon: {
            id: 'forever_coupon',
            percent_off: 20,
            duration: 'forever',
          },
          start: discountStart,
          end: null,
        },
      };

      const repo = buildRepo({
        stripeAPIService: {
          ...stripeAPIService,
          getSubscription: sinon.stub().resolves(subscriptionWithForeverDiscount),
        },
        StripeCustomerSubscription,
        MemberPaidSubscriptionEvent,
        MemberProductEvent,
        productRepository,
        offersAPI,
        Member,
        OfferRedemption: mockOfferRedemption,
      });

      sinon.stub(repo, 'getSubscriptionByStripeID').resolves(null);

      await repo.linkSubscription(
        {
          subscription: subscriptionWithForeverDiscount,
        },
        {
          transacting: {
            executionPromise: Promise.resolve(),
          },
          context: {},
        },
      );

      sinon.assert.calledOnce(StripeCustomerSubscription.add);
      const addedSubscriptionData = StripeCustomerSubscription.add.firstCall.args[0];

      assert.ok(addedSubscriptionData.discount_start instanceof Date);
      assert.equal(addedSubscriptionData.discount_start.getTime(), discountStart * 1000);
      assert.equal(addedSubscriptionData.discount_end, null);
    });

    it('clears offer_id when existing subscription has no active trial and no Stripe discount', async function () {
      // Subscription has an old offer_id but the Stripe discount has expired (no discount in webhook data)
      // and there is no active trial — offer_id should be cleared (not preserved)
      const repo = buildRepo({
        stripeAPIService,
        StripeCustomerSubscription,
        MemberPaidSubscriptionEvent,
        MemberProductEvent,
        productRepository,
        Member,
        OfferRedemption: mockOfferRedemption,
      });

      sinon.stub(repo, 'getSubscriptionByStripeID').resolves({
        load: sinon.stub().resolvesThis(),
        id: 'sub_db_id',
        get: sinon.stub().callsFake((key) => {
          if (key === 'offer_id') {
            return 'old_offer_123';
          }
          if (key === 'trial_end_at') {
            return null;
          }
          return null;
        }),
      });

      DomainEvents.subscribe(OfferRedemptionEvent, offerRedemptionNotifySpy);

      await repo.linkSubscription(
        {
          subscription: subscriptionData, // no discount, so offer_id resolves to null
        },
        {
          transacting: {
            executionPromise: Promise.resolve(),
          },
          context: {},
        },
      );

      sinon.assert.calledOnce(StripeCustomerSubscription.edit);
      const editedData = StripeCustomerSubscription.edit.firstCall.args[0];

      // offer_id should NOT have been deleted — it should be null (clearing the stale value)
      assert.ok('offer_id' in editedData, 'offer_id should be present in the update data');
      assert.equal(editedData.offer_id, null);
    });

    it('preserves offer_id when existing subscription has an active trial', async function () {
      // Trial offers don't create Stripe discounts, so offer_id can't be resolved from Stripe.
      // When the trial is active, offer_id should be preserved (not cleared).
      const futureTrialEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days from now

      const repo = buildRepo({
        stripeAPIService,
        StripeCustomerSubscription,
        MemberPaidSubscriptionEvent,
        MemberProductEvent,
        productRepository,
        Member,
        OfferRedemption: mockOfferRedemption,
      });

      sinon.stub(repo, 'getSubscriptionByStripeID').resolves({
        load: sinon.stub().resolvesThis(),
        id: 'sub_db_id',
        get: sinon.stub().callsFake((key) => {
          if (key === 'offer_id') {
            return 'trial_offer_123';
          }
          return null;
        }),
      });

      stripeAPIService.getSubscription.resolves({
        ...subscriptionData,
        trial_start: Date.now() / 1000 - 7 * 24 * 60 * 60,
        trial_end: futureTrialEnd.getTime() / 1000,
      });

      await repo.linkSubscription(
        {
          subscription: subscriptionData, // no discount, so offer_id resolves to null
        },
        {
          transacting: {
            executionPromise: Promise.resolve(),
          },
          context: {},
        },
      );

      sinon.assert.calledOnce(StripeCustomerSubscription.edit);
      const editedData = StripeCustomerSubscription.edit.firstCall.args[0];

      // offer_id should have been deleted from the update data (preserving the existing value)
      assert.ok(
        !('offer_id' in editedData),
        'offer_id should be deleted from update data to preserve existing value',
      );
    });

    it('clears offer_id when existing subscription has an expired trial', async function () {
      // Trial is over — offer_id should be allowed to clear
      const pastTrialEnd = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 days ago

      const repo = buildRepo({
        stripeAPIService,
        StripeCustomerSubscription,
        MemberPaidSubscriptionEvent,
        MemberProductEvent,
        productRepository,
        Member,
        OfferRedemption: mockOfferRedemption,
      });

      sinon.stub(repo, 'getSubscriptionByStripeID').resolves({
        load: sinon.stub().resolvesThis(),
        id: 'sub_db_id',
        get: sinon.stub().callsFake((key) => {
          if (key === 'offer_id') {
            return 'trial_offer_123';
          }
          return null;
        }),
      });

      stripeAPIService.getSubscription.resolves({
        ...subscriptionData,
        trial_start: pastTrialEnd.getTime() / 1000 - 7 * 24 * 60 * 60,
        trial_end: pastTrialEnd.getTime() / 1000,
      });

      await repo.linkSubscription(
        {
          subscription: subscriptionData, // no discount
        },
        {
          transacting: {
            executionPromise: Promise.resolve(),
          },
          context: {},
        },
      );

      sinon.assert.calledOnce(StripeCustomerSubscription.edit);
      const editedData = StripeCustomerSubscription.edit.firstCall.args[0];

      // offer_id should NOT have been deleted — it should be null (clearing the stale value)
      assert.ok('offer_id' in editedData, 'offer_id should be present in the update data');
      assert.equal(editedData.offer_id, null);
    });

    it('dispatches OfferRedemptionEvent when offer_id changes from one offer to another', async function () {
      // A retention offer replaces an expired signup offer (old → new)
      // The event timestamp should use the Stripe discount start time, not the subscription created_at
      const discountStartUnix = Math.floor(Date.now() / 1000) - 60; // 1 minute ago
      const subscriptionWithDiscount = {
        ...subscriptionData,
        discount: {
          coupon: {
            id: 'coupon_retention',
            percent_off: 20,
            duration: 'once',
          },
          start: discountStartUnix,
          end: null,
        },
      };

      const repo = buildRepo({
        stripeAPIService: {
          ...stripeAPIService,
          getSubscription: sinon.stub().resolves(subscriptionWithDiscount),
        },
        StripeCustomerSubscription,
        MemberPaidSubscriptionEvent,
        MemberProductEvent,
        productRepository,
        offersAPI,
        Member,
        OfferRedemption: mockOfferRedemption,
      });

      sinon.stub(repo, 'getSubscriptionByStripeID').resolves({
        load: sinon.stub().resolvesThis(),
        id: 'sub_db_id',
        get: sinon.stub().callsFake((key) => {
          if (key === 'offer_id') {
            return 'old_offer_123';
          }
          if (key === 'trial_end_at') {
            return null;
          }
          return null;
        }),
      });

      DomainEvents.subscribe(OfferRedemptionEvent, offerRedemptionNotifySpy);

      await repo.linkSubscription(
        {
          id: 'member_id_123',
          subscription: subscriptionWithDiscount,
          offerId: 'new_retention_offer_456',
        },
        {
          transacting: {
            executionPromise: Promise.resolve(),
          },
          context: {},
        },
      );

      sinon.assert.called(offerRedemptionNotifySpy);
      sinon.assert.calledWith(
        offerRedemptionNotifySpy,
        sinon.match((event) => {
          return event.data.offerId === 'new_retention_offer_456';
        }),
      );

      // Timestamp should be the discount start, not the subscription created_at
      const event = offerRedemptionNotifySpy.firstCall.args[0];

      assert.equal(event.timestamp.getTime(), discountStartUnix * 1000);
    });

    it('dispatches OfferRedemptionEvent with created_at timestamp when no Stripe discount is present', async function () {
      // Trial offers don't have Stripe discounts — timestamp falls back to created_at
      const subCreatedAt = new Date('2025-06-15T00:00:00Z');

      const repo = buildRepo({
        stripeAPIService,
        StripeCustomerSubscription: {
          ...StripeCustomerSubscription,
          edit: sinon.stub().resolves({
            id: 'sub_db_id',
            get: sinon.stub().callsFake((key) => {
              if (key === 'created_at') {
                return subCreatedAt;
              }
              return null;
            }),
          }),
        },
        MemberPaidSubscriptionEvent,
        MemberProductEvent,
        productRepository,
        Member,
        OfferRedemption: mockOfferRedemption,
      });

      sinon.stub(repo, 'getSubscriptionByStripeID').resolves({
        load: sinon.stub().resolvesThis(),
        id: 'sub_db_id',
        get: sinon.stub().callsFake((key) => {
          if (key === 'offer_id') {
            return null;
          }
          if (key === 'trial_end_at') {
            return null;
          }
          return null;
        }),
      });

      DomainEvents.subscribe(OfferRedemptionEvent, offerRedemptionNotifySpy);

      await repo.linkSubscription(
        {
          id: 'member_id_123',
          subscription: subscriptionData,
          offerId: 'trial_offer_789',
        },
        {
          transacting: {
            executionPromise: Promise.resolve(),
          },
          context: {},
        },
      );

      sinon.assert.called(offerRedemptionNotifySpy);

      const event = offerRedemptionNotifySpy.firstCall.args[0];

      assert.equal(event.data.offerId, 'trial_offer_789');
      assert.equal(event.timestamp.getTime(), subCreatedAt.getTime());
    });

    it('overwrites offer_id when new offer arrives via Stripe even with an active trial', async function () {
      // A subscription has an active trial AND a new discount arrives from Stripe
      // The new offer should overwrite the existing one (the trial guard only applies when offer_id is null)
      const futureTrialEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

      const subscriptionWithDiscount = {
        ...subscriptionData,
        trial_start: Date.now() / 1000 - 7 * 24 * 60 * 60,
        trial_end: futureTrialEnd.getTime() / 1000,
        discount: {
          coupon: {
            id: 'coupon_new',
            percent_off: 15,
            duration: 'forever',
          },
          start: Date.now() / 1000,
          end: null,
        },
      };

      const repo = buildRepo({
        stripeAPIService: {
          ...stripeAPIService,
          getSubscription: sinon.stub().resolves(subscriptionWithDiscount),
        },
        StripeCustomerSubscription,
        MemberPaidSubscriptionEvent,
        MemberProductEvent,
        productRepository,
        offersAPI,
        Member,
        OfferRedemption: mockOfferRedemption,
      });

      sinon.stub(repo, 'getSubscriptionByStripeID').resolves({
        load: sinon.stub().resolvesThis(),
        id: 'sub_db_id',
        get: sinon.stub().callsFake((key) => {
          if (key === 'offer_id') {
            return 'old_trial_offer';
          }
          if (key === 'trial_end_at') {
            return futureTrialEnd;
          }
          return null;
        }),
      });

      DomainEvents.subscribe(OfferRedemptionEvent, offerRedemptionNotifySpy);

      await repo.linkSubscription(
        {
          subscription: subscriptionWithDiscount,
        },
        {
          transacting: {
            executionPromise: Promise.resolve(),
          },
          context: {},
        },
      );

      sinon.assert.calledOnce(StripeCustomerSubscription.edit);
      const editedData = StripeCustomerSubscription.edit.firstCall.args[0];

      // New offer should overwrite — offer_id should be present and set to the new offer
      assert.ok('offer_id' in editedData, 'offer_id should be present in the update data');
      assert.equal(editedData.offer_id, 'offer_new'); // from offersAPI.ensureOfferForStripeCoupon stub

      // Should dispatch redemption event for the new offer
      sinon.assert.called(offerRedemptionNotifySpy);
      sinon.assert.calledWith(
        offerRedemptionNotifySpy,
        sinon.match((event) => {
          return event.data.offerId === 'offer_new';
        }),
      );
    });

    it('does not dispatch OfferRedemptionEvent when offer_id stays the same', async function () {
      // Same offer synced again via webhook — no new event
      const subscriptionWithDiscount = {
        ...subscriptionData,
        discount: {
          coupon: {
            id: 'coupon_abc',
            percent_off: 20,
            duration: 'forever',
          },
          start: Date.now() / 1000,
          end: null,
        },
      };

      const repo = buildRepo({
        stripeAPIService: {
          ...stripeAPIService,
          getSubscription: sinon.stub().resolves(subscriptionWithDiscount),
        },
        StripeCustomerSubscription,
        MemberPaidSubscriptionEvent,
        MemberProductEvent,
        productRepository,
        offersAPI,
        Member,
        OfferRedemption: mockOfferRedemption,
      });

      sinon.stub(repo, 'getSubscriptionByStripeID').resolves({
        load: sinon.stub().resolvesThis(),
        id: 'sub_db_id',
        get: sinon.stub().callsFake((key) => {
          if (key === 'offer_id') {
            return 'offer_new'; // same as what ensureOfferForStripeCoupon returns
          }
          if (key === 'trial_end_at') {
            return null;
          }
          return null;
        }),
      });

      DomainEvents.subscribe(OfferRedemptionEvent, offerRedemptionNotifySpy);

      await repo.linkSubscription(
        {
          subscription: subscriptionWithDiscount,
        },
        {
          transacting: {
            executionPromise: Promise.resolve(),
          },
          context: {},
        },
      );

      sinon.assert.notCalled(offerRedemptionNotifySpy);
    });
  });

  describe('create - automation integration', function () {
    it('triggers an automation event for free signup', async function () {
      const repo = buildRepo();
      await repo.create({ email: 'test@example.com', name: 'Test Member' }, {});

      sinon.assert.calledOnceWithExactly(automationsApi.trigger, {
        event: 'member_sign_up',
        memberId: 'member_id_123',
        memberEmail: 'test@example.com',
        memberStatus: 'free',
      });
    });

    describe('legacy automations', function () {
      it('creates automation run for free member signup (free welcome email)', async function () {
        const repo = buildRepo({
          Member,
          WelcomeEmailAutomationRun,
          MemberStatusEvent,
          MemberSubscribeEventModel: MemberSubscribeEvent,
          newslettersService,
          Automation,
          OfferRedemption: mockOfferRedemption,
        });

        await repo.create({ email: 'test@example.com', name: 'Test Member' }, {});

        sinon.assert.calledOnce(WelcomeEmailAutomationRun.add);
        const runCall = WelcomeEmailAutomationRun.add.firstCall.args[0];
        assert.equal(runCall.welcome_email_automation_id, 'automation_id_free');
        assert.equal(runCall.member_id, 'member_id_123');
        assert.equal(runCall.next_welcome_email_automated_email_id, 'automated_email_id_free');
        assert.ok(runCall.ready_at);
        assert.equal(runCall.step_started_at, null);
        assert.equal(runCall.step_attempts, 0);
        assert.equal(runCall.exit_reason, null);
      });

      it('does NOT create automation run when the automations labs flag is enabled', async function () {
        labsIsSet.withArgs('automations').returns(true);

        const repo = buildRepo({
          Member,
          WelcomeEmailAutomationRun,
          MemberStatusEvent,
          MemberSubscribeEventModel: MemberSubscribeEvent,
          newslettersService,
          Automation,
          OfferRedemption: mockOfferRedemption,
        });

        await repo.create({ email: 'test@example.com', name: 'Test Member' }, {});

        sinon.assert.calledOnceWithExactly(automationsApi.trigger, {
          event: 'member_sign_up',
          memberId: 'member_id_123',
          memberEmail: 'test@example.com',
          memberStatus: 'free',
        });
        sinon.assert.notCalled(WelcomeEmailAutomationRun.add);
        sinon.assert.notCalled(Automation.findOne);
      });

      it('does not create automation run for disallowed sources', async function () {
        const repo = buildRepo({
          Member,
          WelcomeEmailAutomationRun,
          MemberStatusEvent,
          MemberSubscribeEventModel: MemberSubscribeEvent,
          newslettersService,
          Automation,
          OfferRedemption: mockOfferRedemption,
        });

        const disallowedSources = [
          { name: 'import', context: { import: true } },
          { name: 'admin', context: { user: true } },
          { name: 'api', context: { api_key: true } },
        ];

        for (const source of disallowedSources) {
          WelcomeEmailAutomationRun.add.resetHistory();
          await repo.create(
            { email: 'test@example.com', name: 'Test Member' },
            { context: source.context },
          );
          sinon.assert.notCalled(WelcomeEmailAutomationRun.add);
        }
      });

      it('passes transaction to automation run creation', async function () {
        const repo = buildRepo({
          Member,
          WelcomeEmailAutomationRun,
          MemberStatusEvent,
          MemberSubscribeEventModel: MemberSubscribeEvent,
          newslettersService,
          Automation,
          OfferRedemption: mockOfferRedemption,
        });

        await repo.create({ email: 'test@example.com', name: 'Test Member' }, {});

        const runOptions = WelcomeEmailAutomationRun.add.firstCall.args[1];
        assert.ok(runOptions.transacting);
      });

      it('does NOT create automation run when welcome email is inactive', async function () {
        Automation.findOne.resolves({
          get: sinon.stub().callsFake((key) => {
            const data = { status: 'inactive' };
            return data[key];
          }),
          related: sinon.stub().callsFake((relation) => {
            assert.equal(relation, 'welcomeEmailAutomatedEmail');
            return {
              get: sinon.stub().callsFake((key) => {
                const data = { lexical: '{"root":{}}' };
                return data[key];
              }),
            };
          }),
        });

        const repo = buildRepo({
          Member,
          WelcomeEmailAutomationRun,
          MemberStatusEvent,
          MemberSubscribeEventModel: MemberSubscribeEvent,
          newslettersService,
          Automation,
          OfferRedemption: mockOfferRedemption,
        });

        await repo.create({ email: 'test@example.com', name: 'Test Member' }, {});

        sinon.assert.notCalled(WelcomeEmailAutomationRun.add);
      });

      it('does NOT create automation run when member is signing up for a paid subscription (stripeCustomer is present)', async function () {
        const repo = buildRepo({
          Member,
          WelcomeEmailAutomationRun,
          MemberStatusEvent,
          MemberSubscribeEventModel: MemberSubscribeEvent,
          newslettersService,
          Automation,
          OfferRedemption: mockOfferRedemption,
        });

        // Stub linkSubscription to avoid needing all the stripe-related mocks
        sinon.stub(repo, 'linkSubscription').resolves();
        sinon.stub(repo, 'upsertCustomer').resolves();

        // Create a member with a stripeCustomer (i.e., signing up for paid subscription)
        await repo.create(
          {
            email: 'test@example.com',
            name: 'Test Member',
            stripeCustomer: {
              id: 'cus_123',
              name: 'Test Member',
              email: 'test@example.com',
              subscriptions: {
                data: [
                  {
                    id: 'sub_123',
                    customer: 'cus_123',
                    status: 'active',
                  },
                ],
              },
            },
          },
          {},
        );

        // The free welcome email should NOT be sent when stripeCustomer is present
        sinon.assert.notCalled(WelcomeEmailAutomationRun.add);
        sinon.assert.notCalled(Automation.findOne);
        sinon.assert.notCalled(Member.transaction);
      });
    });
  });

  describe('linkSubscription - automation integration', function () {
    let subscriptionData;

    afterEach(function () {
      sinon.restore();
    });

    beforeEach(function () {
      sinon.stub(MemberRepository.prototype, '_updateCurrentSubscription').resolves();
      subscriptionData = {
        id: 'sub_123',
        customer: 'cus_123',
        status: 'active',
        items: {
          type: 'list',
          data: [
            {
              id: 'item_123',
              price: {
                id: 'price_123',
                product: 'product_123',
                active: true,
                nickname: 'Monthly',
                currency: 'usd',
                recurring: {
                  interval: 'month',
                },
                unit_amount: 500,
                type: 'recurring',
              },
            },
          ],
        },
        start_date: Date.now() / 1000,
        current_period_end: Date.now() / 1000 + 60 * 60 * 24 * 31,
        cancel_at_period_end: false,
      };

      Member = {
        findOne: sinon.stub().resolves({
          id: 'member_id_123',
          get: sinon.stub().callsFake((key) => {
            const data = {
              email: 'test@example.com',
              name: 'Test Member',
            };
            return data[key];
          }),
          related: (relation) => {
            return {
              query: sinon.stub().returns({
                fetchOne: sinon.stub().resolves({}),
              }),
              toJSON: sinon.stub().returns(relation === 'products' ? [] : {}),
              fetch: sinon.stub().resolves({
                toJSON: sinon.stub().returns(relation === 'products' ? [] : {}),
                models: [],
              }),
            };
          },
          toJSON: sinon.stub().returns({}),
        }),
        edit: sinon.stub().resolves({
          attributes: {},
          _previousAttributes: {},
          // The real _Member.edit resolves a bookshelf model; linkSubscription
          // loads relations off it when a subscription cancel flag changes
          load: sinon.stub().resolvesThis(),
          related: sinon.stub().returns({ models: [] }),
        }),
      };

      WelcomeEmailAutomationRun = {
        add: sinon.stub().resolves(),
      };

      MemberPaidSubscriptionEvent = {
        add: sinon.stub().resolves(),
      };

      StripeCustomerSubscription = {
        add: sinon.stub().resolves({
          id: 'stripe_sub_id_123',
          get: sinon.stub().callsFake((key) => {
            const data = {
              created_at: new Date(),
              status: 'active',
              cancel_at_period_end: false,
            };
            return data[key];
          }),
        }),
        edit: sinon.stub().resolves({
          id: 'stripe_sub_id_123',
          get: sinon.stub().callsFake((key) => {
            const data = {
              created_at: new Date(),
              status: 'active',
              cancel_at_period_end: false,
            };
            return data[key];
          }),
        }),
      };

      MemberProductEvent = {
        add: sinon.stub().resolves({}),
      };

      MemberStatusEvent = {
        add: sinon.stub().resolves(),
      };

      stripeAPIService = {
        configured: true,
        getSubscription: sinon.stub().resolves(subscriptionData),
        getCustomer: sinon.stub().resolves({
          id: 'cus_123',
          invoice_settings: {
            default_payment_method: null,
          },
          subscriptions: { data: [] },
        }),
      };

      productRepository = {
        get: sinon.stub().resolves({
          get: sinon.stub().returns(),
          toJSON: sinon.stub().returns({}),
        }),
        update: sinon.stub().resolves({}),
      };

      Automation = {
        findOne: sinon.stub().resolves({
          id: 'automation_id_paid',
          get: sinon.stub().callsFake((key) => {
            const data = { status: 'active' };
            return data[key];
          }),
          related: sinon.stub().callsFake((relation) => {
            assert.equal(relation, 'welcomeEmailAutomatedEmail');
            return {
              id: 'automated_email_id_paid',
              get: sinon.stub().callsFake((key) => {
                const data = { lexical: '{"root":{}}' };
                return data[key];
              }),
            };
          }),
        }),
      };
    });

    afterEach(function () {
      sinon.restore();
    });

    it('triggers an automation event for paid signup', async function () {
      Member.edit.resolves({
        attributes: { status: 'paid' },
        _previousAttributes: { status: 'free' },
        get: sinon.stub().callsFake((key) => {
          const data = { status: 'paid' };
          return data[key];
        }),
      });

      const repo = buildRepo();
      sinon.stub(repo, 'getSubscriptionByStripeID').resolves(null);

      await repo.linkSubscription(
        {
          id: 'member_id_123',
          subscription: subscriptionData,
        },
        {
          transacting: {
            executionPromise: Promise.resolve(),
          },
          context: {},
        },
      );

      sinon.assert.calledOnceWithExactly(automationsApi.trigger, {
        event: 'member_sign_up',
        memberId: 'member_id_123',
        memberEmail: 'test@example.com',
        memberStatus: 'paid',
      });
    });

    describe('legacy automations', function () {
      it('creates automation run when member status changes to paid', async function () {
        Member.edit.resolves({
          attributes: { status: 'paid' },
          _previousAttributes: { status: 'free' },
          get: sinon.stub().callsFake((key) => {
            const data = { status: 'paid' };
            return data[key];
          }),
        });

        const repo = buildRepo({
          Member,
          WelcomeEmailAutomationRun,
          MemberPaidSubscriptionEvent,
          StripeCustomerSubscription,
          MemberProductEvent,
          MemberStatusEvent,
          stripeAPIService,
          productRepository,
          Automation,
          OfferRedemption: mockOfferRedemption,
        });

        sinon.stub(repo, 'getSubscriptionByStripeID').resolves(null);

        await repo.linkSubscription(
          {
            id: 'member_id_123',
            subscription: subscriptionData,
          },
          {
            transacting: {
              executionPromise: Promise.resolve(),
            },
            context: {},
          },
        );

        sinon.assert.calledOnce(WelcomeEmailAutomationRun.add);
        const runCall = WelcomeEmailAutomationRun.add.firstCall.args[0];
        assert.equal(runCall.welcome_email_automation_id, 'automation_id_paid');
        assert.equal(runCall.member_id, 'member_id_123');
        assert.equal(runCall.next_welcome_email_automated_email_id, 'automated_email_id_paid');
        assert.ok(runCall.ready_at);
        assert.equal(runCall.step_started_at, null);
        assert.equal(runCall.step_attempts, 0);
        assert.equal(runCall.exit_reason, null);
      });

      it('does NOT create automation run when the automations labs flag is enabled', async function () {
        labsIsSet.withArgs('automations').returns(true);

        Member.edit.resolves({
          attributes: { status: 'paid' },
          _previousAttributes: { status: 'free' },
          get: sinon.stub().callsFake((key) => {
            const data = { status: 'paid' };
            return data[key];
          }),
        });

        const repo = buildRepo({
          Member,
          WelcomeEmailAutomationRun,
          MemberPaidSubscriptionEvent,
          StripeCustomerSubscription,
          MemberProductEvent,
          MemberStatusEvent,
          stripeAPIService,
          productRepository,
          Automation,
          OfferRedemption: mockOfferRedemption,
        });

        sinon.stub(repo, 'getSubscriptionByStripeID').resolves(null);

        await repo.linkSubscription(
          {
            id: 'member_id_123',
            subscription: subscriptionData,
          },
          {
            transacting: {
              executionPromise: Promise.resolve(),
            },
            context: {},
          },
        );

        sinon.assert.calledOnceWithExactly(automationsApi.trigger, {
          event: 'member_sign_up',
          memberId: 'member_id_123',
          memberEmail: 'test@example.com',
          memberStatus: 'paid',
        });
        sinon.assert.notCalled(WelcomeEmailAutomationRun.add);
        sinon.assert.notCalled(Automation.findOne);
      });

      it('does NOT create automation run for disallowed sources', async function () {
        Member.edit.resolves({
          attributes: { status: 'paid' },
          _previousAttributes: { status: 'free' },
          get: sinon.stub().callsFake((key) => {
            const data = { status: 'paid' };
            return data[key];
          }),
        });

        const repo = buildRepo({
          Member,
          WelcomeEmailAutomationRun,
          MemberPaidSubscriptionEvent,
          StripeCustomerSubscription,
          MemberProductEvent,
          MemberStatusEvent,
          stripeAPIService,
          productRepository,
          Automation,
          OfferRedemption: mockOfferRedemption,
        });

        sinon.stub(repo, 'getSubscriptionByStripeID').resolves(null);

        const disallowedSources = [
          { name: 'import', context: { import: true } },
          { name: 'admin', context: { user: true } },
          { name: 'api', context: { api_key: true } },
        ];

        for (const source of disallowedSources) {
          WelcomeEmailAutomationRun.add.resetHistory();
          await repo.linkSubscription(
            {
              id: 'member_id_123',
              subscription: subscriptionData,
            },
            {
              transacting: {
                executionPromise: Promise.resolve(),
              },
              context: source.context,
            },
          );
          sinon.assert.notCalled(WelcomeEmailAutomationRun.add);
        }
      });

      it('does NOT create automation run when paid welcome email is inactive', async function () {
        Member.edit.resolves({
          attributes: { status: 'paid' },
          _previousAttributes: { status: 'free' },
          get: sinon.stub().callsFake((key) => {
            const data = { status: 'paid' };
            return data[key];
          }),
        });

        Automation.findOne.resolves({
          id: 'automation_id_paid',
          get: sinon.stub().callsFake((key) => {
            const data = { status: 'inactive' };
            return data[key];
          }),
          related: sinon.stub().callsFake((relation) => {
            assert.equal(relation, 'welcomeEmailAutomatedEmail');
            return {
              id: 'automated_email_id_paid',
              get: sinon.stub().callsFake((key) => {
                const data = { lexical: '{"root":{}}' };
                return data[key];
              }),
            };
          }),
        });

        const repo = buildRepo({
          Member,
          WelcomeEmailAutomationRun,
          MemberPaidSubscriptionEvent,
          StripeCustomerSubscription,
          MemberProductEvent,
          MemberStatusEvent,
          stripeAPIService,
          productRepository,
          Automation,
          OfferRedemption: mockOfferRedemption,
        });

        sinon.stub(repo, 'getSubscriptionByStripeID').resolves(null);

        await repo.linkSubscription(
          {
            id: 'member_id_123',
            subscription: subscriptionData,
          },
          {
            transacting: {
              executionPromise: Promise.resolve(),
            },
            context: {},
          },
        );

        sinon.assert.notCalled(WelcomeEmailAutomationRun.add);
      });

      it('does NOT create automation run when previous status was "gift" (already received paid welcome at redemption)', async function () {
        Member.edit.resolves({
          attributes: { status: 'paid' },
          _previousAttributes: { status: 'gift' },
          get: sinon.stub().callsFake((key) => {
            const data = { status: 'paid' };
            return data[key];
          }),
        });

        const repo = buildRepo({
          Member,
          WelcomeEmailAutomationRun,
          MemberPaidSubscriptionEvent,
          StripeCustomerSubscription,
          MemberProductEvent,
          MemberStatusEvent,
          stripeAPIService,
          productRepository,
          Automation,
          OfferRedemption: mockOfferRedemption,
        });

        sinon.stub(repo, 'getSubscriptionByStripeID').resolves(null);

        await repo.linkSubscription(
          {
            id: 'member_id_123',
            subscription: subscriptionData,
          },
          {
            transacting: {
              executionPromise: Promise.resolve(),
            },
            context: {},
          },
        );

        sinon.assert.notCalled(WelcomeEmailAutomationRun.add);
      });
    });
  });

  describe('create - member status', function () {
    let memberAdd;

    beforeEach(function () {
      memberAdd = sinon.stub().resolves({
        id: 'member_id_status',
        get: sinon.stub().callsFake((key) => {
          const data = {
            email: 'test@example.com',
            status: 'free',
            created_at: new Date(),
          };
          return data[key];
        }),
        related: sinon.stub().returns({ models: [] }),
      });

      Member = {
        transaction: sinon.stub().callsFake((callback) => {
          return callback({ executionPromise: Promise.resolve() });
        }),
        add: memberAdd,
      };

      MemberStatusEvent = { add: sinon.stub().resolves() };
      MemberSubscribeEvent = { add: sinon.stub().resolves() };

      newslettersService = {
        getDefaultNewsletters: sinon.stub().resolves([]),
        getAll: sinon.stub().resolves([]),
      };

      Automation = {
        findOne: sinon.stub().resolves(null),
      };

      productRepository = {
        get: sinon.stub().resolves({
          id: 'tier_1',
          get: sinon.stub().withArgs('active').returns(true),
        }),
      };
    });

    it('defaults status to "free" when no status and no products are provided', async function () {
      await buildRepo().create({ email: 'test@example.com', name: 'Test Member' }, {});

      sinon.assert.calledOnce(memberAdd);
      assert.equal(memberAdd.firstCall.args[0].status, 'free');
    });

    it('defaults status to "comped" when no status is provided but a product is', async function () {
      await buildRepo().create(
        {
          email: 'test@example.com',
          name: 'Test Member',
          products: [{ id: 'tier_1' }],
        },
        {},
      );

      sinon.assert.calledOnce(memberAdd);
      assert.equal(memberAdd.firstCall.args[0].status, 'comped');
    });

    it('respects the status passed in data instead of overriding it', async function () {
      await buildRepo().create(
        {
          email: 'test@example.com',
          name: 'Test Member',
          status: 'gift',
        },
        {},
      );

      sinon.assert.calledOnce(memberAdd);
      assert.equal(memberAdd.firstCall.args[0].status, 'gift');
    });

    it('respects the status passed in data even when a product is passed', async function () {
      await buildRepo().create(
        {
          email: 'test@example.com',
          name: 'Test Member',
          status: 'gift',
          products: [{ id: 'tier_1' }],
        },
        {},
      );

      sinon.assert.calledOnce(memberAdd);
      assert.equal(memberAdd.firstCall.args[0].status, 'gift');
    });

    it('rejects invalid status in create', async function () {
      const repo = buildRepo();

      try {
        await repo.create(
          {
            email: 'test@example.com',
            name: 'Test Member',
            status: 'not-a-real-status',
          },
          {},
        );

        assert.fail('Expected create to reject invalid status');
      } catch (err) {
        assert.equal(err instanceof errors.ValidationError, true);
        assert.equal(err.property, 'status');
        assert.equal(err.message, 'Invalid member status, must be one of free, paid, comped, gift');
      }

      sinon.assert.notCalled(Member.add);
      sinon.assert.notCalled(Member.transaction);
    });

    it('allows gift members to be created on an archived tier (gift was valid at purchase time)', async function () {
      productRepository.get = sinon.stub().resolves({
        id: 'tier_1',
        get: sinon.stub().withArgs('active').returns(false),
      });

      await buildRepo().create(
        {
          email: 'test@example.com',
          name: 'Test Member',
          status: 'gift',
          products: [{ id: 'tier_1' }],
        },
        {},
      );

      sinon.assert.calledOnce(memberAdd);
      assert.equal(memberAdd.firstCall.args[0].status, 'gift');
    });

    it('rejects non-gift members being created on an archived tier', async function () {
      productRepository.get = sinon.stub().resolves({
        id: 'tier_1',
        get: sinon.stub().withArgs('active').returns(false),
      });

      try {
        await buildRepo().create(
          {
            email: 'test@example.com',
            name: 'Test Member',
            products: [{ id: 'tier_1' }],
          },
          {},
        );

        assert.fail('Expected create to reject archived tier for non-gift member');
      } catch (err) {
        assert.equal(err instanceof errors.BadRequestError, true);
        assert.equal(err.message, 'Cannot use archived Tiers');
      }

      sinon.assert.notCalled(memberAdd);
    });
  });

  describe('update - member status', function () {
    let memberEdit;
    let existingProducts;
    let existingSubscriptions;
    let initialMember;

    beforeEach(function () {
      memberEdit = sinon.stub().callsFake((data) => {
        return {
          id: 'member_id_status',
          updated_at: new Date(),
          attributes: {
            email: 'test@example.com',
            status: data.status,
          },
          _previousAttributes: {
            email: 'test@example.com',
            status: data.status,
          },
          _changed: {},
          get: sinon.stub().callsFake((key) => {
            const memberData = {
              email: 'test@example.com',
              status: data.status,
            };
            return memberData[key];
          }),
          related: sinon.stub().withArgs('stripeCustomers').returns({
            fetch: sinon.stub().resolves(),
            models: [],
          }),
        };
      });

      existingProducts = [];
      existingSubscriptions = [];

      initialMember = {
        get: sinon.stub().withArgs('email').returns('test@example.com'),
        related: sinon.stub().callsFake((relation) => {
          if (relation === 'products') {
            return { models: existingProducts };
          }

          if (relation === 'stripeSubscriptions') {
            return { models: existingSubscriptions };
          }

          if (relation === 'newsletters') {
            return { models: [] };
          }

          return { models: [] };
        }),
        load: sinon.stub().resolves(),
      };

      Member = {
        edit: memberEdit,
        findOne: sinon.stub().resolves(initialMember),
      };

      MemberProductEvent = { add: sinon.stub().resolves() };
      MemberStatusEvent = { add: sinon.stub().resolves() };
      MemberSubscribeEvent = { add: sinon.stub().resolves() };

      newslettersService = {
        getDefaultNewsletters: sinon.stub().resolves([]),
        getAll: sinon.stub().resolves([]),
      };

      Automation = {
        findOne: sinon.stub().resolves(null),
      };

      productRepository = {
        get: sinon.stub().resolves({
          id: 'tier_1',
          get: sinon.stub().withArgs('active').returns(true),
        }),
      };

      stripeAPIService = {
        configured: false,
      };
    });

    it('rejects invalid status in update', async function () {
      const repo = buildRepo();

      try {
        await repo.update(
          {
            status: 'not-a-real-status',
          },
          {
            id: 'member_id_123',
          },
        );

        assert.fail('Expected update to reject invalid status');
      } catch (err) {
        assert.equal(err instanceof errors.ValidationError, true);
        assert.equal(err.property, 'status');
        assert.equal(err.message, 'Invalid member status, must be one of free, paid, comped, gift');
      }

      sinon.assert.notCalled(Member.edit);
    });

    it('defaults status to "comped" when adding a product without an explicit status', async function () {
      const repo = buildRepo();
      stripeAPIService.configured = true;

      await repo.update(
        {
          products: [{ id: 'tier_1' }],
        },
        {
          id: 'member_id_123',
        },
      );

      sinon.assert.calledOnce(memberEdit);
      assert.equal(memberEdit.firstCall.args[0].status, 'comped');
    });

    it('respects an explicit status when adding a product', async function () {
      const repo = buildRepo();
      stripeAPIService.configured = true;

      await repo.update(
        {
          status: 'gift',
          products: [{ id: 'tier_1' }],
        },
        {
          id: 'member_id_123',
        },
      );

      sinon.assert.calledOnce(memberEdit);
      assert.equal(memberEdit.firstCall.args[0].status, 'gift');
    });

    it('defaults status to "free" when removing all products without active subscriptions', async function () {
      const repo = buildRepo();
      stripeAPIService.configured = true;
      existingProducts = [{ id: 'tier_1' }];

      await repo.update(
        {
          products: [],
        },
        {
          id: 'member_id_123',
        },
      );

      sinon.assert.calledOnce(memberEdit);
      assert.equal(memberEdit.firstCall.args[0].status, 'free');
    });

    it('allows gift redemption on an archived tier (gift was valid at purchase time)', async function () {
      productRepository.get = sinon.stub().resolves({
        id: 'tier_1',
        get: sinon.stub().withArgs('active').returns(false),
      });
      stripeAPIService.configured = true;

      await buildRepo().update(
        {
          status: 'gift',
          products: [{ id: 'tier_1' }],
        },
        {
          id: 'member_id_123',
        },
      );

      sinon.assert.calledOnce(memberEdit);
      assert.equal(memberEdit.firstCall.args[0].status, 'gift');
    });

    it('rejects adding an archived tier to a non-gift member', async function () {
      productRepository.get = sinon.stub().resolves({
        id: 'tier_1',
        get: sinon.stub().withArgs('active').returns(false),
      });
      stripeAPIService.configured = true;

      try {
        await buildRepo().update(
          {
            products: [{ id: 'tier_1' }],
          },
          {
            id: 'member_id_123',
          },
        );

        assert.fail('Expected update to reject archived tier for non-gift member');
      } catch (err) {
        assert.equal(err instanceof errors.BadRequestError, true);
        assert.equal(err.message, 'Cannot use archived Tiers');
      }

      sinon.assert.notCalled(memberEdit);
    });
  });

  describe('destroy', function () {
    it('passes require: false to tolerate concurrent deletes', async function () {
      Member = {
        findOne: sinon.stub().resolves({
          id: 'member_id_123',
          related: () => ({
            fetch: sinon.stub().resolves({ models: [] }),
          }),
        }),
        destroy: sinon.stub().resolves(),
      };

      const repo = buildRepo();

      await repo.destroy({ id: 'member_id_123' }, {});

      sinon.assert.calledOnce(Member.destroy);
      const destroyOptions = Member.destroy.firstCall.args[1];
      assert.equal(destroyOptions.require, false);
    });

    it('returns early when member does not exist', async function () {
      Member = {
        findOne: sinon.stub().resolves(null),
        destroy: sinon.stub(),
      };

      const repo = buildRepo();

      await repo.destroy({ id: 'nonexistent' }, {});

      sinon.assert.notCalled(Member.destroy);
    });
  });

  // fork(salvare): one-time purchases
  describe('purchase-sourced products', function () {
    const trx = { executionPromise: Promise.resolve() };
    let purchaseLinks;

    const purchased = (...entries) => {
      purchaseLinks.getPurchaseSourcedProducts.resolves(entries);
    };

    beforeEach(function () {
      purchaseLinks = { getPurchaseSourcedProducts: sinon.stub().resolves([]) };
      MemberProductEvent = { add: sinon.stub().resolves() };
      MemberStatusEvent = { add: sinon.stub().resolves() };
    });

    describe('_getPurchaseSourcedProducts', function () {
      it('returns [] when purchase links are not wired', async function () {
        const repo = buildRepo();
        assert.deepEqual(await repo._getPurchaseSourcedProducts('member_1', {}), []);
      });

      it('returns [] without a member id and does not query', async function () {
        const repo = buildRepo({ purchaseLinks });
        assert.deepEqual(await repo._getPurchaseSourcedProducts(undefined, {}), []);
        sinon.assert.notCalled(purchaseLinks.getPurchaseSourcedProducts);
      });

      it('delegates to purchase links with only the transaction', async function () {
        purchased({ id: 'course', expiry_at: null });
        const repo = buildRepo({ purchaseLinks });

        const result = await repo._getPurchaseSourcedProducts('member_1', {
          transacting: trx,
          forUpdate: true,
          id: 'member_1',
        });

        assert.deepEqual(result, [{ id: 'course', expiry_at: null }]);
        sinon.assert.calledOnceWithExactly(purchaseLinks.getPurchaseSourcedProducts, 'member_1', {
          transacting: trx,
        });
      });

      it('tolerates undefined options', async function () {
        const repo = buildRepo({ purchaseLinks });
        await repo._getPurchaseSourcedProducts('member_1', undefined);
        sinon.assert.calledOnceWithExactly(
          purchaseLinks.getPurchaseSourcedProducts,
          'member_1',
          {},
        );
      });
    });

    describe('transaction pass-through', function () {
      it('upsertCustomer passes options to the StripeCustomer upsert', async function () {
        const repo = buildRepo();
        const data = { customer_id: 'cus_1', member_id: 'member_1', name: 'A', email: 'a@b.c' };

        await repo.upsertCustomer(data, { transacting: trx });

        sinon.assert.calledOnceWithExactly(StripeCustomer.upsert, data, { transacting: trx });
      });

      it('upsertCustomer keeps working without options', async function () {
        const repo = buildRepo();
        const data = { customer_id: 'cus_1', member_id: 'member_1', name: 'A', email: 'a@b.c' };

        await repo.upsertCustomer(data);

        sinon.assert.calledOnce(StripeCustomer.upsert);
        assert.deepEqual(StripeCustomer.upsert.firstCall.args[0], data);
        assert.equal(StripeCustomer.upsert.firstCall.args[1], undefined);
      });

      it('get passes the transaction to Member.findOne', async function () {
        Member.findOne = sinon.stub().resolves(null);
        const repo = buildRepo();

        await repo.get({ uuid: 'uuid_1' }, { transacting: trx });

        sinon.assert.calledOnceWithExactly(
          Member.findOne,
          { uuid: 'uuid_1' },
          { transacting: trx },
        );
      });

      it('create uses the caller transaction for the member and its events', async function () {
        const repo = buildRepo({ MemberStatusEvent });

        await repo.create({ email: 'buyer@example.com', name: 'Buyer' }, { transacting: trx });

        sinon.assert.notCalled(Member.transaction);
        assert.equal(Member.add.firstCall.args[1].transacting, trx);
        assert.equal(MemberStatusEvent.add.firstCall.args[1].transacting, trx);
        assert.equal(newslettersService.getAll.firstCall.args[0].transacting, trx);
      });
    });

    describe('linkSubscription', function () {
      let memberProducts;
      let otherSubscriptions;
      let ghostProduct;
      let previousProduct;

      const productModel = (id) => ({
        id,
        get: sinon.stub().callsFake((key) => ({ id, name: id })[key]),
        toJSON: sinon.stub().returns({ id, expiry_at: null }),
      });

      const subscription = (status) => ({
        id: 'sub_123',
        customer: 'cus_123',
        status,
        items: {
          type: 'list',
          data: [
            {
              id: 'item_123',
              price: {
                id: 'price_library',
                product: 'prod_library',
                active: true,
                nickname: 'Monthly',
                currency: 'usd',
                recurring: { interval: 'month' },
                unit_amount: 500,
                type: 'recurring',
              },
            },
          ],
        },
        start_date: Date.now() / 1000,
        current_period_end: Date.now() / 1000 + 60 * 60 * 24 * 31,
        cancel_at_period_end: false,
      });

      const link = async (status, { existingSubscription = null } = {}) => {
        const subscriptionData = subscription(status);
        stripeAPIService = {
          configured: true,
          getSubscription: sinon.stub().resolves(subscriptionData),
          getCustomer: sinon.stub().resolves({
            id: 'cus_123',
            invoice_settings: { default_payment_method: null },
            subscriptions: { data: [] },
          }),
        };
        const repo = buildRepo({ purchaseLinks });
        sinon.stub(repo, 'getSubscriptionByStripeID').resolves(existingSubscription);

        await repo.linkSubscription(
          { id: 'member_1', subscription: subscriptionData },
          { transacting: trx, context: {} },
        );
        return repo;
      };

      beforeEach(function () {
        sinon.stub(MemberRepository.prototype, '_updateCurrentSubscription').resolves();
        memberProducts = [];
        otherSubscriptions = [];
        ghostProduct = productModel('library');
        previousProduct = null;

        Member = {
          findOne: sinon.stub().resolves({
            id: 'member_1',
            get: sinon.stub().returns(undefined),
            related: (relation) => ({
              query: sinon.stub().returns({ fetchOne: sinon.stub().resolves({}) }),
              toJSON: sinon.stub().callsFake(() => (relation === 'products' ? memberProducts : {})),
              fetch: sinon.stub().callsFake(async () => ({
                toJSON: () => (relation === 'products' ? memberProducts : {}),
                models: relation === 'stripeSubscriptions' ? otherSubscriptions : [],
              })),
            }),
            toJSON: sinon.stub().returns({}),
          }),
          edit: sinon.stub().resolves({
            attributes: {},
            _previousAttributes: {},
            load: sinon.stub().resolvesThis(),
            related: sinon.stub().returns({ models: [] }),
          }),
        };
        StripeCustomerSubscription = {
          add: sinon.stub().resolves({ id: 'mscs_1', get: sinon.stub().returns() }),
          edit: sinon.stub().callsFake(async (data) => ({
            id: 'mscs_1',
            get: (key) => data[key],
          })),
        };
        MemberPaidSubscriptionEvent = { add: sinon.stub().resolves() };
        productRepository = {
          get: sinon.stub().callsFake(async (filter) => {
            if (filter.stripe_product_id) {
              return ghostProduct;
            }
            if (filter.stripe_price_id === 'price_old') {
              return previousProduct;
            }
            return null;
          }),
          update: sinon.stub().resolves({}),
          getDefaultProduct: sinon.stub().resolves(null),
        };
      });

      it('regression: a purchaser whose subscription is cancelled ends free and keeps the purchase', async function () {
        purchased({ id: 'course', expiry_at: null });
        memberProducts = [
          { id: 'course', expiry_at: null },
          { id: 'library', expiry_at: null },
        ];

        await link('canceled');

        sinon.assert.calledOnce(Member.edit);
        assert.deepEqual(Member.edit.firstCall.args[0], {
          status: 'free',
          products: [{ id: 'course', expiry_at: null }],
        });
        assert.equal(Member.edit.firstCall.args[1].id, 'member_1');
        sinon.assert.calledWith(purchaseLinks.getPurchaseSourcedProducts, 'member_1', {
          transacting: trx,
        });
        // only the subscription product is reported as removed
        sinon.assert.calledOnce(MemberProductEvent.add);
        assert.deepEqual(MemberProductEvent.add.firstCall.args[0], {
          member_id: 'member_1',
          product_id: 'library',
          action: 'removed',
        });
      });

      it('keeps paid when another active subscription is on a purchased tier', async function () {
        purchased({ id: 'course', expiry_at: null });
        memberProducts = [
          { id: 'course', expiry_at: null },
          { id: 'library', expiry_at: null },
        ];
        otherSubscriptions = [
          {
            get: sinon
              .stub()
              .callsFake((key) => ({ status: 'active', stripe_price_id: 'price_course' })[key]),
          },
        ];
        const getProduct = productRepository.get;
        productRepository.get = sinon.stub().callsFake(async (filter) => {
          if (filter.stripe_price_id === 'price_course') {
            return productModel('course');
          }
          return getProduct(filter);
        });

        await link('canceled');

        assert.deepEqual(Member.edit.firstCall.args[0], {
          status: 'paid',
          products: [{ id: 'course', expiry_at: null }],
        });
      });

      it('control: without purchase links the purchaser is left comped (upstream bug)', async function () {
        purchaseLinks = undefined;
        memberProducts = [
          { id: 'course', expiry_at: null },
          { id: 'library', expiry_at: null },
        ];

        await link('canceled');

        assert.deepEqual(Member.edit.firstCall.args[0], {
          status: 'comped',
          products: [{ id: 'course', expiry_at: null }],
        });
      });

      it('keeps a comp and its expiry_at next to the purchase, and stays comped', async function () {
        purchased({ id: 'course', expiry_at: null });
        memberProducts = [
          { id: 'course', expiry_at: null },
          { id: 'comp', expiry_at: '2026-12-01T00:00:00.000Z' },
          { id: 'library', expiry_at: null },
        ];

        await link('canceled');

        assert.deepEqual(Member.edit.firstCall.args[0], {
          status: 'comped',
          products: [
            { id: 'course', expiry_at: null },
            { id: 'comp', expiry_at: '2026-12-01T00:00:00.000Z' },
          ],
        });
      });

      it('keeps the expiry_at of an expiring purchase and ends free', async function () {
        const expiry = new Date('2027-06-01T00:00:00.000Z');
        purchased({ id: 'course', expiry_at: expiry });
        memberProducts = [
          { id: 'course', expiry_at: expiry },
          { id: 'library', expiry_at: null },
        ];

        await link('canceled');

        assert.deepEqual(Member.edit.firstCall.args[0], {
          status: 'free',
          products: [{ id: 'course', expiry_at: expiry }],
        });
      });

      it('keeps a purchased product when it was the previous product of a changed subscription', async function () {
        purchased({ id: 'course', expiry_at: null });
        memberProducts = [{ id: 'course', expiry_at: null }];
        previousProduct = productModel('course');
        const existingSubscription = {
          id: 'mscs_1',
          get: sinon.stub().callsFake(
            (key) =>
              ({
                stripe_price_id: 'price_old',
                plan_id: 'price_old',
                status: 'active',
                cancel_at_period_end: false,
                mrr: 500,
                offer_id: null,
              })[key],
          ),
        };

        await link('active', { existingSubscription });

        assert.deepEqual(Member.edit.firstCall.args[0], {
          status: 'paid',
          products: [
            { id: 'course', expiry_at: null },
            { id: 'library', expiry_at: null },
          ],
        });
      });

      it('control: without purchase links the previous product is dropped on a price change (upstream)', async function () {
        purchaseLinks = undefined;
        memberProducts = [{ id: 'course', expiry_at: null }];
        previousProduct = productModel('course');
        const existingSubscription = {
          id: 'mscs_1',
          get: sinon.stub().callsFake(
            (key) =>
              ({
                stripe_price_id: 'price_old',
                plan_id: 'price_old',
                status: 'active',
                cancel_at_period_end: false,
                mrr: 500,
                offer_id: null,
              })[key],
          ),
        };

        await link('active', { existingSubscription });

        assert.deepEqual(Member.edit.firstCall.args[0], {
          status: 'paid',
          products: [{ id: 'library', expiry_at: null }],
        });
      });
    });

    describe('update', function () {
      let memberEdit;
      let existingProducts;
      let existingSubscriptions;

      beforeEach(function () {
        memberEdit = sinon.stub().callsFake((data) => ({
          id: 'member_1',
          updated_at: new Date(),
          attributes: { email: 'test@example.com', status: data.status },
          _previousAttributes: { email: 'test@example.com', status: data.status },
          _changed: {},
          get: sinon
            .stub()
            .callsFake((key) => ({ email: 'test@example.com', status: data.status })[key]),
          related: sinon.stub().returns({ fetch: sinon.stub().resolves(), models: [] }),
        }));
        existingProducts = [];
        existingSubscriptions = [];

        const initialMember = {
          get: sinon.stub().withArgs('email').returns('test@example.com'),
          related: sinon.stub().callsFake((relation) => {
            if (relation === 'products') {
              return { models: existingProducts };
            }
            if (relation === 'stripeSubscriptions') {
              return { models: existingSubscriptions };
            }
            return { models: [] };
          }),
          load: sinon.stub().resolves(),
        };

        Member = { edit: memberEdit, findOne: sinon.stub().resolves(initialMember) };
        productRepository = {
          get: sinon.stub().callsFake(async ({ id }) => ({
            id,
            get: sinon.stub().withArgs('active').returns(true),
          })),
        };
        stripeAPIService = { configured: true };
        purchased({ id: 'course', expiry_at: null });
      });

      it('comps a purchaser without tripping moreThanOneProduct, keeping the purchase', async function () {
        existingProducts = [{ id: 'course' }];

        await buildRepo({ purchaseLinks }).update(
          { products: [{ id: 'course' }, { id: 'comp' }] },
          { id: 'member_1' },
        );

        sinon.assert.calledOnce(memberEdit);
        const payload = memberEdit.firstCall.args[0];
        assert.equal(payload.status, 'comped');
        assert.deepEqual(payload.products, [{ id: 'comp' }, { id: 'course', expiry_at: null }]);
        sinon.assert.calledOnce(MemberProductEvent.add);
        assert.deepEqual(MemberProductEvent.add.firstCall.args[0], {
          member_id: 'member_1',
          product_id: 'comp',
          action: 'added',
        });
        sinon.assert.calledWith(purchaseLinks.getPurchaseSourcedProducts, 'member_1', {});
      });

      it('control: without purchase links the same comp is rejected (upstream)', async function () {
        existingProducts = [{ id: 'course' }];

        await assert.rejects(
          buildRepo().update({ products: [{ id: 'course' }, { id: 'comp' }] }, { id: 'member_1' }),
          { message: 'A member cannot have more than one Product' },
        );
      });

      it('comps a purchaser who omits the purchased tier from the request', async function () {
        existingProducts = [{ id: 'course' }];

        await buildRepo({ purchaseLinks }).update(
          { products: [{ id: 'comp' }] },
          { id: 'member_1' },
        );

        const payload = memberEdit.firstCall.args[0];
        assert.equal(payload.status, 'comped');
        assert.deepEqual(payload.products, [{ id: 'comp' }, { id: 'course', expiry_at: null }]);
        sinon.assert.calledOnce(MemberProductEvent.add);
        assert.equal(MemberProductEvent.add.firstCall.args[0].product_id, 'comp');
      });

      it('removing the comp makes the purchaser free and keeps the purchase', async function () {
        existingProducts = [{ id: 'course' }, { id: 'comp' }];

        await buildRepo({ purchaseLinks }).update(
          { products: [{ id: 'course' }] },
          { id: 'member_1' },
        );

        const payload = memberEdit.firstCall.args[0];
        assert.equal(payload.status, 'free');
        assert.deepEqual(payload.products, [{ id: 'course', expiry_at: null }]);
        sinon.assert.calledOnce(MemberProductEvent.add);
        assert.deepEqual(MemberProductEvent.add.firstCall.args[0], {
          member_id: 'member_1',
          product_id: 'comp',
          action: 'removed',
        });
      });

      it('re-attaches the purchase when a gift refund sends products: [] with status free', async function () {
        existingProducts = [{ id: 'course' }, { id: 'gift_tier' }];

        await buildRepo({ purchaseLinks }).update(
          { products: [], status: 'free' },
          { id: 'member_1' },
        );

        const payload = memberEdit.firstCall.args[0];
        assert.equal(payload.status, 'free');
        assert.deepEqual(payload.products, [{ id: 'course', expiry_at: null }]);
        sinon.assert.calledOnce(MemberProductEvent.add);
        assert.equal(MemberProductEvent.add.firstCall.args[0].product_id, 'gift_tier');
      });

      it('re-attaches the purchase when products: [] is sent and the purchase is the only link', async function () {
        existingProducts = [{ id: 'course' }];

        await buildRepo({ purchaseLinks }).update({ products: [] }, { id: 'member_1' });

        const payload = memberEdit.firstCall.args[0];
        assert.equal(payload.status, undefined);
        assert.deepEqual(payload.products, [{ id: 'course', expiry_at: null }]);
        sinon.assert.notCalled(MemberProductEvent.add);
      });

      it('moves a gift member to free when the gift tier is also purchased', async function () {
        existingProducts = [{ id: 'course' }];
        const initialMember = await Member.findOne();
        initialMember.get = sinon
          .stub()
          .callsFake((key) => ({ email: 'test@example.com', status: 'gift' })[key]);

        await buildRepo({ purchaseLinks }).update(
          { products: [], status: 'free' },
          { id: 'member_1' },
        );

        const payload = memberEdit.firstCall.args[0];
        assert.equal(payload.status, 'free');
        assert.deepEqual(payload.products, [{ id: 'course', expiry_at: null }]);
        sinon.assert.notCalled(MemberProductEvent.add);
      });

      it('leaves a gift member alone when no status is requested', async function () {
        existingProducts = [{ id: 'course' }];
        const initialMember = await Member.findOne();
        initialMember.get = sinon
          .stub()
          .callsFake((key) => ({ email: 'test@example.com', status: 'gift' })[key]);

        await buildRepo({ purchaseLinks }).update({ products: [] }, { id: 'member_1' });

        assert.equal(memberEdit.firstCall.args[0].status, undefined);
      });

      it('re-attaches the purchase when Stripe is not configured', async function () {
        stripeAPIService = { configured: false };
        existingProducts = [{ id: 'course' }];

        await buildRepo({ purchaseLinks }).update({ products: [] }, { id: 'member_1' });

        const payload = memberEdit.firstCall.args[0];
        assert.equal(payload.status, undefined);
        assert.deepEqual(payload.products, [{ id: 'course', expiry_at: null }]);
        sinon.assert.notCalled(MemberProductEvent.add);
      });

      it('forces the purchase expiry when the purchased tier is comped with an expiry', async function () {
        existingProducts = [{ id: 'course' }];

        await buildRepo({ purchaseLinks }).update(
          { products: [{ id: 'course', expiry_at: '2027-01-01T00:00:00.000Z' }] },
          { id: 'member_1' },
        );

        const payload = memberEdit.firstCall.args[0];
        assert.equal(payload.status, undefined);
        assert.deepEqual(payload.products, [{ id: 'course', expiry_at: null }]);
        sinon.assert.notCalled(MemberProductEvent.add);
      });

      it('does not read purchases when products are not being updated', async function () {
        await buildRepo({ purchaseLinks }).update({ name: 'New name' }, { id: 'member_1' });

        sinon.assert.notCalled(purchaseLinks.getPurchaseSourcedProducts);
        assert.equal(memberEdit.firstCall.args[0].products, undefined);
      });

      it('passes the transaction to the purchase read', async function () {
        existingProducts = [{ id: 'course' }];

        await buildRepo({ purchaseLinks }).update(
          { products: [{ id: 'course' }] },
          { id: 'member_1', transacting: trx },
        );

        sinon.assert.calledWith(purchaseLinks.getPurchaseSourcedProducts, 'member_1', {
          transacting: trx,
        });
      });
    });

    describe('removeComplimentarySubscription', function () {
      let member;
      let products;

      beforeEach(function () {
        products = [];
        member = {
          id: 'member_1',
          load: sinon.stub().resolves(),
          related: sinon.stub().callsFake((relation) => ({
            fetch: sinon.stub().resolves({ models: [] }),
            models: [],
            toJSON: () => (relation === 'products' ? products : []),
          })),
        };
        Member = {
          transaction: sinon.stub().callsFake((callback) => callback(trx)),
          findOne: sinon.stub().resolves(member),
          edit: sinon.stub().resolves(),
        };
        stripeAPIService = { configured: true };
      });

      it('locks the member and edits in one transaction so a concurrent grant cannot be detached', async function () {
        purchased({ id: 'course', expiry_at: null });
        products = [
          { id: 'course', expiry_at: null },
          { id: 'comp', expiry_at: '2026-12-01T00:00:00.000Z' },
        ];

        await buildRepo({ purchaseLinks }).removeComplimentarySubscription({ id: 'member_1' });

        sinon.assert.calledOnce(Member.transaction);
        sinon.assert.calledWith(
          Member.findOne,
          { id: 'member_1' },
          { transacting: trx, forUpdate: true },
        );
        const lockCall = Member.findOne.getCalls().find((call) => call.args[1]?.forUpdate === true);
        assert.ok(lockCall.calledBefore(member.load.firstCall));
        assert.equal(member.load.firstCall.args[1].transacting, trx);
        sinon.assert.calledWith(purchaseLinks.getPurchaseSourcedProducts, 'member_1', {
          transacting: trx,
        });
        assert.deepEqual(Member.edit.firstCall.args[1], { id: 'member_1', transacting: trx });
      });

      it('uses the caller transaction when one is passed', async function () {
        const callerTrx = { executionPromise: Promise.resolve(), caller: true };
        products = [{ id: 'comp', expiry_at: null }];

        await buildRepo({ purchaseLinks }).removeComplimentarySubscription(
          { id: 'member_1' },
          { transacting: callerTrx },
        );

        sinon.assert.notCalled(Member.transaction);
        sinon.assert.calledWith(
          Member.findOne,
          { id: 'member_1' },
          { transacting: callerTrx, forUpdate: true },
        );
        assert.deepEqual(Member.edit.firstCall.args[1], {
          id: 'member_1',
          transacting: callerTrx,
        });
      });

      it('keeps the purchase-sourced link and drops the unbacked comp', async function () {
        purchased({ id: 'course', expiry_at: null });
        products = [
          { id: 'course', expiry_at: null },
          { id: 'comp', expiry_at: '2026-12-01T00:00:00.000Z' },
        ];

        await buildRepo({ purchaseLinks }).removeComplimentarySubscription({ id: 'member_1' }, {});

        sinon.assert.calledOnce(Member.edit);
        assert.deepEqual(Member.edit.firstCall.args[0], {
          products: [{ id: 'course', expiry_at: null }],
        });
        // purchases are read after the products are loaded
        sinon.assert.callOrder(member.load, purchaseLinks.getPurchaseSourcedProducts);
      });

      it('does not edit when only the purchase-sourced link remains', async function () {
        purchased({ id: 'course', expiry_at: null });
        products = [{ id: 'course', expiry_at: null }];

        await buildRepo({ purchaseLinks }).removeComplimentarySubscription({ id: 'member_1' }, {});

        sinon.assert.notCalled(Member.edit);
      });
    });

    describe('grantPurchasedProduct', function () {
      let member;
      let products;
      let subscriptions;
      let status;

      const subscriptionFor = (productId, subStatus = 'active') => ({
        get: sinon.stub().withArgs('status').returns(subStatus),
        related: () => ({
          related: () => ({ get: sinon.stub().withArgs('product_id').returns(productId) }),
        }),
      });

      beforeEach(function () {
        products = [];
        subscriptions = [];
        status = 'free';
        member = {
          id: 'member_1',
          get: sinon.stub().callsFake((key) => ({ status })[key]),
          related: sinon.stub().callsFake((relation) => {
            if (relation === 'products') {
              return { toJSON: () => products };
            }
            if (relation === 'stripeSubscriptions') {
              return { models: subscriptions };
            }
            return { models: [] };
          }),
        };
        Member = {
          transaction: sinon.stub().callsFake((callback) => callback(trx)),
          findOne: sinon.stub().resolves(member),
          edit: sinon.stub().resolves({ id: 'member_1' }),
        };
      });

      it('adds a new link, keeping the other links and their expiry_at, without a status change', async function () {
        products = [{ id: 'comp', name: 'Comp', expiry_at: '2026-12-01T00:00:00.000Z' }];
        status = 'comped';

        const result = await buildRepo({ purchaseLinks }).grantPurchasedProduct(
          { memberId: 'member_1', productId: 'course', expiresAt: null },
          { transacting: trx },
        );

        assert.deepEqual(result, { id: 'member_1' });
        sinon.assert.calledOnce(Member.findOne);
        const findOptions = Member.findOne.firstCall.args[1];
        assert.equal(findOptions.transacting, trx);
        assert.equal(findOptions.forUpdate, true);
        assert.equal(findOptions.require, false);

        sinon.assert.calledOnce(Member.edit);
        assert.deepEqual(Member.edit.firstCall.args[0], {
          products: [
            { id: 'comp', name: 'Comp', expiry_at: '2026-12-01T00:00:00.000Z' },
            { id: 'course', expiry_at: null },
          ],
        });
        assert.equal(Member.edit.firstCall.args[1].id, 'member_1');
        assert.equal(Member.edit.firstCall.args[1].transacting, trx);

        sinon.assert.calledOnceWithExactly(
          MemberProductEvent.add,
          { member_id: 'member_1', product_id: 'course', action: 'added' },
          { transacting: trx },
        );
        sinon.assert.notCalled(MemberStatusEvent.add);
      });

      it('opens its own transaction when none is passed', async function () {
        await buildRepo({ purchaseLinks }).grantPurchasedProduct({
          memberId: 'member_1',
          productId: 'course',
        });

        sinon.assert.calledOnce(Member.transaction);
        assert.equal(Member.findOne.firstCall.args[1].transacting, trx);
        assert.deepEqual(Member.edit.firstCall.args[0], {
          products: [{ id: 'course', expiry_at: null }],
        });
      });

      it('is a no-op when the product is already linked with the same expiry', async function () {
        products = [{ id: 'course', expiry_at: null }];

        const result = await buildRepo({ purchaseLinks }).grantPurchasedProduct(
          { memberId: 'member_1', productId: 'course', expiresAt: null },
          { transacting: trx },
        );

        assert.equal(result, member);
        sinon.assert.notCalled(Member.edit);
        sinon.assert.notCalled(MemberProductEvent.add);
        sinon.assert.notCalled(MemberStatusEvent.add);
      });

      it('resets an inherited comp expiry to the purchase expiry without an event', async function () {
        status = 'paid';
        subscriptions = [{ get: sinon.stub().withArgs('status').returns('active') }];
        products = [
          { id: 'library', expiry_at: null },
          { id: 'course', expiry_at: '2026-12-01T00:00:00.000Z' },
        ];

        await buildRepo({ purchaseLinks }).grantPurchasedProduct(
          { memberId: 'member_1', productId: 'course', expiresAt: null },
          { transacting: trx },
        );

        assert.deepEqual(Member.edit.firstCall.args[0], {
          products: [
            { id: 'library', expiry_at: null },
            { id: 'course', expiry_at: null },
          ],
        });
        sinon.assert.notCalled(MemberProductEvent.add);
        sinon.assert.notCalled(MemberStatusEvent.add);
      });

      it('A5: a member comped only on the purchased tier becomes free', async function () {
        status = 'comped';
        products = [{ id: 'course', expiry_at: '2026-12-01T00:00:00.000Z' }];

        await buildRepo({ purchaseLinks }).grantPurchasedProduct(
          { memberId: 'member_1', productId: 'course', expiresAt: null },
          { transacting: trx },
        );

        assert.deepEqual(Member.edit.firstCall.args[0], {
          products: [{ id: 'course', expiry_at: null }],
          status: 'free',
        });
        sinon.assert.notCalled(MemberProductEvent.add);
        sinon.assert.calledOnceWithExactly(
          MemberStatusEvent.add,
          { member_id: 'member_1', from_status: 'comped', to_status: 'free' },
          { transacting: trx },
        );
      });

      it('A5: also applies when the comp on the purchased tier had no expiry', async function () {
        status = 'comped';
        products = [{ id: 'course', expiry_at: null }];

        await buildRepo({ purchaseLinks }).grantPurchasedProduct(
          { memberId: 'member_1', productId: 'course', expiresAt: null },
          { transacting: trx },
        );

        assert.deepEqual(Member.edit.firstCall.args[0], {
          products: [{ id: 'course', expiry_at: null }],
          status: 'free',
        });
        sinon.assert.calledOnce(MemberStatusEvent.add);
      });

      it('A5: other purchase-sourced links do not keep the member comped', async function () {
        status = 'comped';
        purchased({ id: 'other_course', expiry_at: null });
        products = [
          { id: 'other_course', expiry_at: null },
          { id: 'course', expiry_at: '2026-12-01T00:00:00.000Z' },
        ];

        await buildRepo({ purchaseLinks }).grantPurchasedProduct(
          { memberId: 'member_1', productId: 'course', expiresAt: null },
          { transacting: trx },
        );

        assert.equal(Member.edit.firstCall.args[0].status, 'free');
        sinon.assert.calledWith(purchaseLinks.getPurchaseSourcedProducts, 'member_1', {
          transacting: trx,
        });
      });

      it('A5: stays comped while another comp link remains', async function () {
        status = 'comped';
        products = [
          { id: 'comp', expiry_at: null },
          { id: 'course', expiry_at: '2026-12-01T00:00:00.000Z' },
        ];

        await buildRepo({ purchaseLinks }).grantPurchasedProduct(
          { memberId: 'member_1', productId: 'course', expiresAt: null },
          { transacting: trx },
        );

        assert.deepEqual(Member.edit.firstCall.args[0], {
          products: [
            { id: 'comp', expiry_at: null },
            { id: 'course', expiry_at: null },
          ],
        });
        sinon.assert.notCalled(MemberStatusEvent.add);
      });

      it('A5: stays comped when an active (complimentary) subscription exists', async function () {
        status = 'comped';
        subscriptions = [{ get: sinon.stub().withArgs('status').returns('active') }];
        products = [{ id: 'course', expiry_at: '2026-12-01T00:00:00.000Z' }];

        await buildRepo({ purchaseLinks }).grantPurchasedProduct(
          { memberId: 'member_1', productId: 'course', expiresAt: null },
          { transacting: trx },
        );

        assert.equal(Member.edit.firstCall.args[0].status, undefined);
        sinon.assert.notCalled(MemberStatusEvent.add);
      });

      it('A5: leaves gift status alone', async function () {
        status = 'gift';
        products = [{ id: 'course', expiry_at: '2026-12-01T00:00:00.000Z' }];

        await buildRepo({ purchaseLinks }).grantPurchasedProduct(
          { memberId: 'member_1', productId: 'course', expiresAt: null },
          { transacting: trx },
        );

        assert.equal(Member.edit.firstCall.args[0].status, undefined);
        sinon.assert.notCalled(MemberStatusEvent.add);
      });

      it('A5: a new link never changes a comped member status', async function () {
        status = 'comped';
        products = [{ id: 'comp', expiry_at: null }];

        await buildRepo({ purchaseLinks }).grantPurchasedProduct(
          { memberId: 'member_1', productId: 'course', expiresAt: null },
          { transacting: trx },
        );

        assert.equal(Member.edit.firstCall.args[0].status, undefined);
        sinon.assert.notCalled(purchaseLinks.getPurchaseSourcedProducts);
      });

      it('dates the added event with grantedAt (a backdated grant)', async function () {
        const grantedAt = new Date('2025-06-01T07:30:00.000Z');

        await buildRepo({ purchaseLinks }).grantPurchasedProduct(
          { memberId: 'member_1', productId: 'course', expiresAt: null, grantedAt },
          { transacting: trx, requireNewLink: true, rejectCompLink: true },
        );

        sinon.assert.calledOnceWithExactly(
          MemberProductEvent.add,
          { member_id: 'member_1', product_id: 'course', action: 'added', created_at: grantedAt },
          { transacting: trx },
        );
        // The guard options are not passed on to the model layer.
        const findOptions = Member.findOne.firstCall.args[1];
        assert.equal('requireNewLink' in findOptions, false);
        assert.equal('rejectCompLink' in findOptions, false);
        assert.equal('requireNewLink' in Member.edit.firstCall.args[1], false);
      });

      it('keeps the guard options when it opens its own transaction', async function () {
        products = [{ id: 'course', expiry_at: null }];
        subscriptions = [subscriptionFor('course')];

        await assert.rejects(
          buildRepo({ purchaseLinks }).grantPurchasedProduct(
            { memberId: 'member_1', productId: 'course' },
            { requireNewLink: true },
          ),
          { code: 'PURCHASE_BACKDATE_LINK_EXISTS' },
        );
        sinon.assert.calledOnce(Member.transaction);
      });

      it('requireNewLink: refuses when any link to the tier exists', async function () {
        status = 'paid';
        products = [{ id: 'course', expiry_at: null }];
        subscriptions = [subscriptionFor('course')];

        await assert.rejects(
          buildRepo({ purchaseLinks }).grantPurchasedProduct(
            {
              memberId: 'member_1',
              productId: 'course',
              grantedAt: new Date('2025-01-01T00:00:00.000Z'),
            },
            { transacting: trx, requireNewLink: true, rejectCompLink: true },
          ),
          (err) => {
            assert.ok(err instanceof errors.ValidationError);
            assert.equal(err.code, 'PURCHASE_BACKDATE_LINK_EXISTS');
            assert.equal(err.property, 'created_at');
            assert.equal(
              err.message,
              "Member already has access to this tier, so access can't be backdated.",
            );
            return true;
          },
        );
        sinon.assert.notCalled(Member.edit);
        sinon.assert.notCalled(MemberProductEvent.add);
      });

      it('requireNewLink: allows a tier the member does not hold', async function () {
        products = [{ id: 'other', expiry_at: null }];

        await buildRepo({ purchaseLinks }).grantPurchasedProduct(
          { memberId: 'member_1', productId: 'course' },
          { transacting: trx, requireNewLink: true },
        );

        sinon.assert.calledOnce(Member.edit);
      });

      it('rejectCompLink: refuses a comp link on the tier and leaves it untouched', async function () {
        status = 'comped';
        products = [{ id: 'course', expiry_at: '2026-12-01T00:00:00.000Z' }];

        await assert.rejects(
          buildRepo({ purchaseLinks }).grantPurchasedProduct(
            { memberId: 'member_1', productId: 'course' },
            { transacting: trx, rejectCompLink: true },
          ),
          (err) => {
            assert.ok(err instanceof errors.ValidationError);
            assert.equal(err.code, 'PURCHASE_COMP_EXISTS');
            assert.equal(err.property, 'tier_id');
            return true;
          },
        );
        assert.deepEqual(Member.findOne.firstCall.args[1].withRelated, [
          'products',
          'stripeSubscriptions',
          'stripeSubscriptions.stripePrice',
          'stripeSubscriptions.stripePrice.stripeProduct',
        ]);
        sinon.assert.notCalled(Member.edit);
        sinon.assert.notCalled(MemberStatusEvent.add);
      });

      it('rejectCompLink: refuses a gift link, and is checked before requireNewLink', async function () {
        status = 'gift';
        products = [{ id: 'course', expiry_at: '2026-12-01T00:00:00.000Z' }];

        await assert.rejects(
          buildRepo({ purchaseLinks }).grantPurchasedProduct(
            { memberId: 'member_1', productId: 'course', grantedAt: new Date() },
            { transacting: trx, rejectCompLink: true, requireNewLink: true },
          ),
          { code: 'PURCHASE_COMP_EXISTS' },
        );
      });

      it('rejectCompLink: a comp on another tier, or an inactive subscription, does not back the link', async function () {
        status = 'paid';
        products = [{ id: 'course', expiry_at: null }];
        subscriptions = [subscriptionFor('library'), subscriptionFor('course', 'canceled')];

        await assert.rejects(
          buildRepo({ purchaseLinks }).grantPurchasedProduct(
            { memberId: 'member_1', productId: 'course' },
            { transacting: trx, rejectCompLink: true },
          ),
          { code: 'PURCHASE_COMP_EXISTS' },
        );
      });

      it('rejectCompLink: allows a link backed by an active subscription to the tier', async function () {
        status = 'paid';
        products = [{ id: 'course', expiry_at: null }];
        subscriptions = [subscriptionFor('course')];

        const result = await buildRepo({ purchaseLinks }).grantPurchasedProduct(
          { memberId: 'member_1', productId: 'course' },
          { transacting: trx, rejectCompLink: true },
        );

        assert.equal(result, member);
        sinon.assert.notCalled(Member.edit);
      });

      it('rejectCompLink: allows a purchase-sourced link (the caller re-checks ownership)', async function () {
        purchased({ id: 'course', expiry_at: null });
        products = [{ id: 'course', expiry_at: null }];

        await buildRepo({ purchaseLinks }).grantPurchasedProduct(
          { memberId: 'member_1', productId: 'course' },
          { transacting: trx, rejectCompLink: true },
        );

        sinon.assert.calledWith(purchaseLinks.getPurchaseSourcedProducts, 'member_1', {
          transacting: trx,
        });
        sinon.assert.notCalled(Member.edit);
      });

      it('rejectCompLink: a new link needs no purchase lookup', async function () {
        products = [{ id: 'comp', expiry_at: null }];
        status = 'comped';

        await buildRepo({ purchaseLinks }).grantPurchasedProduct(
          { memberId: 'member_1', productId: 'course' },
          { transacting: trx, rejectCompLink: true },
        );

        sinon.assert.notCalled(purchaseLinks.getPurchaseSourcedProducts);
        sinon.assert.calledOnce(MemberProductEvent.add);
        assert.equal('created_at' in MemberProductEvent.add.firstCall.args[0], false);
      });

      it('throws NotFoundError when the member does not exist', async function () {
        Member.findOne.resolves(null);

        await assert.rejects(
          buildRepo({ purchaseLinks }).grantPurchasedProduct(
            { memberId: 'missing', productId: 'course' },
            { transacting: trx },
          ),
          errors.NotFoundError,
        );
        sinon.assert.notCalled(Member.edit);
      });
    });

    describe('revokePurchasedProduct', function () {
      let member;
      let products;
      let subscriptions;
      let status;

      const subscriptionFor = (productId, subStatus = 'active') => ({
        get: sinon.stub().withArgs('status').returns(subStatus),
        related: () => ({
          related: () => ({ get: sinon.stub().withArgs('product_id').returns(productId) }),
        }),
      });

      beforeEach(function () {
        products = [];
        subscriptions = [];
        status = 'free';
        member = {
          id: 'member_1',
          get: sinon.stub().callsFake((key) => ({ status })[key]),
          related: sinon.stub().callsFake((relation) => {
            if (relation === 'products') {
              return { toJSON: () => products };
            }
            if (relation === 'stripeSubscriptions') {
              return { models: subscriptions };
            }
            return { models: [] };
          }),
        };
        Member = {
          transaction: sinon.stub().callsFake((callback) => callback(trx)),
          findOne: sinon.stub().resolves(member),
          edit: sinon.stub().resolves({ id: 'member_1' }),
        };
      });

      it('removes the link and writes a removed event', async function () {
        products = [
          { id: 'course', expiry_at: null },
          { id: 'other', expiry_at: '2026-12-01T00:00:00.000Z' },
        ];

        const result = await buildRepo({ purchaseLinks }).revokePurchasedProduct(
          { memberId: 'member_1', productId: 'course' },
          { transacting: trx },
        );

        assert.deepEqual(result, { id: 'member_1' });
        const findOptions = Member.findOne.firstCall.args[1];
        assert.equal(findOptions.transacting, trx);
        assert.equal(findOptions.forUpdate, true);
        assert.deepEqual(Member.edit.firstCall.args[0], {
          products: [{ id: 'other', expiry_at: '2026-12-01T00:00:00.000Z' }],
        });
        assert.equal(Member.edit.firstCall.args[1].id, 'member_1');
        assert.equal(Member.edit.firstCall.args[1].transacting, trx);
        sinon.assert.calledOnceWithExactly(
          MemberProductEvent.add,
          { member_id: 'member_1', product_id: 'course', action: 'removed' },
          { transacting: trx },
        );
        sinon.assert.notCalled(MemberStatusEvent.add);
      });

      it('opens its own transaction when none is passed', async function () {
        products = [{ id: 'course', expiry_at: null }];

        await buildRepo({ purchaseLinks }).revokePurchasedProduct({
          memberId: 'member_1',
          productId: 'course',
        });

        sinon.assert.calledOnce(Member.transaction);
        assert.equal(Member.findOne.firstCall.args[1].transacting, trx);
      });

      it('keeps the link while another paid purchase grants it', async function () {
        purchased({ id: 'course', expiry_at: null });
        products = [{ id: 'course', expiry_at: null }];

        await buildRepo({ purchaseLinks }).revokePurchasedProduct(
          { memberId: 'member_1', productId: 'course' },
          { transacting: trx },
        );

        sinon.assert.notCalled(Member.edit);
        sinon.assert.notCalled(MemberProductEvent.add);
      });

      it('keeps the link while an active subscription grants it', async function () {
        status = 'paid';
        subscriptions = [subscriptionFor('course')];
        products = [{ id: 'course', expiry_at: null }];

        await buildRepo({ purchaseLinks }).revokePurchasedProduct(
          { memberId: 'member_1', productId: 'course' },
          { transacting: trx },
        );

        sinon.assert.notCalled(Member.edit);
      });

      it('removes the link when only a cancelled subscription was for the product', async function () {
        subscriptions = [subscriptionFor('course', 'canceled')];
        products = [{ id: 'course', expiry_at: null }];

        await buildRepo({ purchaseLinks }).revokePurchasedProduct(
          { memberId: 'member_1', productId: 'course' },
          { transacting: trx },
        );

        assert.deepEqual(Member.edit.firstCall.args[0], { products: [] });
      });

      it('makes a comped member with nothing left free, with a status event', async function () {
        status = 'comped';
        products = [{ id: 'course', expiry_at: null }];

        await buildRepo({ purchaseLinks }).revokePurchasedProduct(
          { memberId: 'member_1', productId: 'course' },
          { transacting: trx },
        );

        assert.deepEqual(Member.edit.firstCall.args[0], { products: [], status: 'free' });
        sinon.assert.calledOnceWithExactly(
          MemberStatusEvent.add,
          { member_id: 'member_1', from_status: 'comped', to_status: 'free' },
          { transacting: trx },
        );
      });

      it('makes a comped member free when only other purchases remain', async function () {
        status = 'comped';
        purchased({ id: 'other_course', expiry_at: null });
        products = [
          { id: 'course', expiry_at: null },
          { id: 'other_course', expiry_at: null },
        ];

        await buildRepo({ purchaseLinks }).revokePurchasedProduct(
          { memberId: 'member_1', productId: 'course' },
          { transacting: trx },
        );

        assert.deepEqual(Member.edit.firstCall.args[0], {
          products: [{ id: 'other_course', expiry_at: null }],
          status: 'free',
        });
      });

      it('keeps a comped member comped while another comp remains', async function () {
        status = 'comped';
        products = [
          { id: 'course', expiry_at: null },
          { id: 'comp', expiry_at: null },
        ];

        await buildRepo({ purchaseLinks }).revokePurchasedProduct(
          { memberId: 'member_1', productId: 'course' },
          { transacting: trx },
        );

        assert.deepEqual(Member.edit.firstCall.args[0], {
          products: [{ id: 'comp', expiry_at: null }],
        });
        sinon.assert.notCalled(MemberStatusEvent.add);
      });

      it('leaves gift status alone', async function () {
        status = 'gift';
        products = [
          { id: 'course', expiry_at: null },
          { id: 'gift_tier', expiry_at: '2027-01-01T00:00:00.000Z' },
        ];

        await buildRepo({ purchaseLinks }).revokePurchasedProduct(
          { memberId: 'member_1', productId: 'course' },
          { transacting: trx },
        );

        assert.deepEqual(Member.edit.firstCall.args[0], {
          products: [{ id: 'gift_tier', expiry_at: '2027-01-01T00:00:00.000Z' }],
        });
        sinon.assert.notCalled(MemberStatusEvent.add);
      });

      it('keeps the link when the refunded tier is also the gift member gift tier', async function () {
        const warnStub = sinon.stub(logging, 'warn');
        status = 'gift';
        products = [{ id: 'course', expiry_at: null }];

        const result = await buildRepo({ purchaseLinks }).revokePurchasedProduct(
          { memberId: 'member_1', productId: 'course' },
          { transacting: trx },
        );

        assert.equal(result, member);
        sinon.assert.notCalled(Member.edit);
        sinon.assert.notCalled(MemberProductEvent.add);
        sinon.assert.notCalled(MemberStatusEvent.add);
        sinon.assert.calledWith(
          warnStub,
          sinon.match({ event: { name: 'purchase.refund_kept_gift_link' } }),
        );
      });

      it('logs a staff revoke that keeps the gift link as a revoke, not a refund', async function () {
        const warnStub = sinon.stub(logging, 'warn');
        status = 'gift';
        products = [{ id: 'course', expiry_at: null }];

        await buildRepo({ purchaseLinks }).revokePurchasedProduct(
          { memberId: 'member_1', productId: 'course', reason: 'revoke' },
          { transacting: trx },
        );

        sinon.assert.notCalled(Member.edit);
        sinon.assert.calledOnceWithExactly(
          warnStub,
          sinon.match({ event: { name: 'purchase.revoke_kept_gift_link' } }),
          sinon.match(/^Revoked purchase tier/),
        );
      });

      it('keeps the gift link when only other purchase links remain', async function () {
        status = 'gift';
        purchased({ id: 'other_course', expiry_at: null });
        products = [
          { id: 'course', expiry_at: null },
          { id: 'other_course', expiry_at: null },
        ];

        await buildRepo({ purchaseLinks }).revokePurchasedProduct(
          { memberId: 'member_1', productId: 'course' },
          { transacting: trx },
        );

        sinon.assert.notCalled(Member.edit);
      });

      it('does nothing when the product is not linked', async function () {
        products = [{ id: 'other', expiry_at: null }];

        const result = await buildRepo({ purchaseLinks }).revokePurchasedProduct(
          { memberId: 'member_1', productId: 'course' },
          { transacting: trx },
        );

        assert.equal(result, member);
        sinon.assert.notCalled(Member.edit);
        sinon.assert.notCalled(MemberProductEvent.add);
      });

      it('returns null when the member does not exist', async function () {
        Member.findOne.resolves(null);

        const result = await buildRepo({ purchaseLinks }).revokePurchasedProduct(
          { memberId: 'missing', productId: 'course' },
          { transacting: trx },
        );

        assert.equal(result, null);
        sinon.assert.notCalled(Member.edit);
      });
    });
  });
});
