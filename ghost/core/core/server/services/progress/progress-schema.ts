// fork(salvare): lesson progress. See README.md.
import { z } from 'zod';

// Ids arrive from the theme as typed by a template. They are compared and stored
// lowercase: MySQL would match an uppercase id case-insensitively but store it
// non-canonically, and SQLite would not match it at all.
const PostId = z
  .string()
  .regex(/^[a-f\d]{24}$/i, 'must be a 24-character hex id')
  .transform((id) => id.toLowerCase());

export const ProgressStatusSchema = z.enum(['started', 'completed']);
export type ProgressStatus = z.infer<typeof ProgressStatusSchema>;

/** PUT body: `{progress: [{post_id, status}]}`, 1 to 100 items, no other keys. */
export const UpsertBodySchema = z.strictObject({
  progress: z
    .array(z.strictObject({ post_id: PostId, status: ProgressStatusSchema }))
    .min(1)
    .max(100),
});

export type ProgressQuery =
  | { postId: string; tagSlug?: never }
  | { tagSlug: string; postId?: never };

/**
 * GET query, after the caller has picked `post_id`, `post` and `tag` out of the
 * frame options (which also carry the request context). `post` is an alias for
 * `post_id`; both may be sent only when they agree. Exactly one of a post and a
 * tag is required.
 */
export const BrowseQuerySchema = z
  .strictObject({
    post_id: PostId.optional(),
    post: PostId.optional(),
    // A parameter in a bound query, so any slug-sized string is safe; slugs may
    // carry non-ASCII characters, so no character class. Lowercased because Ghost
    // stores slugs lowercase and SQLite's `=` is case-sensitive where MySQL's is not.
    tag: z.string().trim().toLowerCase().min(1).max(191).optional(),
  })
  .superRefine((query, ctx) => {
    if (query.post_id !== undefined && query.post !== undefined && query.post_id !== query.post) {
      ctx.addIssue({
        code: 'custom',
        path: ['post'],
        message: 'post and post_id name different posts',
      });
      return;
    }

    const hasPost = query.post_id !== undefined || query.post !== undefined;
    const hasTag = query.tag !== undefined;
    if (hasPost === hasTag) {
      ctx.addIssue({
        code: 'custom',
        path: [],
        message: 'exactly one of post_id (or post) and tag is required',
      });
    }
  })
  .transform((query): ProgressQuery => {
    const postId = query.post_id ?? query.post;
    return postId !== undefined ? { postId } : { tagSlug: query.tag! };
  });

/** One row as the members API returns it. `updated_at` is ISO 8601 UTC. */
export interface ProgressRow {
  post_id: string;
  status: ProgressStatus;
  updated_at: string;
}

export interface ProgressItem {
  postId: string;
  status: ProgressStatus;
}
