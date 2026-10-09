// fork(salvare): drip. See README.md.
//
// post-gating.js requires this module while the API layer loads, so nothing
// here may require members, api or models at the top level (import cycle).
// Config, settings, events, logging and the database are required lazily.
import type { EventEmitter } from 'node:events';
import { computeAccessStarts as computeStarts, type AccessStarts } from './access-starts';
import { DripIndex, queryDripTagRows } from './drip-index';
import { evaluateDrip, type DripDecision, type DripMode } from './drip-rules';
import type { DripTagRow } from './drip-tags';

export type { AccessStarts } from './access-starts';
export type { DripMode } from './drip-rules';

interface Logger {
  error(...args: unknown[]): void;
  warn(...args: unknown[]): void;
}

/** Overrides for tests. Boot calls `init()` with none. */
export interface DripInitOverrides {
  loadRows?: () => Promise<DripTagRow[]>;
  events?: Pick<EventEmitter, 'on' | 'removeListener'>;
  logger?: Logger;
}

// Model and site events after which the drip index may be stale. Tag
// attach/detach covers a post's tags changing; site.changed covers bulk edits
// and imports that write posts_tags without model events.
export const RELOAD_EVENTS = [
  'site.changed',
  'post.added',
  'post.edited',
  'post.deleted',
  'post.published',
  'post.unpublished',
  'post.tag.attached',
  'post.tag.detached',
  'page.added',
  'page.edited',
  'page.deleted',
  'page.tag.attached',
  'page.tag.detached',
  'tag.added',
  'tag.edited',
  'tag.deleted',
] as const;

let index: DripIndex | null = null;
let unsubscribe: (() => void) | null = null;
let initialising: Promise<void> | null = null;
const startsMemo = new WeakMap<object, AccessStarts | null>();

function config(): { get(key: string): unknown } {
  return require('../../../shared/config');
}

function defaultLogger(): Logger {
  return require('@tryghost/logging');
}

function siteTimezone(): string {
  try {
    const settingsCache = require('../../../shared/settings-cache');
    const timezone = settingsCache.get('timezone');
    return typeof timezone === 'string' && timezone ? timezone : 'Etc/UTC';
  } catch {
    return 'Etc/UTC';
  }
}

/**
 * `salvare:drip:mode` (env `salvare__drip__mode`), read on every call.
 * Unset → `advise` (plan §10: mechanism shipped, enforcement off). Unknown
 * values → `enforce`, which fails closed.
 */
export function getMode(): DripMode {
  const value = config().get('salvare:drip:mode');
  if (value === undefined || value === null || value === '') {
    return 'advise';
  }
  const normalised = String(value).trim().toLowerCase();
  if (normalised === 'enforce' || normalised === 'advise' || normalised === 'off') {
    return normalised;
  }
  return 'enforce';
}

/**
 * Refuses to boot in `enforce` when a shared response cache is on: both caches
 * key on tier/subscription or member uuid with no time component, so one
 * member's open lesson (or a stale lock) would be served to another. In
 * `advise` it only warns.
 */
function guardCaches(logger: Logger): void {
  const mode = getMode();
  if (mode === 'off') {
    return;
  }

  const enabled = ['cacheMembersContent:enabled', 'hostSettings:postsPublicCache:enabled'].filter(
    (key) => !!config().get(key),
  );
  if (!enabled.length) {
    return;
  }

  const message = `Salvare drip is unsafe with ${enabled.join(' and ')} on: cached responses would ignore drip dates.`;
  if (mode === 'enforce') {
    const errors = require('@tryghost/errors');
    throw new errors.IncorrectUsageError({
      message,
      help: 'Turn the cache off, or set salvare:drip:mode to advise or off.',
    });
  }
  logger.warn(
    `${message} Drip mode is advise, so nothing is locked; keep the cache off before enforcing.`,
  );
}

