// fork(salvare): the member Purchases panel and the comp-flow fixes for purchased tiers.
import { describe, expect, it } from 'vitest';
import { page, userEvent } from 'vitest/browser';

import {
  fakeAdminEndpoint,
  fakeMembers,
  member,
  renderAdminApp,
  salvareBootOverrides,
  settingsResponse,
  tier,
  type Member,
  type Tier,
} from '@test-utils/acceptance';
import { memberPurchasesScreen as screen } from './member-purchases.screen';
import type { MemberPurchase } from '@tryghost/admin-x-framework/api/member-purchases';

const course = tier({ name: 'Breaking Free', one_time_price: 9900, visibility: 'none' });
const yenCourse = tier({ name: 'Zen Course', currency: 'jpy', one_time_price: 5000 });
const library = tier({ name: 'Library' });

function memberTier(t: Tier) {
  return { id: t.id, name: t.name, slug: t.slug, active: t.active, type: t.type };
}

let purchaseSeq = 0;
function purchase(m: Member, t: Tier, overrides: Partial<MemberPurchase> = {}): MemberPurchase {
  purchaseSeq += 1;
  return {
    id: `6700000000000000000000${String(purchaseSeq).padStart(2, '0')}`,
    member_id: m.id,
    tier: { id: t.id, name: t.name, slug: t.slug },
    status: 'paid',
    source: 'manual',
    amount: 0,
    currency: 'usd',
    stripe_payment_intent_id: null,
    stripe_checkout_session_id: null,
    stripe_customer_id: null,
    expires_at: null,
    refunded_at: null,
    revoked_at: null,
    created_at: '2026-03-01T12:00:00.000Z',
    updated_at: '2026-03-01T12:00:00.000Z',
    ...overrides,
  };
}

function compRow(t: Tier) {
  return {
    id: '',
    customer: { id: '', name: null, email: '' },
    plan: { id: '', nickname: 'Complimentary', interval: 'year', currency: 'usd', amount: 0 },
    status: 'active',
    start_date: '2026-01-01T12:00:00.000Z',
    current_period_end: null,
    cancel_at_period_end: false,
    price: {
      id: '',
      price_id: '',
      nickname: 'Complimentary',
      amount: 0,
      currency: 'usd',
      type: 'recurring',
      interval: 'year',
    },
    tier: { ...memberTier(t), expiry_at: null },
    offer: null,
  };
}

/**
 * The member screen's request graph. The member GET regex stops at the query
 * so it can't swallow the purchases sub-resource.
 */
function fakeMemberWorld(
  m: Member,
  { tiers = [course, yenCourse, library], purchases = [] as MemberPurchase[] } = {},
) {
  fakeMembers([m], { tiers });
  const memberApi = fakeAdminEndpoint('GET', new RegExp(`^/members/${m.id}/(\\?|$)`), () => ({
    members: [m],
  }));
  fakeAdminEndpoint('GET', /^\/members\/events\//, {
    events: [],
    meta: { pagination: { page: 1, limit: 5, pages: 1, total: 0, next: null, prev: null } },
  });
  const purchasesApi = fakeAdminEndpoint('GET', `/members/${m.id}/purchases/`, () => ({
    member_purchases: purchases,
  }));
  return { memberApi, purchasesApi };
}

