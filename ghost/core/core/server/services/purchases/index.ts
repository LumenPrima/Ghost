// fork(salvare): one-time tier purchases. See README.md.
import { PurchaseCheckoutAdapter } from './purchase-checkout-adapter';
import { PurchaseEmailService } from './purchase-email-service';
import { PurchaseEventRepository } from './purchase-event-repository';
import { PurchaseKnexRepository } from './purchase-knex-repository';
import { MembersApiMagicLinks } from './purchase-magic-links';
import { PurchaseService } from './purchase-service';

// Constructed by init() at boot, after Stripe and before members. Consumers
// (the Stripe webhook services, the members router) hold this module and read
// `.service` lazily. Under the dev/test loader (tsx) this compiles to a
// getter-only export, so tests can't assign to it — stub the module instead.
export let service: PurchaseService | undefined;

export function init(): void {
  if (service) {
    return;
  }

  const { StripePrice: StripePriceModel } = require('../../models');
  const db = require('../../data/db');
  const membersService = require('../members');
  const tiersService = require('../tiers');
  const staffService = require('../staff');
  const { GhostMailer } = require('../mail');
  const settingsCache = require('../../../shared/settings-cache');
  const urlUtils = require('../../../shared/url-utils').default;
  const settingsHelpers = require('../settings-helpers');
  const emailAddressParser = require('../email-address/email-address-parser');
  const { blogIcon, gravatar } = require('../../../server/lib/image');
  const config = require('../../../shared/config');

  const purchaseRepository = new PurchaseKnexRepository({ knex: db.knex });
  const checkoutAdapter = new PurchaseCheckoutAdapter({
    StripePriceModel,
    // Lazy: the Stripe API is reconfigured when keys change.
    getStripeApi: () => require('../stripe').api,
    getPaymentsService: () => membersService.api.paymentsService,
  });
  const purchaseEmailService = new PurchaseEmailService({
    transactionalMailer: new GhostMailer(),
    settingsCache,
    urlUtils,
    getFromAddress: () => emailAddressParser.stringify(settingsHelpers.getDefaultEmail()),
    getReplyToAddress: () => settingsHelpers.getMembersSupportAddress(),
    blogIcon,
  });

  service = new PurchaseService({
    purchaseRepository,
    checkoutAdapter,
    get memberRepository() {
      return membersService.api.members;
    },
    tiersService,
    magicLinks: new MembersApiMagicLinks({
      getMembersApi: () => membersService.api,
    }),
    purchaseEmailService,
    get staffServiceEmails() {
      return staffService.api.emails;
    },
    urlUtils,
    eventRepository: new PurchaseEventRepository({
      knex: db.knex,
      // As the Member model's toJSON computes it.
      getAvatarImage: (email: string) =>
        config.isPrivacyDisabled('useGravatar')
          ? null
          : gravatar.url(email, { size: 250, default: 'blank' }),
    }),
    // Set when the members service boots, which is after this init.
    get verificationTrigger() {
      return membersService.verificationTrigger;
    },
  });
}
