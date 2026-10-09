// fork(salvare): drip. In-memory post id → drip days index. See README.md.
import type { Knex } from 'knex';
import { buildDripDaysMap, type DripTagRow } from './drip-tags';

/**
 * Every `(post_id, tag name)` pair for an internal tag whose name starts with
 * `#drip-`. A few hundred rows at most; `tags.name` is parsed by drip-tags.ts.
 */
export async function queryDripTagRows(knex: Knex): Promise<DripTagRow[]> {
  const rows: Array<{ post_id: string; name: string }> = await knex('posts_tags')
    .join('tags', 'tags.id', 'posts_tags.tag_id')
    .where('tags.visibility', 'internal')
    .andWhere('tags.name', 'like', '#drip-%')
    .select('posts_tags.post_id as post_id', 'tags.name as name');

  return rows.map((row) => ({ post_id: String(row.post_id), name: String(row.name) }));
}

export interface DripIndexLogger {
  error(...args: unknown[]): void;
}

/**
 * Holds the current map and reloads it.
 *
 * - At most one reload is in flight, plus at most one queued behind it; a burst
 *   of change events costs two queries at most.
 * - The new map is swapped in only after a successful load. A failed reload
 *   keeps the old map and logs.
 */
export class DripIndex {
  readonly #loadRows: () => Promise<DripTagRow[]>;
  readonly #logger: DripIndexLogger;
  #days: Map<string, number> = new Map();
  #loaded = false;
  #inFlight: Promise<boolean> | null = null;
  #queued: Promise<boolean> | null = null;

  constructor({
    loadRows,
    logger,
  }: {
    loadRows: () => Promise<DripTagRow[]>;
    logger: DripIndexLogger;
  }) {
    this.#loadRows = loadRows;
    this.#logger = logger;
  }

  /** Drip days for a post, or null when it isn't dripped (or nothing is loaded yet). */
  get(postId: unknown): number | null {
    if (typeof postId !== 'string') {
      return null;
    }
    return this.#days.get(postId) ?? null;
  }

  /** Diagnostics; used by tests. */
  get size(): number {
    return this.#days.size;
  }

  /** Diagnostics; used by tests. */
  get loaded(): boolean {
    return this.#loaded;
  }

  /** Resolves true when this reload (or the one it coalesced into) swapped in a new map. Never rejects. */
  reload(): Promise<boolean> {
    if (!this.#inFlight) {
      this.#inFlight = this.#run();
      return this.#inFlight;
    }

    if (!this.#queued) {
      const previous = this.#inFlight;
      this.#queued = previous.then(() => {
        this.#queued = null;
        this.#inFlight = this.#run();
        return this.#inFlight;
      });
    }

    return this.#queued;
  }

  async #run(): Promise<boolean> {
    try {
      const rows = await this.#loadRows();
      this.#days = buildDripDaysMap(rows);
      this.#loaded = true;
      return true;
    } catch (err) {
      this.#logger.error({
        err,
        message: 'drip.index_reload_failed: keeping the previous drip index',
      });
      return false;
    } finally {
      // Only clear when no queued reload has already taken over the slot.
      if (!this.#queued) {
        this.#inFlight = null;
      }
    }
  }

  /** Empties the index (tests and shutdown). */
  clear(): void {
    this.#days = new Map();
    this.#loaded = false;
  }
}
