const {
  agentProvider,
  mockManager,
  fixtureManager,
  matchers,
} = require('../../utils/e2e-framework');
const {
  anyEtag,
  anyErrorId,
  anyObjectId,
  anyContentLength,
  anyContentVersion,
  anyUuid,
  anyISODate,
  anyString,
  anyObject,
  anyNumber,
  anyISODateTime, // fork(salvare)
} = matchers;

const assert = require('node:assert/strict');
const moment = require('moment');
const sinon = require('sinon');
const logging = require('@tryghost/logging');
const db = require('../../../core/server/data/db'); // fork(salvare)
const { stripeMocker } = require('../../utils/e2e-framework-mock-manager'); // fork(salvare)
const purchaseHelpers = require('../../utils/purchase-helpers'); // fork(salvare)

let agent;

async function testPagination(skippedTypes, postId, totalExpected, limit) {
  const postFilter = postId ? `+data.post_id:'${postId}'` : '';

  // To make the test cover more edge cases, we test different limit configurations
  const { body: firstPage } = await agent
    .get(
      `/members/events?filter=${encodeURIComponent(`type:-[${skippedTypes.join(',')}]${postFilter}`)}&limit=${limit}`,
    )
    .expectStatus(200)
    .matchHeaderSnapshot({
      etag: anyEtag,
      'content-version': anyContentVersion,
      'content-length': anyContentLength, // Depending on random conditions (ID generation) the order of events can change
    })
    .matchBodySnapshot({
      events: new Array(limit).fill({
        type: anyString,
        data: anyObject,
      }),
    })
    .expect(({ body }) => {
      if (postId) {
        assert(
          !body.events.find(
            (e) =>
              (e.data?.post?.id ?? e.data?.attribution?.id ?? e.data?.email?.post_id) !== postId &&
              e.type !== 'aggregated_click_event',
          ),
          'Should only return events for the post',
        );
      }

      // Assert total is correct
      assert.equal(
        body.meta.pagination.total,
        totalExpected,
        'Expected total of ' + totalExpected + ' at limit ' + limit,
      );
    });
  let previousPage = firstPage;
  let page = 1;

  const allEvents = previousPage.events;

  while (allEvents.length < totalExpected && page < 50) {
    page += 1;

    // Calculate next page
    let lastId = previousPage.events[previousPage.events.length - 1].data.id;
    let lastCreatedAt = moment(
      previousPage.events[previousPage.events.length - 1].data.created_at,
    ).format('YYYY-MM-DD HH:mm:ss');

    const remaining = totalExpected - (page - 1) * limit;

    const { body: secondPage } = await agent
      .get(
        `/members/events?filter=${encodeURIComponent(`type:-[${skippedTypes.join(',')}]${postFilter}+(data.created_at:<'${lastCreatedAt}',(data.created_at:'${lastCreatedAt}'+id:<'${lastId}'))`)}&limit=${limit}`,
      )
      .expectStatus(200)
      .matchHeaderSnapshot({
        etag: anyEtag,
        'content-version': anyContentVersion,
        'content-length': anyContentLength, // Depending on random conditions (ID generation) the order of events can change
      })
      .matchBodySnapshot({
        events: new Array(Math.min(remaining, limit)).fill({
          type: anyString,
          data: anyObject,
        }),
      })
      .expect(({ body }) => {
        if (postId) {
          assert(
            !body.events.find(
              (e) =>
                (e.data?.post?.id ?? e.data?.attribution?.id ?? e.data?.email?.post_id) !==
                  postId && e.type !== 'aggregated_click_event',
            ),
            'Should only return events for the post',
          );
        }

        // Assert total is correct
        assert.equal(
          body.meta.pagination.total,
          remaining,
          'Expected total to be correct for page ' + page + ' with limit ' + limit,
        );
      });
    allEvents.push(...secondPage.events);
  }

  // Check if the ordering is correct and we didn't receive duplicate events
  assert.equal(allEvents.length, totalExpected, 'Total actually received should match the total');
  for (const event of allEvents) {
    // Check no other events have the same id
    assert.equal(allEvents.filter((e) => e.data.id === event.data.id).length, 1);
  }
}

