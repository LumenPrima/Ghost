// fork(salvare): a member's own one-time purchases. See services/purchases/README.md.
const express = require('../../../../shared/express');
const { http } = require('@tryghost/api-framework');
const api = require('../../../api').endpoints;
const middleware = require('../../../services/members/middleware');

/**
 * `GET /members/api/purchases/`: the signed-in member's active purchases.
 *
 * Read only, and refused with 401 for an anonymous caller. The members app
 * already sends `Cache-Control: private` on every response.
 */
function purchasesRoutes() {
  const router = express.Router('member-purchases');

  router.use(middleware.loadMemberIdentity);

  router.get('/', middleware.rejectWhenAnonymous, http(api.purchasesMembers.browse));

  return router;
}

// Exported as a module, like members-account.ts, so its names stay out of the global scope.
export default purchasesRoutes;
module.exports = purchasesRoutes;