describe('Member purchases panel', () => {
  it('lists purchases with status, amount, source and access', async () => {
    const m = member({ name: 'Ada Lovelace', tiers: [memberTier(course)] });
    fakeMemberWorld(m, {
      purchases: [
        purchase(m, course, {
          source: 'stripe',
          amount: 9900,
          stripe_payment_intent_id: 'pi_123',
          stripe_checkout_session_id: 'cs_123',
          stripe_customer_id: 'cus_123',
        }),
        purchase(m, yenCourse, {
          status: 'refunded',
          source: 'stripe',
          amount: 5000,
          currency: 'jpy',
          refunded_at: '2026-04-02T12:00:00.000Z',
          stripe_payment_intent_id: 'pi_456',
          stripe_checkout_session_id: 'cs_456',
        }),
        purchase(m, library, { status: 'revoked', revoked_at: '2026-04-03T12:00:00.000Z' }),
      ],
    });

    await renderAdminApp(`/members/${m.id}`, { boot: salvareBootOverrides() });

    await expect.element(screen.heading()).toBeVisible();
    await expect(screen.rows()).toHaveCount(3);

    const paid = screen.row('Breaking Free');
    await expect.element(paid.getByTestId('member-purchase-status')).toHaveTextContent('Paid');
    await expect
      .element(paid.getByTestId('member-purchase-access'))
      .toHaveTextContent('Lifetime access');
    await expect
      .element(paid.getByTestId('member-purchase-details'))
      .toHaveTextContent('$99 · 1 Mar 2026 · Stripe');

    const refunded = screen.row('Zen Course');
    await expect
      .element(refunded.getByTestId('member-purchase-status'))
      .toHaveTextContent('Refunded');
    await expect
      .element(refunded.getByTestId('member-purchase-details'))
      .toHaveTextContent('¥5,000');
    await expect
      .element(refunded.getByTestId('member-purchase-access'))
      .toHaveTextContent('Refunded on 2 Apr 2026');

    const revoked = screen.row('Library');
    await expect
      .element(revoked.getByTestId('member-purchase-status'))
      .toHaveTextContent('Revoked');
    await expect
      .element(revoked.getByTestId('member-purchase-details'))
      .toHaveTextContent('1 Mar 2026 · Granted by staff');
    // A revoked staff grant has no Stripe ids and nothing left to revoke.
    await expect(revoked.getByRole('button', { name: 'Purchase menu' })).toHaveCount(0);

    await screen.menuButton('Breaking Free').click();
    await expect
      .element(screen.menuLink('View Stripe payment'))
      .toHaveAttribute('href', 'https://dashboard.stripe.com/payments/pi_123');
    await expect
      .element(screen.menuLink('View Stripe customer'))
      .toHaveAttribute('href', 'https://dashboard.stripe.com/customers/cus_123');
  });

  it('grants a purchase-only tier the member doesn’t hold, with the access email', async () => {
    const m = member({ name: 'Ada Lovelace', tiers: [memberTier(yenCourse)] });
    const { memberApi, purchasesApi } = fakeMemberWorld(m);
    const grantApi = fakeAdminEndpoint(
      'POST',
      new RegExp(`^/members/${m.id}/purchases/`),
      () => ({ member_purchases: [purchase(m, course)] }),
      { status: 201 },
    );

    await renderAdminApp(`/members/${m.id}`, { boot: salvareBootOverrides() });

    await expect.element(screen.section()).toHaveTextContent('No purchases');
    await screen.grantButton().click();
    await expect.element(screen.grantModal()).toBeVisible();

    await screen.grantTierSelect().click();
    // Only the course: the held course and the subscription tier are left out.
    await expect(screen.grantTierOptions()).toHaveCount(1);
    await screen.tierOption('Breaking Free').click();
    await screen.grantSendEmail().click();

    const purchaseReads = purchasesApi.requests.length;
    const memberReads = memberApi.requests.length;
    await screen.grantConfirmButton().click();

    await expect
      .poll(() => grantApi.lastRequest?.body)
      .toEqual({
        member_purchases: [{ tier_id: course.id }],
      });
    expect(new URL(grantApi.lastRequest!.url).searchParams.get('send_email')).toBe('true');
    await expect.element(screen.grantModal()).not.toBeInTheDocument();
    await expect.poll(() => purchasesApi.requests.length).toBeGreaterThan(purchaseReads);
    await expect.poll(() => memberApi.requests.length).toBeGreaterThan(memberReads);
  });

  it('shows the server’s refusal about the tier inline', async () => {
    const m = member({ name: 'Ada Lovelace' });
    fakeMemberWorld(m);
    const grantApi = fakeAdminEndpoint(
      'POST',
      new RegExp(`^/members/${m.id}/purchases/`),
      {
        errors: [
          {
            type: 'ValidationError',
            code: 'PURCHASE_COMP_EXISTS',
            property: 'tier_id',
            // As core sends it: a generic message, the service sentence in context.
            message: 'Validation error, cannot save member_purchase.',
            context: 'Member has a complimentary subscription to this tier. Remove it first.',
          },
        ],
      },
      { status: 422 },
    );

    await renderAdminApp(`/members/${m.id}`, { boot: salvareBootOverrides() });

    await screen.grantButton().click();
    await screen.grantTierSelect().click();
    await screen.tierOption('Breaking Free').click();
    await screen.grantConfirmButton().click();

    await expect
      .element(screen.grantTierError())
      .toHaveTextContent('Member has a complimentary subscription to this tier. Remove it first.');
    await expect.element(screen.grantModal()).toBeVisible();
    // No access email unless asked for.
    expect(new URL(grantApi.lastRequest!.url).searchParams.has('send_email')).toBe(false);
  });

  it('revokes a paid purchase after confirming', async () => {
    const m = member({ name: 'Ada Lovelace', tiers: [memberTier(course)] });
    const paid = purchase(m, course, {
      source: 'stripe',
      amount: 9900,
      stripe_payment_intent_id: 'pi_123',
      stripe_checkout_session_id: 'cs_123',
    });
    const { memberApi, purchasesApi } = fakeMemberWorld(m, { purchases: [paid] });
    const revokeApi = fakeAdminEndpoint('DELETE', `/members/${m.id}/purchases/${paid.id}/`, null, {
      status: 204,
    });

    await renderAdminApp(`/members/${m.id}`, { boot: salvareBootOverrides() });

    await screen.menuButton('Breaking Free').click();
    await screen.revokeMenuItem().click();
    await expect
      .element(screen.revokeDialog())
      .toHaveTextContent('Ada Lovelace will lose access to Breaking Free right away.');
    await expect
      .element(screen.revokeDialog())
      .toHaveTextContent('This doesn’t refund the payment in Stripe.');

    const purchaseReads = purchasesApi.requests.length;
    const memberReads = memberApi.requests.length;
    await screen.confirmRevokeButton().click();

    await expect.poll(() => revokeApi.requests.length).toBe(1);
    await expect.element(screen.revokeDialog()).not.toBeInTheDocument();
    await expect.poll(() => purchasesApi.requests.length).toBeGreaterThan(purchaseReads);
    await expect.poll(() => memberApi.requests.length).toBeGreaterThan(memberReads);
  });

  it('names the field-level reason when the tier changed after the modal opened', async () => {
    const m = member({ name: 'Ada Lovelace' });
    fakeMemberWorld(m);
    fakeAdminEndpoint(
      'POST',
      new RegExp(`^/members/${m.id}/purchases/`),
      {
        errors: [
          {
            type: 'ValidationError',
            code: null,
            property: 'tier_id',
            message: 'Validation error, cannot save member_purchase.',
            context: 'This tier is archived.',
          },
        ],
      },
      { status: 422 },
    );

    await renderAdminApp(`/members/${m.id}`, { boot: salvareBootOverrides() });

    await screen.grantButton().click();
    await screen.grantTierSelect().click();
    await screen.tierOption('Breaking Free').click();
    await screen.grantConfirmButton().click();

    await expect.element(screen.grantTierError()).toHaveTextContent('This tier is archived.');
  });

  it('says the member keeps the tier when another purchase still grants it', async () => {
    const m = member({ name: 'Ada Lovelace', tiers: [memberTier(course)] });
    // A duplicate checkout of the same course (purchase.possible_duplicate).
    const first = purchase(m, course, { source: 'stripe', amount: 9900 });
    const duplicate = purchase(m, course, { source: 'stripe', amount: 9900 });
    fakeMemberWorld(m, { purchases: [first, duplicate] });

    await renderAdminApp(`/members/${m.id}`, { boot: salvareBootOverrides() });

    await expect(screen.rows()).toHaveCount(2);
    await screen.menuButton('Breaking Free').first().click();
    await screen.revokeMenuItem().click();
    await expect
      .element(screen.revokeDialog())
      .toHaveTextContent(
        'Ada Lovelace keeps access to Breaking Free through another purchase or subscription.',
      );
    await expect(screen.revokeDialog().getByText(/will lose access/)).toHaveCount(0);
  });

  it('shows the server’s reason when a revoke fails', async () => {
    const m = member({ name: 'Ada Lovelace', tiers: [memberTier(course)] });
    const paid = purchase(m, course);
    fakeMemberWorld(m, { purchases: [paid] });
    fakeAdminEndpoint(
      'DELETE',
      `/members/${m.id}/purchases/${paid.id}/`,
      { errors: [{ type: 'NotFoundError', message: 'Purchase not found.', context: null }] },
      { status: 404 },
    );

    await renderAdminApp(`/members/${m.id}`, { boot: salvareBootOverrides() });

    await screen.menuButton('Breaking Free').click();
    await screen.revokeMenuItem().click();
    await screen.confirmRevokeButton().click();

    await expect.element(page.getByText('Couldn’t revoke access')).toBeVisible();
    await expect.element(page.getByText('Purchase not found.')).toBeVisible();
  });

  // Amendment C7: grants and revokes need no Stripe, so the panel ignores paid_members_enabled.
  it('renders the panel on a site without paid memberships', async () => {
    const m = member({ name: 'Ada Lovelace', status: 'free' });
    fakeMemberWorld(m);

    await renderAdminApp(`/members/${m.id}`, {
      boot: {
        ...salvareBootOverrides(),
        browseSettings: {
          response: settingsResponse({ settings: { paid_members_enabled: false } }),
        },
      },
    });

    await expect.element(screen.heading()).toBeVisible();
    await expect.element(screen.grantButton()).toBeVisible();
    await expect(screen.subscriptionsHeading()).toHaveCount(0);
  });

  it('a stock backend gets no panel and no purchases request', async () => {
    const m = member({ name: 'Ada Lovelace' });
    const { purchasesApi } = fakeMemberWorld(m);

    await renderAdminApp(`/members/${m.id}`);

    await expect.element(screen.subscriptionsHeading()).toBeVisible();
    await expect(screen.heading()).toHaveCount(0);
    expect(purchasesApi.requests).toHaveLength(0);
  });
});

