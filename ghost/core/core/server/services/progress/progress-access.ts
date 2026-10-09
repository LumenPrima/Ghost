// fork(salvare): lesson progress. See README.md.
import errors from '@tryghost/errors';
import type { LessonPost } from './progress-knex-repository';

export type PostAccess = 'ok' | 'not_found' | 'locked';

/** The bread member (`memberBREADService.read`), the same shape as the session member. */
export type AccessMember = Record<string, any>;

export interface DripEvaluation {
  access: boolean;
  unlockAt: string | null;
}

export interface ProgressAccessDeps {
  /** Resolves to null when the member no longer exists. */
  loadMember(memberId: string): Promise<AccessMember | null>;
  loadPosts(postIds: string[]): Promise<LessonPost[]>;
  /** `membersService.contentGating.checkPostAccess`. */
  checkPostAccess(post: LessonPost, member: AccessMember): boolean;
  /** `drip.evaluate`. */
  evaluateDrip(
    post: LessonPost,
    member: AccessMember,
    opts: { memberHasAccess: boolean; now: Date },
  ): DripEvaluation;
  now?: () => Date;
}

const messages = {
  noMember: 'You must be signed in to do this.',
};

/**
 * Whether a member may record progress on each of a set of posts.
 *
 * Follows the comments service (comments-service.js `#checkPostAccessForRead`):
 * load the post with its tiers, then ask content gating. Drip comes after, through
 * the same `drip.evaluate` the Content API's post gating uses, so a lesson that
 * renders locked refuses progress, and `advise` or `off` modes open both at once.
 *
 * Tiers are narrowed the way the Content API's posts mapper narrows them for a
 * `tiers` post (mappers/posts.js: paid tiers only), so the answer here matches
 * what the member sees on the page.
 */
export class ProgressAccessChecker {
  private readonly deps: ProgressAccessDeps;

  constructor(deps: ProgressAccessDeps) {
    this.deps = deps;
  }

  async check(memberId: string, postIds: string[]): Promise<Map<string, PostAccess>> {
    const member = await this.deps.loadMember(memberId);
    if (!member) {
      // Signed in a moment ago, deleted since.
      throw new errors.UnauthorizedError({ message: messages.noMember });
    }

    const posts = await this.deps.loadPosts(postIds);
    const byId = new Map(posts.map((post) => [post.id, post]));
    // One instant for the whole batch, so two lessons near the same unlock agree.
    const now = this.deps.now ? this.deps.now() : new Date();
    const result = new Map<string, PostAccess>();

    for (const postId of postIds) {
      const found = byId.get(postId);
      if (!found) {
        result.set(postId, 'not_found');
        continue;
      }

      const post: LessonPost =
        found.visibility === 'tiers'
          ? { ...found, tiers: found.tiers.filter((tier) => tier.type === 'paid') }
          : found;

      const memberHasAccess = this.deps.checkPostAccess(post, member) === true;
      const { access } = this.deps.evaluateDrip(post, member, { memberHasAccess, now });

      result.set(postId, access ? 'ok' : 'locked');
    }

    return result;
  }
}
