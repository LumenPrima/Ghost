// fork(salvare): fork migrations go in the folder of the fork's current upstream base (6.63 here).
// Per-member lesson progress. The spec is a frozen copy of members_post_progress as it stands in
// schema.js at the time of writing, per the migration rules: this file must keep building the
// same shape however schema.js moves on.
const { addTable } = require('../../utils');

module.exports = addTable('members_post_progress', {
  id: { type: 'string', maxlength: 24, nullable: false, primary: true },
  member_id: {
    type: 'string',
    maxlength: 24,
    nullable: false,
    references: 'members.id',
    cascadeDelete: true,
  },
  post_id: {
    type: 'string',
    maxlength: 24,
    nullable: false,
    references: 'posts.id',
    cascadeDelete: true,
  },
  status: {
    type: 'string',
    maxlength: 50,
    nullable: false,
    validations: { isIn: [['started', 'completed']] },
  },
  created_at: { type: 'dateTime', nullable: false },
  updated_at: { type: 'dateTime', nullable: true },
  '@@UNIQUE_CONSTRAINTS@@': [['member_id', 'post_id']],
});
