// fork(salvare): fork migrations go in the folder of the fork's current upstream base (6.63 here).
// One-time purchases of tiers. The spec is a frozen copy of members_purchases as it stands in
// schema.js at the time of writing, per the migration rules: this file must keep building the
// same shape however schema.js moves on.
const { addTable } = require('../../utils');

module.exports = addTable('members_purchases', {
  id: { type: 'string', maxlength: 24, nullable: false, primary: true },
  member_id: {
    type: 'string',
    maxlength: 24,
    nullable: true,
    unique: false,
    references: 'members.id',
    setNullDelete: true,
  },
  product_id: {
    type: 'string',
    maxlength: 24,
    nullable: false,
    unique: false,
    references: 'products.id',
  },
  stripe_checkout_session_id: { type: 'string', maxlength: 255, nullable: true, unique: true },
  stripe_payment_intent_id: { type: 'string', maxlength: 255, nullable: true, unique: true },
  stripe_customer_id: { type: 'string', maxlength: 255, nullable: true },
  amount: { type: 'integer', nullable: false, unsigned: true },
  currency: { type: 'string', maxlength: 50, nullable: false },
  status: {
    type: 'string',
    maxlength: 50,
    nullable: false,
    defaultTo: 'paid',
    validations: { isIn: [['paid', 'refunded']] },
  },
  expires_at: { type: 'dateTime', nullable: true },
  refunded_at: { type: 'dateTime', nullable: true },
  attribution_id: { type: 'string', maxlength: 24, nullable: true },
  attribution_type: {
    type: 'string',
    maxlength: 50,
    nullable: true,
    validations: {
      isIn: [['url', 'post', 'page', 'author', 'tag']],
    },
  },
  attribution_url: { type: 'string', maxlength: 2000, nullable: true },
  referrer_source: { type: 'string', maxlength: 191, nullable: true },
  referrer_medium: { type: 'string', maxlength: 191, nullable: true },
  referrer_url: { type: 'string', maxlength: 2000, nullable: true },
  utm_source: { type: 'string', maxlength: 191, nullable: true },
  utm_medium: { type: 'string', maxlength: 191, nullable: true },
  utm_campaign: { type: 'string', maxlength: 191, nullable: true },
  utm_term: { type: 'string', maxlength: 191, nullable: true },
  utm_content: { type: 'string', maxlength: 191, nullable: true },
  created_at: { type: 'dateTime', nullable: false },
  updated_at: { type: 'dateTime', nullable: true },
  '@@INDEXES@@': [['member_id', 'product_id']],
});
