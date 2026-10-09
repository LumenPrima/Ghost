// fork(salvare): lesson progress. See services/progress/README.md.
const express = require('../../../../shared/express');
const bodyParser = require('body-parser');
const { http } = require('@tryghost/api-framework');
const api = require('../../../api').endpoints;
const middleware = require('../../../services/members/middleware');

/**
 * A member's own lesson progress, over HTTP.
 *
 * Both routes are for a signed-in member acting on their own rows, so both refuse
 * an unknown caller with 401. Same-origin JSON with the session cookie, the same
 * posture as `PUT /api/member/`. No rate limiter in v1: writes are capped at 100
 * posts and 100 kB, idempotent, and scoped to the caller.
 */
function progressRoutes() {
  const router = express.Router('member-progress');

  router.use(middleware.loadMemberIdentity);

  router.get('/', middleware.rejectWhenAnonymous, http(api.progressMembers.browse));

  router.put(
    '/',
    bodyParser.json({ limit: '100kb' }),
    middleware.rejectWhenAnonymous,
    http(api.progressMembers.update),
  );

  return router;
}

// Exported as a module, like members-account.ts, so its names stay out of the global scope.
export default progressRoutes;
module.exports = progressRoutes;
