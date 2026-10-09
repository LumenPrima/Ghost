// fork(salvare): drip. Pure per-post rules. See README.md.
import { DateTime } from 'luxon';
import { toDate, type AccessStarts } from './access-starts';

export type DripMode = 'enforce' | 'advise' | 'off';

export interface DripDecision {
  access: boolean;
  /** ISO 8601 UTC, set only while the lesson is still closed for a member who otherwise has access. */
  unlockAt: string | null;
}

interface PostTier {
  id?: unknown;
  slug?: unknown;
  type?: unknown;
}

export interface DripPost {
  id?: unknown;
  visibility?: unknown;
  tiers?: PostTier[] | null;
}

export interface EvaluateDripInput {
  post: DripPost;
  member: unknown;
  /** Lazily computed access starts for `member`; called only when needed. */
  getStarts: () => AccessStarts | null;
  /** Drip days for the post (null = not dripped). */
  days: number | null;
  mode: DripMode;
  memberHasAccess: boolean;
  preview: boolean;
  now: Date;
  /** IANA zone of the site (`settingsCache.get('timezone')`). */
  timezone: string;
}

/**
 * Unlock time: the start of the access-start day in the site timezone plus N
 * calendar days. A lesson tagged `#drip-3` bought at 21:00 site-local on 6 Oct
 * opens at 00:00 site-local on 9 Oct. Calendar days (not 24-hour blocks) keep
 * that true across DST changes. An invalid zone falls back to UTC.
 */
export function unlockTime(start: Date, days: number, timezone: string): Date {
  let local = DateTime.fromJSDate(start, { zone: timezone || 'Etc/UTC' });
  if (!local.isValid) {
    local = DateTime.fromJSDate(start, { zone: 'Etc/UTC' });
  }
  return local.startOf('day').plus({ days }).toJSDate();
}

/** A real member has an id or uuid. Gift-link and preview shims have neither. */
export function isRealMember(member: unknown): boolean {
  if (!member || typeof member !== 'object') {
    return false;
  }
  const m = member as { id?: unknown; uuid?: unknown };
  return !!m.id || !!m.uuid;
}

/**
 * The access start for a `tiers` post: the earliest start over the tiers listed
 * on the post that the member holds. A listed free tier counts for a free
 * member (or one holding it) with signup as its start. No candidate → signup.
 */
export function startForPost(post: DripPost, member: unknown, starts: AccessStarts): Date | null {
  const candidates: Date[] = [];
  const status = (member as { status?: unknown } | null)?.status;

  for (const tier of Array.isArray(post.tiers) ? post.tiers : []) {
    if (!tier || typeof tier.id !== 'string') {
      continue;
    }

    const held = toDate(starts.products[tier.id]);
    if (held) {
      candidates.push(held);
    } else if (tier.type === 'free' && status === 'free') {
      const signup = toDate(starts.member);
      if (signup) {
        candidates.push(signup);
      }
    }
  }

  let start: Date | null = null;
  for (const candidate of candidates) {
    if (!start || candidate.getTime() < start.getTime()) {
      start = candidate;
    }
  }

  return start ?? toDate(starts.member);
}

const unchanged = (access: boolean): DripDecision => ({ access, unlockAt: null });

/**
 * Drip applies only to `visibility: 'tiers'` posts with drip days, for a member
 * who otherwise has access.
 *
 * - `off`, no days, `#drip-0`, no access, or another visibility → unchanged.
 * - A preview frame (staff preview shim) → open with `unlock = now + N days`.
 * - A shim (no id, no uuid) → unchanged.
 * - A real member whose starts can't be worked out → locked in `enforce`
 *   (fail closed), open in `advise`.
 * - Unlock time passed → open, no `unlockAt`.
 * - Otherwise `unlockAt` is set, and access is withheld only in `enforce`.
 */
export function evaluateDrip(input: EvaluateDripInput): DripDecision {
  const { post, member, days, mode, memberHasAccess, preview, now, timezone } = input;

  if (days === null || days <= 0 || mode === 'off') {
    return unchanged(memberHasAccess);
  }

  if (!memberHasAccess) {
    return unchanged(false);
  }

  if (post.visibility !== 'tiers') {
    return unchanged(true);
  }

  if (preview) {
    return { access: true, unlockAt: unlockTime(now, days, timezone).toISOString() };
  }

  if (!isRealMember(member)) {
    return unchanged(true);
  }

  const starts = input.getStarts();
  const start = starts ? startForPost(post, member, starts) : null;
  if (!start) {
    return unchanged(mode !== 'enforce');
  }

  const unlock = unlockTime(start, days, timezone);
  if (unlock.getTime() <= now.getTime()) {
    return unchanged(true);
  }

  return { access: mode !== 'enforce', unlockAt: unlock.toISOString() };
}
