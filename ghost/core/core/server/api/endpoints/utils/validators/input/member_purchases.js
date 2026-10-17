// fork(salvare): staff grants and revokes of one-time tier purchases. See services/purchases/README.md.
// Filename must match the docName specified in ../../../member-purchases.ts
/* eslint-disable local-filenames/match-regex */
const { ValidationError } = require('@tryghost/errors');
const tpl = require('@tryghost/tpl');
const jsonSchema = require('../utils/json-schema');

const messages = {
  invalidPurchaseId: 'Invalid purchase id provided.',
};

// The framework's global `id` validator covers the member id only.
const OBJECT_ID = /^[a-f0-9]{24}$/;

module.exports = {
  add: jsonSchema.validate,

  destroy(apiConfig, frame) {
    if (!OBJECT_ID.test(String(frame.options.purchase_id))) {
      throw new ValidationError({
        message: tpl(messages.invalidPurchaseId),
        property: 'purchase_id',
      });
    }
  },
};
