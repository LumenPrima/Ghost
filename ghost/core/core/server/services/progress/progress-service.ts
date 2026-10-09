// fork(salvare): lesson progress. See README.md.
import errors from '@tryghost/errors';
import type { z } from 'zod';
import type { ProgressAccessChecker } from './progress-access';
import type { ProgressRepository } from './progress-knex-repository';
import {
  BrowseQuerySchema,
  UpsertBodySchema,
  type ProgressItem,
  type ProgressRow,
} from './progress-schema';

const messages = {
  invalid: 'Invalid progress request.',
  postNotFound: 'Post not found.',
  postLocked: "You don't have access to this lesson.",
};

export interface ProgressServiceDeps {
  repository: ProgressRepository;
  checker: Pick<ProgressAccessChecker, 'check'>;
  now?: () => Date;
}

function validationError(error: z.ZodError): InstanceType<typeof errors.ValidationError> {
  const issue = error.issues[0];
  const path = issue.path.length ? `${issue.path.join('.')}: ` : '';
  return new errors.ValidationError({
    message: messages.invalid,
    context: `${path}${issue.message}`,
  });
}

/**
 * A member's own lesson progress. Callers pass the id of the signed-in member;
 * nothing here takes a member id from the request.
 */
export class ProgressService {
  private readonly deps: ProgressServiceDeps;

  constructor(deps: ProgressServiceDeps) {
    this.deps = deps;
  }

  /**
   * The member's rows for one post, or for every post carrying a tag. No access
   * filter: these are the member's own rows, and a row only exists for a post that
   * passed the write check.
   */
  async browse(memberId: string, options: Record<string, unknown>): Promise<ProgressRow[]> {
    // Frame options also carry the request context; only these keys are the query.
    const picked = Object.fromEntries(
      ['post_id', 'post', 'tag']
        .filter((key) => options?.[key] !== undefined)
        .map((key) => [key, options[key]]),
    );

    const parsed = BrowseQuerySchema.safeParse(picked);
    if (!parsed.success) {
      throw validationError(parsed.error);
    }

    const query = parsed.data;
    if (query.postId !== undefined) {
      return this.deps.repository.browseByPost(memberId, query.postId);
    }
    return this.deps.repository.browseByTag(memberId, query.tagSlug!);
  }

  /**
   * Record progress on a batch of posts. All or nothing: any unknown or
   * unpublished post refuses the batch with 404, any locked one with 403, and
   * nothing is written.
   */
  async upsert(memberId: string, body: unknown): Promise<ProgressRow[]> {
    const parsed = UpsertBodySchema.safeParse(body);
    if (!parsed.success) {
      throw validationError(parsed.error);
    }

    // The last entry for a post wins.
    const byPost = new Map<string, ProgressItem>();
    for (const item of parsed.data.progress) {
      byPost.set(item.post_id, { postId: item.post_id, status: item.status });
    }
    const items = [...byPost.values()];
    const postIds = [...byPost.keys()];

    const access = await this.deps.checker.check(memberId, postIds);

    const missing = postIds.filter((id) => access.get(id) !== 'ok' && access.get(id) !== 'locked');
    if (missing.length) {
      throw new errors.NotFoundError({
        message: messages.postNotFound,
        context: `No published post with id ${missing.join(', ')}.`,
        code: 'POST_NOT_FOUND',
      });
    }

    const locked = postIds.filter((id) => access.get(id) === 'locked');
    if (locked.length) {
      throw new errors.NoPermissionError({
        message: messages.postLocked,
        context: `Locked: ${locked.join(', ')}.`,
        code: 'POST_LOCKED',
      });
    }

    const now = this.deps.now ? this.deps.now() : new Date();
    return this.deps.repository.upsert(memberId, items, now);
  }
}