describe('Activity Feed API', function () {
  beforeAll(async function () {
    agent = await agentProvider.getAdminAPIAgent();
    await fixtureManager.init(
      'posts',
      'newsletters',
      'members:newsletters',
      'comments',
      'redirects',
      'clicks',
      'feedback',
      'members:emails',
    );
    await agent.loginAsOwner();
  });

  beforeEach(function () {
    mockManager.mockMail();
  });

  afterEach(function () {
    mockManager.restore();
    sinon.restore();
  });

  describe('Filter splitting', function () {
    it('Can use NQL OR for type only', async function () {
      // Check activity feed
      await agent
        .get(`/members/events?filter=type:comment_event,type:click_event`)
        .expectStatus(200)
        .matchHeaderSnapshot({
          etag: anyEtag,
          'content-version': anyContentVersion,
        })
        .matchBodySnapshot({
          events: new Array(10).fill({
            type: anyString,
            data: anyObject,
          }),
        })
        .expect(({ body }) => {
          assert(
            !body.events.find((e) => e.type !== 'click_event' && e.type !== 'comment_event'),
            'Expected only click and comment events',
          );
        });
    });

    it('Cannot combine type filter with OR filter', async function () {
      // This query is not allowed because we need to split the filter in two AND filters
      const loggingStub = sinon.stub(logging, 'warn');
      await agent
        .get(`/members/events?filter=type:comment_event,data.post_id:123`)
        .expectStatus(400)
        .matchHeaderSnapshot({
          etag: anyEtag,
          'content-version': anyContentVersion,
        })
        .matchBodySnapshot({
          errors: [
            {
              id: anyErrorId,
            },
          ],
        });
      sinon.assert.calledOnce(loggingStub);
    });

    it('Can only combine type and other filters at the root level', async function () {
      const loggingStub = sinon.stub(logging, 'warn');
      await agent
        .get(
          `/members/events?filter=${encodeURIComponent('(type:comment_event+data.post_id:123)+data.post_id:123')}`,
        )
        .expectStatus(400)
        .matchHeaderSnapshot({
          etag: anyEtag,
          'content-version': anyContentVersion,
        })
        .matchBodySnapshot({
          errors: [
            {
              id: anyErrorId,
            },
          ],
        });
      sinon.assert.calledOnce(loggingStub);
    });

    it('Can use OR as long as it is not combined with type', async function () {
      const postId = fixtureManager.get('posts', 0).id;
      const memberId = fixtureManager.get('members', 0).id;

      await agent
        .get(
          `/members/events?filter=${encodeURIComponent(`data.post_id:'${postId}',data.member_id:'${memberId}'`)}`,
        )
        .expectStatus(200)
        .matchBodySnapshot({
          events: new Array(10).fill({
            type: anyString,
            data: anyObject,
          }),
        })
        .expect(({ body }) => {
          assert(
            !body.events.find(
              (e) =>
                (e.data?.post?.id ?? e.data?.attribution?.id ?? e.data?.email?.post_id) !==
                  postId && e.data?.member?.id !== memberId,
            ),
            'Expected only events either from the given post or member',
          );
        });
    });

    it('Can AND two ORs', async function () {
      const postId = fixtureManager.get('posts', 0).id;
      const memberId = fixtureManager.get('members', 0).id;

      await agent
        .get(
          `/members/events?filter=${encodeURIComponent(`(type:comment_event,type:click_event)+(data.post_id:'${postId}',data.member_id:'${memberId}')`)}`,
        )
        .expectStatus(200)
        .matchBodySnapshot({
          events: new Array(4).fill({
            type: anyString,
            data: anyObject,
          }),
        })
        .expect(({ body }) => {
          assert(
            !body.events.find((e) => e.type !== 'click_event' && e.type !== 'comment_event'),
            'Expected only click and comment events',
          );
          assert(
            !body.events.find(
              (e) =>
                (e.data?.post?.id ?? e.data?.attribution?.id ?? e.data?.email?.post_id) !==
                  postId && e.data?.member?.id !== memberId,
            ),
            'Expected only events either from the given post or member',
          );
        });
    });
  });

  describe('Filter-based pagination', function () {
    it('Can do filter based pagination for all posts', async function () {
      // There is an annoying restriction in the pagination. It doesn't work for mutliple email events at the same time because they have the same id (causes issues as we use id to deduplicate the created_at timestamp)
      // If that is ever fixed (it is difficult) we can update this test to not use a filter
      // Same for click_event and aggregated_click_event (use same id)
      const skippedTypes = [
        'email_opened_event',
        'email_failed_event',
        'email_delivered_event',
        'aggregated_click_event',
      ];
      await testPagination(skippedTypes, null, 40, 36);
    });

    it('Can do filter based pagination for one post', async function () {
      const postId = fixtureManager.get('posts', 0).id;

      // There is an annoying restriction in the pagination. It doesn't work for mutliple email events at the same time because they have the same id (causes issues as we use id to deduplicate the created_at timestamp)
      // If that is ever fixed (it is difficult) we can update this test to not use a filter
      // Same for click_event and aggregated_click_event (use same id)
      const skippedTypes = [
        'email_opened_event',
        'email_failed_event',
        'email_delivered_event',
        'aggregated_click_event',
      ];

      await testPagination(skippedTypes, postId, 12, 10);
    });

    it('Can do filter based pagination for aggregated clicks for one post', async function () {
      // Same as previous but with aggregated clicks instead of normal click events + email_delivered_events instead of sent events
      const postId = fixtureManager.get('posts', 0).id;
      const skippedTypes = [
        'email_opened_event',
        'email_failed_event',
        'email_sent_event',
        'click_event',
      ];

      await testPagination(skippedTypes, postId, 9, 8);
    });

    it('Can do filter based pagination for aggregated clicks for all posts', async function () {
      // Same as previous but with aggregated clicks instead of normal click events + email_delivered_events instead of sent events
      const skippedTypes = [
        'email_opened_event',
        'email_failed_event',
        'email_sent_event',
        'click_event',
      ];
      await testPagination(skippedTypes, null, 35, 32);
    });
  });

  // Activity feed
  it('Returns comments in activity feed', async function () {
    // Check activity feed
    await agent
      .get(`/members/events?filter=type:comment_event`)
      .expectStatus(200)
      .matchHeaderSnapshot({
        etag: anyEtag,
        'content-version': anyContentVersion,
      })
      .matchBodySnapshot({
        events: new Array(2).fill({
          type: anyString,
          data: anyObject,
        }),
      })
      .expect(({ body }) => {
        assert(
          body.events.find((e) => e.type === 'comment_event'),
          'Expected a comment event',
        );
        assert(
          !body.events.find((e) => e.type !== 'comment_event'),
          'Expected only comment events',
        );
      });
  });

  it('Returns click events in activity feed', async function () {
    // Check activity feed
    await agent
      .get(`/members/events?filter=type:click_event`)
      .expectStatus(200)
      .matchHeaderSnapshot({
        etag: anyEtag,
        'content-version': anyContentVersion,
      })
      .matchBodySnapshot({
        events: new Array(10).fill({
          type: anyString,
          data: {
            id: anyObjectId,
            created_at: anyISODate,
            member: {
              id: anyObjectId,
              uuid: anyUuid,
            },
            post: {
              id: anyObjectId,
              uuid: anyUuid,
              url: anyString,
            },
          },
        }),
      })
      .expect(({ body }) => {
        assert(
          body.events.find((e) => e.type === 'click_event'),
          'Expected a click event',
        );
        assert(!body.events.find((e) => e.type !== 'click_event'), 'Expected only click events');
      });
  });

  it('Returns feedback events in activity feed', async function () {
    // Check activity feed
    await agent
      .get(`/members/events?filter=type:feedback_event`)
      .expectStatus(200)
      .matchHeaderSnapshot({
        etag: anyEtag,
        'content-version': anyContentVersion,
      })
      .matchBodySnapshot({
        events: new Array(10).fill({
          type: anyString,
          data: {
            created_at: anyISODate,
            id: anyObjectId,
            member: {
              id: anyObjectId,
              uuid: anyUuid,
            },
            post: {
              id: anyObjectId,
              uuid: anyUuid,
              url: anyString,
            },
            score: anyNumber,
          },
        }),
      })
      .expect(({ body }) => {
        assert(
          body.events.find((e) => e.type === 'feedback_event'),
          'Expected a feedback event',
        );
        assert(
          !body.events.find((e) => e.type !== 'feedback_event'),
          'Expected only feedback events',
        );
      });
  });

  it('Returns aggregated_click events in activity feed', async function () {
    // Check activity feed
    await agent
      .get(`/members/events?filter=type:aggregated_click_event`)
      .expectStatus(200)
      .matchHeaderSnapshot({
        etag: anyEtag,
        'content-version': anyContentVersion,
      })
      .matchBodySnapshot({
        events: new Array(8).fill({
          type: 'aggregated_click_event',
          data: anyObject,
        }),
      })
      .expect(({ body }) => {
        assert(
          body.events.find((e) => e.type === 'aggregated_click_event'),
          'Expected a aggregated_click event',
        );
        assert(
          !body.events.find((e) => e.type !== 'aggregated_click_event'),
          'Expected only aggregated_click events',
        );
      });
  });

  it('Returns aggregated_click events in activity feed with post_id filter', async function () {
    const postId = fixtureManager.get('posts', 0).id;
    await agent
      .get(
        `/members/events?filter=type:aggregated_click_event${encodeURIComponent(`+data.post_id:'${postId}'`)}`,
      )
      .expectStatus(200)
      .matchHeaderSnapshot({
        etag: anyEtag,
        'content-version': anyContentVersion,
      })
      .matchBodySnapshot({
        events: new Array(1).fill({
          type: 'aggregated_click_event',
          data: anyObject,
        }),
      })
      .expect(({ body }) => {
        assert(
          body.events.find((e) => e.type === 'aggregated_click_event'),
          'Expected a aggregated_click event',
        );
        assert(
          !body.events.find((e) => e.type !== 'aggregated_click_event'),
          'Expected only aggregated_click events',
        );
      });
  });

  it('Returns signup events in activity feed', async function () {
    // Check activity feed
    await agent
      .get(`/members/events?filter=type:signup_event`)
      .expectStatus(200)
      .matchHeaderSnapshot({
        etag: anyEtag,
        'content-version': anyContentVersion,
      })
      .matchBodySnapshot({
        events: new Array(8).fill({
          type: anyString,
          data: anyObject,
        }),
      })
      .expect(({ body }) => {
        assert(
          body.events.find((e) => e.type === 'signup_event'),
          'Expected a signup event',
        );
        assert(!body.events.find((e) => e.type !== 'signup_event'), 'Expected only signup events');
      });
  });

  it('Returns email sent events in activity feed', async function () {
    // Check activity feed
    await agent
      .get(`/members/events?filter=type:email_sent_event`)
      .expectStatus(200)
      .matchHeaderSnapshot({
        etag: anyEtag,
        'content-version': anyContentVersion,
      })
      .matchBodySnapshot({
        events: new Array(4).fill({
          type: anyString,
          data: anyObject,
        }),
      })
      .expect(({ body }) => {
        assert(
          body.events.find((e) => e.type === 'email_sent_event'),
          'Expected an email sent event',
        );
        assert(
          !body.events.find((e) => e.type !== 'email_sent_event'),
          'Expected only email sent events',
        );
      });
  });

  it('Returns email delivered events in activity feed', async function () {
    // Check activity feed
    await agent
      .get(`/members/events?filter=type:email_delivered_event`)
      .expectStatus(200)
      .matchHeaderSnapshot({
        etag: anyEtag,
        'content-version': anyContentVersion,
      })
      .matchBodySnapshot({
        events: new Array(1).fill({
          type: anyString,
          data: anyObject,
        }),
      })
      .expect(({ body }) => {
        assert(
          body.events.find((e) => e.type === 'email_delivered_event'),
          'Expected an email delivered event',
        );
        assert(
          !body.events.find((e) => e.type !== 'email_delivered_event'),
          'Expected only email delivered events',
        );
      });
  });

  it('Returns email opened events in activity feed', async function () {
    // Check activity feed
    await agent
      .get(`/members/events?filter=type:email_opened_event`)
      .expectStatus(200)
      .matchHeaderSnapshot({
        etag: anyEtag,
        'content-version': anyContentVersion,
      })
      .matchBodySnapshot({
        events: new Array(1).fill({
          type: anyString,
          data: anyObject,
        }),
      })
      .expect(({ body }) => {
        assert(
          body.events.find((e) => e.type === 'email_opened_event'),
          'Expected an email opened event',
        );
        assert(
          !body.events.find((e) => e.type !== 'email_opened_event'),
          'Expected only email opened events',
        );
      });
  });

  it('Can filter events by post id', async function () {
    const postId = fixtureManager.get('posts', 0).id;

    await agent
      .get(`/members/events?filter=data.post_id:'${postId}'&limit=20`)
      .expectStatus(200)
      .matchHeaderSnapshot({
        etag: anyEtag,
        'content-version': anyContentVersion,
        'content-length': anyContentLength, // Depending on random conditions (ID generation) the order of events can change
      })
      .matchBodySnapshot({
        events: new Array(15).fill({
          type: anyString,
          data: anyObject,
        }),
      })
      .expect(({ body }) => {
        assert(
          !body.events.find(
            (e) =>
              (e.data?.post?.id ?? e.data?.attribution?.id ?? e.data?.email?.post_id) !== postId &&
              e.type !== 'aggregated_click_event',
          ),
          'Should only return events for the post',
        );

        // Check all post_id event types are covered by this test
        assert(
          body.events.find((e) => e.type === 'click_event'),
          'Expected a click event',
        );
        assert(
          body.events.find((e) => e.type === 'comment_event'),
          'Expected a comment event',
        );
        assert(
          body.events.find((e) => e.type === 'aggregated_click_event'),
          'Expected an aggregated click event',
        );
        assert(
          body.events.find((e) => e.type === 'feedback_event'),
          'Expected a feedback event',
        );
        assert(
          body.events.find((e) => e.type === 'signup_event'),
          'Expected a signup event',
        );
        assert(
          body.events.find((e) => e.type === 'subscription_event'),
          'Expected a subscription event',
        );
        assert(
          body.events.find((e) => e.type === 'email_delivered_event'),
          'Expected an email delivered event',
        );
        assert(
          body.events.find((e) => e.type === 'email_sent_event'),
          'Expected an email sent event',
        );
        assert(
          body.events.find((e) => e.type === 'email_opened_event'),
          'Expected an email opened event',
        );

        // Assert total is correct
        assert.equal(body.meta.pagination.total, 15);
      });
  });

  it('Can limit events', async function () {
    const postId = fixtureManager.get('posts', 0).id;
    await agent
      .get(`/members/events?filter=data.post_id:'${postId}'&limit=2`)
      .expectStatus(200)
      .matchHeaderSnapshot({
        etag: anyEtag,
        'content-version': anyContentVersion,
        'content-length': anyContentLength, // Depending on random conditions (ID generation) the order of events can change
      })
      .matchBodySnapshot({
        events: new Array(2).fill({
          type: anyString,
          data: anyObject,
        }),
      })
      .expect(({ body }) => {
        assert(
          !body.events.find(
            (e) =>
              (e.data?.post?.id ?? e.data?.attribution?.id ?? e.data?.email?.post_id) !== postId,
          ),
          'Should only return events for the post',
        );

        // Assert total is correct
        assert.equal(body.meta.pagination.total, 15);
      });
  });

  // fork(salvare): one-time purchases, staff grants, refunds and revokes. Runs last, so the
  // rows it adds don't change the totals the pagination tests above expect.
  describe('Purchase events', function () {
    const PURCHASE_TYPES = 'type:[purchase_event,purchase_refunded_event,purchase_revoked_event]';

    const purchaseEventMatcher = {
      type: anyString,
      data: {
        id: anyObjectId,
        member_id: anyObjectId,
        tier_id: anyObjectId,
        created_at: anyISODateTime,
        member: {
          id: anyObjectId,
          uuid: anyUuid,
        },
      },
    };

    let courseTier;

    async function createMember(email) {
      const { body } = await agent
        .post('/members/')
        .body({ members: [{ email }] })
        .expectStatus(201);
      return body.members[0];
    }

    // A paid checkout fulfilled through the webhook, without the members API: the
    // session only needs the server-set tier marker.
    async function purchaseByWebhook(email, { refundedBeforeFulfilment = false } = {}) {
      const n = purchaseHelpers.next();
      const paymentIntent = `pi_feed_${n}`;
      if (refundedBeforeFulfilment) {
        stripeMocker.getPaymentIntent(paymentIntent).charges.data[0].refunded = true;
      }
      const checkoutSession = {
        id: `cs_feed_${n}`,
        customer: null,
        metadata: { ghost_purchase_tier_id: courseTier.id },
      };
      await purchaseHelpers.sendWebhook(
        purchaseHelpers.buildCompletedEvent(checkoutSession, {
          email,
          customer: `cus_feed_${n}`,
          paymentIntent,
        }),
      );
      const [purchase] = await purchaseHelpers.getPurchases({
        stripe_checkout_session_id: checkoutSession.id,
      });
      return { purchase, paymentIntent };
    }

    // A backdated staff grant (as the Thinkific migration does), then its revoke
    async function grantAndRevoke(email) {
      const member = await createMember(email);
      const grantedAt = moment.utc().subtract(2, 'days').startOf('second');

      const { body } = await agent
        .post(`/members/${member.id}/purchases/`)
        .body({
          member_purchases: [{ tier_id: courseTier.id, created_at: grantedAt.toISOString() }],
        })
        .expectStatus(201);
      const purchaseId = body.member_purchases[0].id;

      await agent.delete(`/members/${member.id}/purchases/${purchaseId}/`).expectStatus(204);

      return { member, purchaseId, grantedAt };
    }

    // A Stripe purchase refunded an hour later, so the purchase is not mistaken for one
    // recorded already refunded (refunded_at equal to created_at)
    async function purchaseAndRefund(email) {
      const { purchase, paymentIntent } = await purchaseByWebhook(email);
      await db
        .knex('members_purchases')
        .where({ id: purchase.id })
        .update({ created_at: moment.utc().subtract(1, 'hour').format('YYYY-MM-DD HH:mm:ss') });

      await purchaseHelpers.sendRefund(paymentIntent);
      return purchase;
    }

    async function getPurchaseEvents(memberId, typeFilter = PURCHASE_TYPES) {
      const filter = `${typeFilter}+data.member_id:'${memberId}'`;
      const { body } = await agent
        .get(`/members/events?filter=${encodeURIComponent(filter)}`)
        .expectStatus(200);
      return body.events;
    }

    beforeEach(async function () {
      mockManager.mockStripe();
      if (!courseTier) {
        courseTier = await purchaseHelpers.createCourseTier(agent, { name: 'Feed Course' });
      }
    });

    it('Returns a staff grant and its revoke', async function () {
      // The feed lists a backdated grant at its backdated date
      const { member, purchaseId, grantedAt } = await grantAndRevoke('feed-grant@example.com');

      await agent
        .get(
          `/members/events?filter=${encodeURIComponent(`${PURCHASE_TYPES}+data.member_id:'${member.id}'`)}`,
        )
        .expectStatus(200)
        .matchHeaderSnapshot({
          etag: anyEtag,
          'content-version': anyContentVersion,
          'content-length': anyContentLength,
        })
        .matchBodySnapshot({
          events: new Array(2).fill(purchaseEventMatcher),
        })
        .expect(({ body: feed }) => {
          assert.deepEqual(
            feed.events.map((e) => e.type),
            ['purchase_revoked_event', 'purchase_event'],
          );
          for (const event of feed.events) {
            assert.equal(event.data.id, purchaseId);
            assert.equal(event.data.member_id, member.id);
            assert.equal(event.data.tier_id, courseTier.id);
            assert.equal(event.data.tier_name, 'Feed Course');
            assert.equal(event.data.amount, 0);
            assert.equal(event.data.source, 'manual');
            assert.equal(event.data.member.email, 'feed-grant@example.com');
          }
          assert.equal(feed.events[1].data.created_at, grantedAt.toISOString());
          assert.equal(feed.meta.pagination.total, 2);
        });
    });

    it('Returns a Stripe purchase and its refund', async function () {
      const purchase = await purchaseAndRefund('feed-refund@example.com');

      const events = await getPurchaseEvents(purchase.member_id);

      assert.deepEqual(
        events.map((e) => e.type),
        ['purchase_refunded_event', 'purchase_event'],
      );
      for (const event of events) {
        assert.equal(event.data.id, purchase.id);
        assert.equal(event.data.amount, purchaseHelpers.COURSE_PRICE);
        assert.equal(event.data.currency, 'usd');
        assert.equal(event.data.source, 'stripe');
      }
    });

    it('Leaves out the purchase event of a payment refunded before fulfilment', async function () {
      const member = await createMember('feed-prerefunded@example.com');
      const { purchase } = await purchaseByWebhook('feed-prerefunded@example.com', {
        refundedBeforeFulfilment: true,
      });

      assert.equal(purchase.status, 'refunded');
      assert.equal(purchase.member_id, member.id);

      const events = await getPurchaseEvents(member.id);

      assert.deepEqual(
        events.map((e) => e.type),
        ['purchase_refunded_event'],
      );
    });

    it('Can exclude purchase events by type', async function () {
      const purchase = await purchaseAndRefund('feed-exclude@example.com');

      const events = await getPurchaseEvents(purchase.member_id, 'type:-purchase_event');

      assert.ok(!events.some((e) => e.type === 'purchase_event'));
      assert.ok(events.some((e) => e.type === 'purchase_refunded_event'));
    });

    it('Passes an id cursor filter through to the purchase lists', async function () {
      const { purchaseId } = await grantAndRevoke('feed-cursor@example.com');
      const [purchase] = await purchaseHelpers.getPurchases({ id: purchaseId });

      const above = await getPurchaseEvents(
        purchase.member_id,
        `type:purchase_event+id:<'ffffffffffffffffffffffff'`,
      );
      assert.deepEqual(
        above.map((e) => e.data.id),
        [purchase.id],
      );

      const below = await getPurchaseEvents(
        purchase.member_id,
        `type:purchase_event+id:<'${purchase.id}'`,
      );
      assert.deepEqual(below, []);
    });
  });
});
