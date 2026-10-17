// fork(salvare): the tier editor's one-time pricing mode and the screens that list tiers.
import { describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';

import {
  fakeAdminEndpoint,
  fakeMemberCustomFields,
  fakeSettingsScreens,
  fakeTiers,
  renderAdminApp,
  salvareBootOverrides,
  settingsResponse,
  tier,
} from '@test-utils/acceptance';
import { settingsScreen } from '@/settings/settings.screen';

const freeTier = tier({ id: '645453f4d254799990dd0e21', name: 'Free', slug: 'free', type: 'free' });
const supporterTier = tier({
  id: '645453f4d254799990dd0e22',
  name: 'Basic Supporter',
  slug: 'basic-supporter',
  currency: 'usd',
  monthly_price: 500,
  yearly_price: 5000,
});
const courseTier = tier({
  id: '645453f4d254799990dd0e23',
  name: 'Breaking Free',
  slug: 'breaking-free',
  currency: 'usd',
  monthly_price: 500,
  yearly_price: 5000,
  one_time_price: 9900,
  visibility: 'none',
});

type TierBody = { tiers: Record<string, unknown>[] };

function stripeSettings() {
  return settingsResponse({
    settings: {
      stripe_connect_display_name: 'Dummy',
      stripe_connect_livemode: false,
      stripe_connect_account_id: 'acct_123',
      stripe_connect_publishable_key: 'pk_test_123',
      stripe_connect_secret_key: 'sk_test_123',
    },
  });
}

async function renderSettings({ salvare = true, labs = {} } = {}) {
  await renderAdminApp('/settings', {
    labs,
    boot: {
      ...(salvare ? salvareBootOverrides() : {}),
      browseSettings: { response: stripeSettings() },
    },
  });
}

describe('Tier one-time pricing', () => {
  it('creates a purchase-only tier without validating the hidden recurring prices', async () => {
    const created = tier({
      ...courseTier,
      id: 'new-course',
      name: 'New course',
      slug: 'new-course',
    });
    let saved = false;
    fakeSettingsScreens();
    fakeTiers(() => (saved ? [freeTier, supporterTier, created] : [freeTier, supporterTier]));
    const createApi = fakeAdminEndpoint('POST', '/tiers/', () => {
      saved = true;
      return { tiers: [created] };
    });
    await renderSettings();

    await settingsScreen.tiers().getByRole('button', { name: 'Add tier' }).click();
    const modal = settingsScreen.tierDetailModal();
    await expect.element(modal.getByRole('radio', { name: 'Subscription' })).toBeChecked();
    // A new tier switches mode without a confirmation.
    await modal.getByRole('radio', { name: 'One-time purchase' }).click();
    await expect(settingsScreen.confirmationModal()).toHaveCount(0);
    await expect.element(modal.getByLabelText('Monthly price')).not.toBeVisible();
    await expect.element(modal.getByLabelText('Yearly price')).not.toBeVisible();
    await expect.element(modal.getByLabelText('Add a free trial')).not.toBeVisible();

    await modal.getByLabelText('Name').fill(created.name);
    await modal.getByRole('button', { name: 'Save' }).click();
    await expect(modal.getByText('Amount must be at least $1.')).toHaveCount(1);
    expect(createApi.requests).toHaveLength(0);

    await modal.getByLabelText('One-time price').fill('0.5');
    await modal.getByRole('button', { name: 'Save' }).click();
    await expect.element(modal.getByText('Non-zero amount must be at least $1.')).toBeVisible();
    expect(createApi.requests).toHaveLength(0);

    await modal.getByLabelText('One-time price').fill('99');
    await expect.element(modal.getByTestId('tier-preview')).toHaveTextContent('$99one-time');
    await modal.getByRole('button', { name: 'Save' }).click();
    await expect.element(modal.getByRole('button', { name: 'Saved' })).toBeVisible();

    const body = createApi.lastRequest?.body as TierBody;
    expect(body).toMatchObject({
      tiers: [{ name: created.name, one_time_price: 9900, visibility: 'none' }],
    });
    // The server fills in its placeholder recurring prices for a new tier.
    expect(body.tiers[0]).not.toHaveProperty('monthly_price');
    expect(body.tiers[0]).not.toHaveProperty('yearly_price');
  });

  it('opens a purchase-only tier in one-time mode and confirms switching it to a subscription', async () => {
    fakeSettingsScreens();
    fakeTiers([freeTier, supporterTier, courseTier]);
    const editApi = fakeAdminEndpoint('PUT', `/tiers/${courseTier.id}/`, ({ body }) => body);
    await renderSettings();

    const card = settingsScreen
      .tiers()
      .getByTestId('tier-card')
      .filter({ hasText: courseTier.name });
    await expect.element(card).toHaveTextContent('$99one-time');
    await card.getByText(courseTier.name, { exact: true }).click();

    const modal = settingsScreen.tierDetailModal();
    await expect.element(modal.getByRole('radio', { name: 'One-time purchase' })).toBeChecked();
    await expect.element(modal.getByLabelText('One-time price')).toHaveValue('99');
    await expect.element(modal.getByLabelText('Monthly price')).not.toBeVisible();
    await expect.element(modal.getByTestId('tier-preview')).toHaveTextContent('$99one-time');

    await modal.getByRole('radio', { name: 'Subscription' }).click();
    const confirmation = settingsScreen.confirmationModal();
    await expect
      .element(confirmation)
      .toHaveTextContent('This tier will be sold as a subscription at $5 a month or $50 a year.');
    await confirmation.getByRole('button', { name: 'Sell as subscription' }).click();

    await expect.element(modal.getByRole('radio', { name: 'Subscription' })).toBeChecked();
    await expect.element(modal.getByLabelText('Monthly price')).toBeVisible();
    await expect(modal.getByLabelText('One-time price')).toHaveCount(0);
    await modal.getByRole('button', { name: 'Save' }).click();
    await expect.element(modal.getByRole('button', { name: 'Saved' })).toBeVisible();

    expect(editApi.lastRequest?.body).toMatchObject({
      tiers: [{ id: courseTier.id, one_time_price: null, monthly_price: 500, yearly_price: 5000 }],
    });
  });

  it('warns before a subscription tier becomes a one-time purchase', async () => {
    fakeSettingsScreens();
    fakeTiers([freeTier, supporterTier]);
    const editApi = fakeAdminEndpoint('PUT', `/tiers/${supporterTier.id}/`, ({ body }) => body);
    await renderSettings();

    await settingsScreen.tiers().getByText(supporterTier.name, { exact: true }).click();
    const modal = settingsScreen.tierDetailModal();
    const oneTime = modal.getByRole('radio', { name: 'One-time purchase' });
    const confirmation = settingsScreen.confirmationModal();

    await oneTime.click();
    await expect
      .element(confirmation)
      .toHaveTextContent(
        'Members who already subscribe to this tier keep their subscription, but nobody can start or switch to a subscription on it.',
      );
    await confirmation.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirmation).toHaveCount(0);
    await expect.element(modal.getByRole('radio', { name: 'Subscription' })).toBeChecked();
    await expect(modal.getByLabelText('One-time price')).toHaveCount(0);

    await oneTime.click();
    await confirmation.getByRole('button', { name: 'Sell as one-time purchase' }).click();
    await modal.getByLabelText('One-time price').fill('49');
    await modal.getByRole('button', { name: 'Save' }).click();
    await expect.element(modal.getByRole('button', { name: 'Saved' })).toBeVisible();

    expect(editApi.lastRequest?.body).toMatchObject({
      tiers: [{ id: supporterTier.id, one_time_price: 4900, visibility: 'none' }],
    });
  });

  it('keeps the stock editor on a backend without one-time purchases', async () => {
    fakeSettingsScreens();
    fakeTiers([freeTier, supporterTier]);
    const editApi = fakeAdminEndpoint('PUT', `/tiers/${supporterTier.id}/`, ({ body }) => body);
    await renderSettings({ salvare: false });

    await settingsScreen.tiers().getByText(supporterTier.name, { exact: true }).click();
    const modal = settingsScreen.tierDetailModal();
    await expect.element(modal.getByLabelText('Monthly price')).toBeVisible();
    await expect(modal.getByRole('radio', { name: 'One-time purchase' })).toHaveCount(0);

    await modal.getByLabelText('Name').fill('Supporter renamed');
    await modal.getByRole('button', { name: 'Save' }).click();
    await expect.element(modal.getByRole('button', { name: 'Saved' })).toBeVisible();

    const body = editApi.lastRequest?.body as TierBody;
    expect(body.tiers[0]).toMatchObject({ name: 'Supporter renamed' });
    expect(body.tiers[0]).not.toHaveProperty('one_time_price');
  });

  it('keeps purchase-only tiers out of Portal signup and tier links', async () => {
    fakeSettingsScreens();
    fakeTiers([freeTier, supporterTier, courseTier]);
    await renderSettings();

    await settingsScreen.portal().getByRole('button', { name: 'Customize' }).click();
    const modal = settingsScreen.portalModal();
    const courseCheckbox = modal.getByLabelText(courseTier.name);
    await expect.element(courseCheckbox).toBeDisabled();
    await expect.element(courseCheckbox).not.toBeChecked();
    await expect.element(modal.getByText('Sold as a one-time purchase')).toBeVisible();
    await expect.element(courseCheckbox).toHaveAccessibleDescription('Sold as a one-time purchase');
    await expect.element(modal.getByLabelText(supporterTier.name)).toBeEnabled();

    await modal.getByRole('tab', { name: 'Links' }).click();
    await modal.getByRole('combobox', { name: 'Tier' }).click();
    await expect.element(page.getByRole('option', { name: supporterTier.name })).toBeVisible();
    await expect(page.getByRole('option', { name: courseTier.name })).toHaveCount(0);
  });

  it('offers no tier links when every paid tier is purchase-only', async () => {
    fakeSettingsScreens();
    fakeTiers([freeTier, courseTier]);
    await renderSettings();

    await settingsScreen.portal().getByRole('button', { name: 'Customize' }).click();
    const modal = settingsScreen.portalModal();
    await modal.getByRole('tab', { name: 'Links' }).click();
    await expect.element(modal.getByText('No subscription tiers to link to.')).toBeVisible();
    await expect(modal.getByRole('combobox', { name: 'Tier' })).toHaveCount(0);
    await expect(modal.getByText('Signup / Monthly')).toHaveCount(0);
    await expect.element(modal.getByText('Signup / Free')).toBeVisible();
  });

  it('asks for an active subscription tier before offers when every paid tier is purchase-only', async () => {
    fakeSettingsScreens();
    fakeTiers([freeTier, courseTier]);
    await renderSettings();

    await expect
      .element(page.getByTestId('offers'))
      .toHaveTextContent('You must have an active tier to create an offer.');
  });

  it('confirms before one-time mode discards unsaved checkout field changes', async () => {
    fakeSettingsScreens();
    fakeTiers([freeTier, supporterTier]);
    fakeMemberCustomFields([]);
    fakeAdminEndpoint('GET', '/tiers/checkout_config/', { tiers_checkout_config: [] });
    await renderSettings({ labs: { stripeCheckoutCollection: true } });

    await settingsScreen.tiers().getByText(supporterTier.name, { exact: true }).click();
    const modal = settingsScreen.tierDetailModal();
    const phone = modal.getByLabelText('Collect phone number');
    await phone.click();
    await expect.element(phone).toBeChecked();

    await modal.getByRole('radio', { name: 'One-time purchase' }).click();
    const confirmation = settingsScreen.confirmationModal();
    await expect
      .element(confirmation)
      .toHaveTextContent('Your unsaved checkout field changes will be discarded.');
    await confirmation.getByRole('button', { name: 'Cancel' }).click();
    await expect.element(modal.getByRole('radio', { name: 'Subscription' })).toBeChecked();
    await expect.element(phone).toBeChecked();
  });
});
