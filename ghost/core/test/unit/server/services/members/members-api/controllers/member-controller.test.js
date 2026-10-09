const sinon = require('sinon');
const MemberController = require('../../../../../../../core/server/services/members/members-api/controllers/member-controller');

describe('MemberController', function () {
  describe('updateSubscription', function () {
    it('Updates a subscriptions plan via the member repository if the Tier is active', async function () {
      const tokenService = {
        decodeToken: sinon.fake.resolves({ sub: 'fake@email.com' }),
      };
      const StripePrice = {
        findOne: sinon.fake.returns({
          id: 'plan_id',
          stripe_price_id: 'stripe_price_id',
          get: () => {
            return 'stripe_price_id';
          },
        }),
      };

      const memberRepository = {
        updateSubscription: sinon
          .mock('updateSubscription')
          .once()
          .withArgs({
            email: 'fake@email.com',
            subscription: {
              subscription_id: 'subscription_id',
              price: 'stripe_price_id',
            },
          }),
      };

      const tier = {
        id: 'whatever',
        status: 'active',
      };

      const price = {
        id: 'stripe_price_id',
      };

      const tiersService = {
        api: {
          read: sinon.fake.resolves(tier),
        },
      };

      const paymentsService = {
        getPriceForTierCadence: sinon.fake.resolves(price),
      };

      const productRepository = {
        get: sinon.fake.resolves({
          get() {
            return true;
          },
        }),
      };

      const controller = new MemberController({
        memberRepository,
        productRepository,
        tiersService,
        paymentsService,
        StripePrice,
        tokenService,
      });

      const req = {
        body: {
          identity: 'token',
          tierId: 'tier_id',
          cadence: 'yearly',
        },
        params: {
          id: 'subscription_id',
        },
      };
      const res = {
        writeHead() {},
        end() {},
      };

      await controller.updateSubscription(req, res);

      memberRepository.updateSubscription.verify();
    });

    it('Does not update a subscription plan via tierId/cadence branch if the Tier is not active', async function () {
      const tokenService = {
        decodeToken: sinon.fake.resolves({ sub: 'fake@email.com' }),
      };

      const memberRepository = {
        updateSubscription: sinon.mock('updateSubscription').never(),
      };

      const tier = {
        id: 'whatever',
        status: 'archived',
      };

      const tiersService = {
        api: {
          read: sinon.fake.resolves(tier),
        },
      };

      const controller = new MemberController({
        memberRepository,
        tiersService,
        tokenService,
      });

      const req = {
        body: {
          identity: 'token',
          tierId: 'tier_id',
          cadence: 'yearly',
        },
        params: {
          id: 'subscription_id',
        },
      };
      const res = {
        writeHead: sinon.fake(),
        end: sinon.fake(),
      };

      await controller.updateSubscription(req, res);

      memberRepository.updateSubscription.verify();
      sinon.assert.calledOnceWithExactly(res.writeHead, 403);
      sinon.assert.calledOnceWithExactly(res.end, 'Tier is archived.');
    });

    it('Does not update a subscription plan via tierId/cadence branch if the Tier is not found', async function () {
      const tokenService = {
        decodeToken: sinon.fake.resolves({ sub: 'fake@email.com' }),
      };

      const memberRepository = {
        updateSubscription: sinon.mock('updateSubscription').never(),
      };

      const tiersService = {
        api: {
          read: sinon.fake.resolves(undefined),
        },
      };

      const controller = new MemberController({
        memberRepository,
        tiersService,
        tokenService,
      });

      const req = {
        body: {
          identity: 'token',
          tierId: 'tier_id',
          cadence: 'yearly',
        },
        params: {
          id: 'subscription_id',
        },
      };
      const res = {
        writeHead: sinon.fake(),
        end: sinon.fake(),
      };

      await controller.updateSubscription(req, res);

      memberRepository.updateSubscription.verify();
      sinon.assert.calledOnceWithExactly(res.writeHead, 404);
      sinon.assert.calledOnceWithExactly(res.end, 'Not Found.');
    });

    it('Does not a subscriptions plan via the member repository if the Tier is not active', async function () {
      const tokenService = {
        decodeToken: sinon.fake.resolves({ sub: 'fake@email.com' }),
      };
      const StripePrice = {
        findOne: sinon.fake.returns({
          id: 'plan_id',
          stripe_price_id: 'stripe_price_id',
          get: () => {
            return 'stripe_price_id';
          },
        }),
      };

      const memberRepository = {
        updateSubscription: sinon.mock('updateSubscription').never(),
      };

      const productRepository = {
        get: sinon.fake.resolves({
          get() {
            return false;
          },
        }),
      };

      const controller = new MemberController({
        memberRepository,
        productRepository,
        StripePrice,
        tokenService,
      });

      const req = {
        body: {
          identity: 'token',
          priceId: 'plan_name',
        },
        params: {
          id: 'subscription_id',
        },
      };
      const res = {
        writeHead() {},
        end() {},
      };

      await controller.updateSubscription(req, res);

      memberRepository.updateSubscription.verify();
    });

    // fork(salvare): purchase-only tiers cannot be reached by changing a subscription's plan
    describe('purchase-only tiers', function () {
      const tokenService = {
        decodeToken: sinon.fake.resolves({ sub: 'fake@email.com' }),
      };

      const req = (body) => ({
        body: { identity: 'token', ...body },
        params: { id: 'subscription_id' },
      });

      const res = () => ({
        writeHead: sinon.fake(),
        end: sinon.fake(),
      });

      const priceBranchDeps = (productAttributes) => ({
        StripePrice: {
          findOne: sinon.fake.resolves({
            get: (key) => (key === 'stripe_price_id' ? 'stripe_price_id' : undefined),
          }),
        },
        productRepository: {
          get: sinon.fake.resolves({
            get: (key) => productAttributes[key],
          }),
        },
      });

      it('rejects a tierId/cadence change to a tier with a one-time price', async function () {
        const memberRepository = {
          updateSubscription: sinon.mock('updateSubscription').never(),
        };
        const paymentsService = {
          getPriceForTierCadence: sinon.fake.resolves({ id: 'stripe_price_id' }),
        };
        const controller = new MemberController({
          memberRepository,
          tiersService: {
            api: {
              read: sinon.fake.resolves({ id: 'course', status: 'active', oneTimePrice: 9900 }),
            },
          },
          paymentsService,
          tokenService,
        });
        const response = res();

        await controller.updateSubscription(req({ tierId: 'course', cadence: 'month' }), response);

        memberRepository.updateSubscription.verify();
        sinon.assert.notCalled(paymentsService.getPriceForTierCadence);
        sinon.assert.calledOnceWithExactly(response.writeHead, 403);
        sinon.assert.calledOnceWithExactly(
          response.end,
          'Tier is only available as a one-time purchase.',
        );
      });

      it('rejects a priceId change to a price whose tier has a one-time price', async function () {
        const memberRepository = {
          updateSubscription: sinon.mock('updateSubscription').never(),
        };
        const controller = new MemberController({
          memberRepository,
          ...priceBranchDeps({ active: true, one_time_price: 9900 }),
          tokenService,
        });
        const response = res();

        await controller.updateSubscription(req({ priceId: 'course_monthly' }), response);

        memberRepository.updateSubscription.verify();
        sinon.assert.calledOnceWithExactly(response.writeHead, 403);
        sinon.assert.calledOnceWithExactly(
          response.end,
          'Tier is only available as a one-time purchase.',
        );
      });

      it('still allows a priceId change to a tier without a one-time price', async function () {
        const memberRepository = {
          updateSubscription: sinon
            .mock('updateSubscription')
            .once()
            .withArgs({
              email: 'fake@email.com',
              subscription: {
                subscription_id: 'subscription_id',
                price: 'stripe_price_id',
              },
            }),
        };
        const controller = new MemberController({
          memberRepository,
          ...priceBranchDeps({ active: true, one_time_price: null }),
          tokenService,
        });
        const response = res();

        await controller.updateSubscription(req({ priceId: 'library_monthly' }), response);

        memberRepository.updateSubscription.verify();
        sinon.assert.calledOnceWithExactly(response.writeHead, 204);
      });
    });

    it('Updates a subscriptions cancel_at_period_end via the member repository', async function () {
      const tokenService = {
        decodeToken: sinon.fake.resolves({ sub: 'fake@email.com' }),
      };
      const stripePlansService = {
        getPlan: sinon.fake.returns({ id: 'plan_id' }),
      };

      const memberRepository = {
        updateSubscription: sinon
          .mock('updateSubscription')
          .once()
          .withArgs({
            email: 'fake@email.com',
            subscription: {
              subscription_id: 'subscription_id',
              cancellationReason: 'For reasonable reasons',
              cancel_at_period_end: true,
            },
          }),
      };

      const controller = new MemberController({
        memberRepository,
        stripePlansService,
        tokenService,
      });

      const req = {
        body: {
          identity: 'token',
          cancel_at_period_end: true,
          cancellation_reason: 'For reasonable reasons',
        },
        params: {
          id: 'subscription_id',
        },
      };
      const res = {
        writeHead() {},
        end() {},
      };

      await controller.updateSubscription(req, res);

      memberRepository.updateSubscription.verify();
    });

    describe('smart_cancel', function () {
      it('Updates a paid subscriptions cancel_at_period_end via the member repository', async function () {
        const tokenService = {
          decodeToken: sinon.fake.resolves({ sub: 'fake@email.com' }),
        };
        const stripePlansService = {
          getPlan: sinon.fake.returns({ id: 'plan_id' }),
        };

        const memberRepository = {
          updateSubscription: sinon
            .mock('updateSubscription')
            .once()
            .withArgs({
              email: 'fake@email.com',
              subscription: {
                subscription_id: 'subscription_id',
                cancellationReason: 'For reasonable reasons',
                cancel_at_period_end: true,
              },
            }),
          getSubscription: sinon.fake.resolves({
            status: 'active',
          }),
        };

        const controller = new MemberController({
          memberRepository,
          stripePlansService,
          tokenService,
        });

        const req = {
          body: {
            identity: 'token',
            smart_cancel: true,
            cancellation_reason: 'For reasonable reasons',
          },
          params: {
            id: 'subscription_id',
          },
        };
        const res = {
          writeHead() {},
          end() {},
        };

        await controller.updateSubscription(req, res);

        memberRepository.updateSubscription.verify();
      });

      it('Cancels an unpaid subscription via the member repository', async function () {
        const tokenService = {
          decodeToken: sinon.fake.resolves({ sub: 'fake@email.com' }),
        };
        const stripePlansService = {
          getPlan: sinon.fake.returns({ id: 'plan_id' }),
        };

        const memberRepository = {
          updateSubscription: sinon.fake(),
          cancelSubscription: sinon
            .mock('cancelSubscription')
            .once()
            .withArgs({
              email: 'fake@email.com',
              subscription: {
                subscription_id: 'subscription_id',
                cancellationReason: 'For reasonable reasons',
              },
            }),
          getSubscription: sinon.fake.resolves({
            status: 'unpaid',
          }),
        };

        const controller = new MemberController({
          memberRepository,
          stripePlansService,
          tokenService,
        });

        const req = {
          body: {
            identity: 'token',
            smart_cancel: true,
            cancellation_reason: 'For reasonable reasons',
          },
          params: {
            id: 'subscription_id',
          },
        };
        const res = {
          writeHead() {},
          end() {},
        };

        await controller.updateSubscription(req, res);

        memberRepository.cancelSubscription.verify();
      });
    });
  });
});
