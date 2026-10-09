// fork(salvare): lesson progress. See services/progress/README.md.
const progress = require('../../services/progress');

/**
 * A member's own lesson progress, as the member themselves.
 *
 * The route establishes who is asking and refuses an unknown caller before this
 * runs, so there is always a member here. No serializer of its own: the default
 * output serializer turns `{data: rows}` into `{progress: rows}`, which is the
 * shape the theme reads.
 */

interface Frame {
  data: unknown;
  options: Record<string, unknown> & {
    context?: { member?: { id: string; email: string } | null };
  };
}

const memberOf = (frame: Frame) => frame.options?.context?.member ?? null;

const controller = {
  docName: 'progress',

  browse: {
    headers: { cacheInvalidate: false },
    permissions: false,
    options: ['post_id', 'post', 'tag'],
    async query(frame: Frame) {
      return { data: await progress.service.browse(memberOf(frame)!.id, frame.options) };
    },
  },

  // `update` rather than `add` or `edit`: those verbs bring the framework's
  // envelope validators and a Location header, and this is an idempotent upsert
  // of the caller's own rows.
  update: {
    headers: { cacheInvalidate: false },
    permissions: false,
    async query(frame: Frame) {
      return { data: await progress.service.upsert(memberOf(frame)!.id, frame.data) };
    },
  },
};

export default controller;
module.exports = controller;
