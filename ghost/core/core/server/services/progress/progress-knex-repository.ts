// fork(salvare): lesson progress. See README.md.
import errors from '@tryghost/errors';
import ObjectId from 'bson-objectid';
import type { Knex } from 'knex';
import { fromDatabaseDate, toDatabaseDate } from '../../lib/db-types/date';
import type { ProgressItem, ProgressRow, ProgressStatus } from './progress-schema';

const TABLE = 'members_post_progress';

/** A tier as content gating reads it from a post. */
export interface LessonTier {
  id: string;
  slug: string;
  type: string;
}

/**
 * A published post with what `checkPostAccess` and `drip.evaluate` read: the
 * visibility and the post's tiers (`posts_products`, in their sort order).
 */
export interface LessonPost {
  id: string;
  visibility: string;
  tiers: LessonTier[];
}

interface DbProgressRow {
  post_id: string;
  status: ProgressStatus;
  created_at: Date | string | number;
  updated_at: Date | string | number | null;
}

function toProgressRow(row: DbProgressRow): ProgressRow {
  return {
    post_id: row.post_id,
    status: row.status,
    updated_at: fromDatabaseDate(row.updated_at ?? row.created_at).toISOString(),
  };
}

function isForeignKeyViolation(err: unknown): boolean {
  const { code, errno, message } = (err ?? {}) as {
    code?: unknown;
    errno?: unknown;
    message?: unknown;
  };
  if (code === 'ER_NO_REFERENCED_ROW_2' || errno === 1452) {
    return true;
  }
  // better-sqlite3 reports SQLITE_CONSTRAINT_FOREIGNKEY for some statements and
  // the bare SQLITE_CONSTRAINT for others (this transactional multi-row upsert).
  return (
    code === 'SQLITE_CONSTRAINT_FOREIGNKEY' ||
    (code === 'SQLITE_CONSTRAINT' &&
      typeof message === 'string' &&
      message.includes('FOREIGN KEY constraint failed'))
  );
}

export interface ProgressRepository {
  browseByPost(memberId: string, postId: string): Promise<ProgressRow[]>;
  browseByTag(memberId: string, tagSlug: string): Promise<ProgressRow[]>;
  /** Inserts or updates one row per item, keeping `created_at` on update. Returns the rows written. */
  upsert(memberId: string, items: ProgressItem[], now: Date): Promise<ProgressRow[]>;
  /** Published posts (type `post`) among `postIds`, with their tiers. Unknown, draft, scheduled and page ids are absent. */
  getPublishedPosts(postIds: string[]): Promise<LessonPost[]>;
}

/**
 * Knex-only: no Bookshelf model, so nothing here fires model events or reaches
 * the model layer's relations. Every date goes through toDatabaseDate, because
 * Knex binds a raw Date as epoch milliseconds on SQLite.
 */
export class ProgressKnexRepository implements ProgressRepository {
  private readonly knex: Knex;

  constructor({ knex }: { knex: Knex }) {
    this.knex = knex;
  }

  async browseByPost(memberId: string, postId: string): Promise<ProgressRow[]> {
    const rows: DbProgressRow[] = await this.knex(TABLE)
      .select('post_id', 'status', 'created_at', 'updated_at')
      .where({ member_id: memberId, post_id: postId });

    return rows.map(toProgressRow);
  }

  async browseByTag(memberId: string, tagSlug: string): Promise<ProgressRow[]> {
    // DISTINCT: posts_tags has no unique key, so a post tagged twice would repeat.
    const rows: DbProgressRow[] = await this.knex(`${TABLE} as p`)
      .join('posts_tags as pt', 'pt.post_id', 'p.post_id')
      .join('tags as t', 't.id', 'pt.tag_id')
      .where({ 'p.member_id': memberId, 't.slug': tagSlug })
      .distinct('p.post_id', 'p.status', 'p.created_at', 'p.updated_at')
      .orderBy('p.post_id');

    return rows.map(toProgressRow);
  }

  async upsert(memberId: string, items: ProgressItem[], now: Date): Promise<ProgressRow[]> {
    if (!items.length) {
      return [];
    }

    const timestamp = toDatabaseDate(now);
    // Sorted by post id so concurrent batches for the same member lock the unique
    // key entries in the same order; request order lets [A,B] and [B,A] deadlock
    // on InnoDB. Ids are lowercase hex, so a plain comparison is enough.
    const sorted = [...items].sort((a, b) =>
      a.postId < b.postId ? -1 : a.postId > b.postId ? 1 : 0,
    );
    const postIds = sorted.map((item) => item.postId);

    try {
      return await this.knex.transaction(async (trx) => {
        await trx(TABLE)
          .insert(
            sorted.map((item) => ({
              id: ObjectId().toHexString(),
              member_id: memberId,
              post_id: item.postId,
              status: item.status,
              created_at: timestamp,
              updated_at: timestamp,
            })),
          )
          .onConflict(['member_id', 'post_id'])
          .merge(['status', 'updated_at']);

        const rows: DbProgressRow[] = await trx(TABLE)
          .select('post_id', 'status', 'created_at', 'updated_at')
          .where({ member_id: memberId })
          .whereIn('post_id', postIds)
          .orderBy('post_id');

        return rows.map(toProgressRow);
      });
    } catch (err) {
      // The access check reads the posts outside this transaction, so a post (or
      // the member) deleted in between fails a foreign key here. Report it as the
      // check would have, not as a 500.
      if (isForeignKeyViolation(err)) {
        throw new errors.NotFoundError({
          message: 'Post not found.',
          code: 'POST_NOT_FOUND',
        });
      }
      throw err;
    }
  }

  async getPublishedPosts(postIds: string[]): Promise<LessonPost[]> {
    if (!postIds.length) {
      return [];
    }

    const posts: Array<{ id: string; visibility: string }> = await this.knex('posts')
      .select('id', 'visibility')
      .whereIn('id', postIds)
      .andWhere({ type: 'post', status: 'published' });

    if (!posts.length) {
      return [];
    }

    // The same order as the Post model's `tiers` relation (posts_products.sort_order).
    const tierRows: Array<LessonTier & { post_id: string }> = await this.knex(
      'posts_products as pp',
    )
      .join('products as pr', 'pr.id', 'pp.product_id')
      .whereIn(
        'pp.post_id',
        posts.map((post) => post.id),
      )
      .select('pp.post_id', 'pr.id', 'pr.slug', 'pr.type')
      .orderBy([
        { column: 'pp.post_id', order: 'asc' },
        { column: 'pp.sort_order', order: 'asc' },
      ]);

    const tiersByPost = new Map<string, LessonTier[]>();
    for (const row of tierRows) {
      const tiers = tiersByPost.get(row.post_id) ?? [];
      tiers.push({ id: row.id, slug: row.slug, type: row.type });
      tiersByPost.set(row.post_id, tiers);
    }

    return posts.map((post) => ({
      id: post.id,
      visibility: post.visibility,
      tiers: tiersByPost.get(post.id) ?? [],
    }));
  }
}
