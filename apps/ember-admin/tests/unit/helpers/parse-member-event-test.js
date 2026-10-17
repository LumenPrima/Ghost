import Service from '@ember/service';
import {describe, it} from 'mocha';
import {expect} from 'chai';
import {setupTest} from 'ember-mocha';

describe('Unit: Helper: parse-member-event', function () {
    setupTest();

    let helper;

    function buildEvent({type, data = {}} = {}) {
        return {
            type,
            data: {
                created_at: '2026-04-29T12:00:00Z',
                member: {id: 'member-1', name: 'Alice', email: 'alice@example.com'},
                ...data
            }
        };
    }

    beforeEach(function () {
        const MembersUtilsStub = Service.extend({
            paidMembersEnabled: true,
            hasMultipleTiers: false
        });
        this.owner.register('service:members-utils', MembersUtilsStub);

        helper = this.owner.factoryFor('helper:parse-member-event').create();
    });

    describe('subscription_event action', function () {
        it('returns "started paid subscription" for a created subscription_event', function () {
            const event = buildEvent({
                type: 'subscription_event',
                data: {type: 'created'}
            });
            const result = helper.compute([event]);
            expect(result.action).to.equal('started paid subscription');
        });
    });

    describe('automated_email_sent_event action', function () {
        it('returns the welcome email label for welcome automation slugs', function () {
            const event = buildEvent({
                type: 'automated_email_sent_event',
                data: {
                    automatedEmail: {
                        source: 'automated_email',
                        slug: 'member-welcome-email-paid',
                        name: 'Welcome Email (Paid)',
                        subject: 'Welcome to the paid tier'
                    }
                }
            });
            const result = helper.compute([event]);
            expect(result.action).to.equal('received welcome email (Paid)');
            expect(result.actionTitle).to.equal('received welcome email (Paid)');
            expect(result.info).to.equal(undefined);
            expect(result.description).to.equal(undefined);
        });

        it('returns the email subject inline for automation action revision rows', function () {
            const event = buildEvent({
                type: 'automated_email_sent_event',
                data: {
                    automatedEmail: {
                        source: 'automation_action_revision',
                        slug: 'member-welcome-email-free',
                        name: 'New member onboarding',
                        subject: 'Here is how to get started'
                    }
                }
            });
            const result = helper.compute([event]);
            expect(result.action).to.equal('received automated email: Here is how to get started');
            expect(result.actionTitle).to.equal('received automated email: Here is how to get started');
            expect(result.info).to.equal(undefined);
            expect(result.description).to.equal(undefined);
        });
    });

    describe('signup_event info', function () {
        it('returns null when created_with_status is "paid"', function () {
            const event = buildEvent({
                type: 'signup_event',
                data: {created_with_status: 'paid'}
            });
            const result = helper.compute([event]);
            expect(result.info).to.equal(null);
        });

        it('returns null when created_with_status is "comped"', function () {
            const event = buildEvent({
                type: 'signup_event',
                data: {created_with_status: 'comped'}
            });
            const result = helper.compute([event]);
            expect(result.info).to.equal(null);
        });

        it('returns "Free" when created_with_status is "free"', function () {
            const event = buildEvent({
                type: 'signup_event',
                data: {created_with_status: 'free'}
            });
            const result = helper.compute([event]);
            expect(result.info).to.equal('Free');
        });

        it('returns "Free" when created_with_status is null', function () {
            const event = buildEvent({
                type: 'signup_event',
                data: {created_with_status: null}
            });
            const result = helper.compute([event]);
            expect(result.info).to.equal('Free');
        });

        it('returns "Free" when created_with_status is missing', function () {
            const event = buildEvent({
                type: 'signup_event',
                data: {}
            });
            const result = helper.compute([event]);
            expect(result.info).to.equal('Free');
        });
    });

    describe('gift_redemption_event', function () {
        it('returns "started gift subscription" action', function () {
            const event = buildEvent({type: 'gift_redemption_event'});
            const result = helper.compute([event]);
            expect(result.action).to.equal('started gift subscription');
        });

        it('returns "event-gift" icon', function () {
            const event = buildEvent({type: 'gift_redemption_event'});
            const result = helper.compute([event]);
            expect(result.icon).to.equal('event-gift');
        });
    });

    describe('gift_ended_event', function () {
        it('returns "gift subscription expired" action', function () {
            const event = buildEvent({type: 'gift_ended_event'});
            const result = helper.compute([event]);
            expect(result.action).to.equal('gift subscription expired');
        });

        it('returns "event-gift" icon', function () {
            const event = buildEvent({type: 'gift_ended_event'});
            const result = helper.compute([event]);
            expect(result.icon).to.equal('event-gift');
        });
    });

    // fork(salvare): one-time tier purchases
    describe('purchase events', function () {
        it('names the tier and the amount of a paid purchase', function () {
            const event = buildEvent({
                type: 'purchase_event',
                data: {tier_name: 'Breaking Free', amount: 9900, currency: 'usd'}
            });
            const result = helper.compute([event]);
            expect(result.action).to.equal('Purchased Breaking Free for $99');
            expect(result.icon).to.equal('event-made-a-payment');
        });

        it('keeps the cents and thousands separators of a paid purchase, as the React feed does', function () {
            const cents = helper.compute([buildEvent({
                type: 'purchase_event',
                data: {tier_name: 'Breaking Free', amount: 1050, currency: 'usd'}
            })]);
            expect(cents.action).to.equal('Purchased Breaking Free for $10.50');

            const large = helper.compute([buildEvent({
                type: 'purchase_event',
                data: {tier_name: 'Breaking Free', amount: 125000, currency: 'eur'}
            })]);
            expect(large.action).to.equal('Purchased Breaking Free for €1,250');
        });

        it('reads a grant with no payment as granted access', function () {
            const event = buildEvent({
                type: 'purchase_event',
                data: {tier_name: 'Breaking Free', amount: 0, currency: 'usd'}
            });
            const result = helper.compute([event]);
            expect(result.action).to.equal('Granted access to Breaking Free');
        });

        it('names the tier of a refund and a revoke', function () {
            const refunded = helper.compute([buildEvent({type: 'purchase_refunded_event', data: {tier_name: 'Breaking Free'}})]);
            expect(refunded.action).to.equal('Purchase of Breaking Free refunded');
            expect(refunded.icon).to.equal('event-canceled-subscription');

            const revoked = helper.compute([buildEvent({type: 'purchase_revoked_event', data: {tier_name: 'Breaking Free'}})]);
            expect(revoked.action).to.equal('Access to Breaking Free revoked');
            expect(revoked.icon).to.equal('event-canceled-subscription');
        });

        it('falls back to a generic tier name when the tier was deleted', function () {
            const result = helper.compute([buildEvent({type: 'purchase_revoked_event', data: {tier_name: null}})]);
            expect(result.action).to.equal('Access to a tier revoked');
        });
    });
});
