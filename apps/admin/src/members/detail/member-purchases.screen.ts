// fork(salvare): member Purchases panel locators for acceptance specs; no assertions.
// The selector strings live here rather than in the shared
// `@tryghost/test-data/selectors/members` registry, to keep the fork's diff
// against upstream files small. No e2e page object uses them.
import { page } from 'vitest/browser';

export const memberPurchasesScreen = {
  section: () => page.getByTestId('member-purchases'),
  heading: () => page.getByRole('heading', { name: 'Purchases', exact: true }),
  rows: () => page.getByTestId('member-purchase'),
  /** A purchase row, scoped by its tier name. */
  row: (tierName: string) => page.getByTestId('member-purchase').filter({ hasText: tierName }),
  menuButton: (tierName: string) =>
    memberPurchasesScreen.row(tierName).getByRole('button', { name: 'Purchase menu' }),
  menuLink: (name: string) => page.getByRole('menuitem', { name }),
  revokeMenuItem: () => page.getByRole('menuitem', { name: 'Revoke access' }),
  revokeDialog: () => page.getByRole('alertdialog'),
  confirmRevokeButton: () =>
    page.getByRole('alertdialog').getByRole('button', { name: 'Revoke access' }),

  grantButton: () => page.getByRole('button', { name: 'Grant purchase' }),
  grantModal: () => page.getByTestId('grant-purchase-modal'),
  grantTierSelect: () => page.getByTestId('grant-purchase-tier-select'),
  grantTierOptions: () => page.getByRole('listbox').getByRole('option'),
  grantSendEmail: () =>
    page.getByRole('checkbox', { name: 'Email the member a link to the course' }),
  grantConfirmButton: () => page.getByTestId('grant-purchase-confirm'),
  grantTierError: () => page.getByTestId('grant-purchase-tier-error'),

  // Upstream's Subscriptions section, for the comp-flow fixes.
  subscriptionsHeading: () => page.getByRole('heading', { name: 'Subscriptions', exact: true }),
  compTierSelect: () => page.getByTestId('comp-tier-select'),
  addCompButton: () => page.getByTestId('add-complimentary'),
  /** An option in whichever tier select is open (grant or comp modal). */
  tierOption: (name: string) => page.getByRole('option', { name, exact: true }),
  subscriptionMenuButton: (tierName: string) =>
    page
      .getByTestId('member-subscription')
      .filter({ hasText: tierName })
      .getByRole('button', { name: 'Subscription menu' }),
  removeCompMenuItem: () => page.getByTestId('remove-complimentary'),
  confirmRemoveCompButton: () => page.getByTestId('confirm-remove-complimentary'),
};