/**
 * Boot (awaited). Checks the cache guard, loads the drip index once and
 * subscribes to the events that can change it. Rejects if the guard trips or
 * the first load fails. Calling it again (a reboot in the same process, as the
 * e2e suites do) re-checks the guard and reloads without subscribing twice.
 */
export function init(overrides: DripInitOverrides = {}): Promise<void> {
  if (index) {
    const current = index;
    return (async () => {
      guardCaches(overrides.logger ?? defaultLogger());
      await current.reload();
    })();
  }
  if (initialising) {
    return initialising;
  }

  initialising = (async () => {
    const logger = overrides.logger ?? defaultLogger();
    guardCaches(logger);

    const loadRows = overrides.loadRows ?? (() => queryDripTagRows(require('../../data/db').knex));
    const candidate = new DripIndex({ loadRows, logger });

    // Subscribe before the first load, so a change made while it runs queues a
    // reload instead of being missed.
    const events = overrides.events ?? require('../../lib/common/events');
    const onChange = function salvareDripReload() {
      void candidate.reload();
    };
    for (const event of RELOAD_EVENTS) {
      events.on(event, onChange);
    }
    const stop = () => {
      for (const event of RELOAD_EVENTS) {
        events.removeListener(event, onChange);
      }
    };

    if (!(await candidate.reload())) {
      stop();
      const errors = require('@tryghost/errors');
      throw new errors.InternalServerError({ message: 'drip: the initial drip index load failed' });
    }

    unsubscribe = stop;
    index = candidate;
  })().finally(() => {
    initialising = null;
  });

  return initialising;
}

/** Tests only: unsubscribe and forget the index, so drip does nothing again. */
export function reset(): void {
  unsubscribe?.();
  unsubscribe = null;
  index?.clear();
  index = null;
  initialising = null;
}

/** Drip days for a post. null = not dripped, or the index isn't loaded (tests, before boot). */
export function getDripDays(postId: string): number | null {
  return index ? index.get(postId) : null;
}

/**
 * Access starts for a member, memoised per member object. See
 * access-starts.ts; null when the member carries neither `access_starts` nor
 * `productEvents`.
 */
export function computeAccessStarts(member: any): AccessStarts | null {
  if (!member || typeof member !== 'object') {
    return null;
  }
  if (startsMemo.has(member)) {
    return startsMemo.get(member) ?? null;
  }
  const starts = computeStarts(member);
  startsMemo.set(member, starts);
  return starts;
}

/** post needs id, visibility, tiers [{id, slug, type?}] */
export function evaluate(
  post: any,
  member: any,
  opts: { memberHasAccess: boolean; preview?: boolean; now?: Date },
): { access: boolean; unlockAt: string | null } {
  const days = getDripDays(post?.id);
  if (days === null) {
    return { access: opts.memberHasAccess, unlockAt: null };
  }

  const decision: DripDecision = evaluateDrip({
    post: post ?? {},
    member,
    getStarts: () => computeAccessStarts(member),
    days,
    mode: getMode(),
    memberHasAccess: opts.memberHasAccess,
    preview: !!opts.preview,
    now: opts.now ?? new Date(),
    timezone: siteTimezone(),
  });
  return decision;
}

/**
 * Used by post-gating.js. Sets `attrs.unlock_at` following the same `fields`
 * rule as `access`, and returns the new memberHasAccess.
 */
export function applyToPost(attrs: any, frame: any, memberHasAccess: boolean): boolean {
  if (!attrs || getDripDays(attrs.id) === null) {
    return memberHasAccess;
  }

  const result = evaluate(attrs, frame?.original?.context?.member ?? null, {
    memberHasAccess,
    preview: frame?.isPreview === true,
  });

  const options = frame?.options ?? {};
  if (
    result.unlockAt &&
    (!Object.prototype.hasOwnProperty.call(options, 'columns') ||
      (Array.isArray(options.columns) && options.columns.includes('unlock_at')))
  ) {
    attrs.unlock_at = result.unlockAt;
  }

  return result.access;
}
