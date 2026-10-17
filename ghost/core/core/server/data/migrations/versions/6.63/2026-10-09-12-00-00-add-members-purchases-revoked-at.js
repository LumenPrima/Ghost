// fork(salvare): fork migrations go in the folder of the fork's current upstream base (6.63 here).
// When staff revoked a purchase's access (status 'revoked'). The status column needs no change:
// its allowed values are enforced by the application, not the database.
const { createAddColumnMigration } = require('../../utils');

module.exports = createAddColumnMigration('members_purchases', 'revoked_at', {
  type: 'dateTime',
  nullable: true,
});
