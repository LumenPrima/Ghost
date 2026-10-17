import TierDetailPreview from '@/settings/membership/tiers/tier-detail-preview';
import assert from 'node:assert/strict';
import { render, screen } from '@testing-library/react';

describe('TierDetailPreview', () => {
  it('removes only the deleted benefit when duplicate labels exist', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const tier = {
      trial_days: '0',
      benefits: ['Repeated benefit', 'Repeated benefit', 'Other benefit'],
    };
    const { rerender } = render(<TierDetailPreview isFreeTier={false} tier={tier} />);

    assert.equal(screen.getAllByText('Repeated benefit').length, 2);

    rerender(
      <TierDetailPreview
        isFreeTier={false}
        tier={{ ...tier, benefits: ['Repeated benefit', 'Other benefit'] }}
      />,
    );

    assert.equal(screen.getAllByText('Repeated benefit').length, 1);
    assert.ok(screen.getByText('Other benefit'));
    assert.equal(
      consoleError.mock.calls.some((call) =>
        call.some((value) => String(value).includes('same key')),
      ),
      false,
    );

    consoleError.mockRestore();
  });

  // fork(salvare)
  it('shows a one-time price in place of the monthly and yearly prices', () => {
    const tier = {
      trial_days: '7',
      currency: 'USD',
      monthly_price: 500,
      yearly_price: 4000,
    };
    const { rerender } = render(
      <TierDetailPreview isFreeTier={false} oneTimePrice={12900} tier={tier} />,
    );

    const preview = screen.getByTestId('tier-preview');
    assert.match(preview.textContent ?? '', /\$129one-time/);
    assert.equal(screen.queryByRole('button', { name: 'Yearly' }), null);
    assert.equal(screen.queryByText('7 days free'), null);

    rerender(<TierDetailPreview isFreeTier={false} oneTimePrice={null} tier={tier} />);
    assert.match(preview.textContent ?? '', /\$99one-time/);

    rerender(<TierDetailPreview isFreeTier={false} tier={tier} />);
    assert.match(preview.textContent ?? '', /\$5\/month/);
    assert.ok(screen.getByRole('button', { name: 'Yearly' }));
    assert.ok(screen.getByText('7 days free'));
  });
});
