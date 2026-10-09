// fork(salvare): fork migrations go in the folder of the fork's current upstream base (6.63 here).
// One-time purchase price of a tier, in minor units.
const { createAddColumnMigration } = require('../../utils');

module.exports = createAddColumnMigration('products', 'one_time_price', {
  type: 'integer',
  unsigned: true,
  nullable: true,
});