describe('Comp flows for purchased tiers', () => {
  it('a free purchaser can be given a complimentary subscription', async () => {
    const m = member({ name: 'Ada Lovelace', status: 'free', tiers: [memberTier(course)] });
    fakeMemberWorld(m, { purchases: [purchase(m, course)] });

    await renderAdminApp(`/members/${m.id}`, { boot: salvareBootOverrides() });

    await expect.element(screen.addCompButton()).toBeVisible();
    await screen.addCompButton().click();
    await screen.compTierSelect().click();
    // The purchased course is left out: comping it would be a silent no-op.
    await expect(screen.tierOption('Breaking Free')).toHaveCount(0);
    await expect.element(screen.tierOption('Library')).toBeVisible();
    await userEvent.keyboard('{Escape}');
  });

  it('removing a comp sends only the tiers that have a subscription row', async () => {
    const m = member({
      name: 'Ada Lovelace',
      status: 'comped',
      tiers: [memberTier(library), memberTier(yenCourse), memberTier(course)],
      subscriptions: [compRow(library), compRow(yenCourse)],
    });
    fakeMemberWorld(m, { purchases: [purchase(m, course)] });
    const editApi = fakeAdminEndpoint('PUT', new RegExp(`^/members/${m.id}/`), () => ({
      members: [m],
    }));

    await renderAdminApp(`/members/${m.id}`, { boot: salvareBootOverrides() });

    await screen.subscriptionMenuButton('Library').click();
    await screen.removeCompMenuItem().click();
    await screen.confirmRemoveCompButton().click();

    await expect.poll(() => editApi.lastRequest?.body).toBeDefined();
    const sent = (editApi.lastRequest!.body as { members: Array<{ tiers: Array<{ id: string }> }> })
      .members[0].tiers;
    // The Library comp is removed; the purchased course is not sent back.
    expect(sent.map((t) => t.id)).toEqual([yenCourse.id]);
  });
});
