// fork(salvare): API member context for theme helpers ({{#get}}, {{collection}}, {{prev_post}}/{{next_post}}).
//
// Those helpers pass the template `@member` as the Content API context member. `@member` has no products,
// so tier-gated posts always came back `access: false` (theme contract §5), and it has no drip access starts.
// This returns `@member` plus the session member's tier ids/slugs and its drip access starts, so in-process
// gating matches the post page (entry-lookup.js passes `res.locals.member`). Nothing new reaches `@member`
// itself; helper logs and the per-request dedupe key gain only ids, slugs and ISO dates.
import logging from '@tryghost/logging';
import type { AccessStarts } from '../../server/services/drip';

type ComputeAccessStarts = (member: unknown) => AccessStarts | null;

interface SessionMember {
  uuid?: string;
  products?: Array<{ id: string; slug: string }> | null;
}

/** The member passed as the Content API context: `@member`, plus `products` and `access_starts` when trimmed. */
export interface ApiMemberContext {
  uuid?: string;
  products?: Array<{ id: string; slug: string }>;
  access_starts?: AccessStarts;
  [key: string]: unknown;
}

export interface HelperData {
  member?: ApiMemberContext | null;
  root?: { _locals?: { member?: SessionMember | null } } | null;
}

// Through the frontend proxy (the only frontend → server seam), required lazily so loading this module
// never loads services/drip (and nothing cycles through it).
function dripComputeAccessStarts(member: unknown): AccessStarts | null {
  return require('../services/proxy').computeDripAccessStarts(member);
}

/**
 * @param data - the helper's `options.data` (or a frame created from it): `member` is `@member`, `root._locals`
 *   is `res.locals`
 * @param computeAccessStarts - injectable for unit tests; defaults to `services/drip` `computeAccessStarts`
 * @returns `@member` unchanged when there is no matching session member, otherwise a new object
 */
export function apiMemberContext(
  data: HelperData | undefined | null,
  computeAccessStarts: ComputeAccessStarts = dripComputeAccessStarts,
): ApiMemberContext | null {
  const member = data?.member ?? null;
  const session = data?.root?._locals?.member;

  if (!member || !session || !session.uuid || session.uuid !== member.uuid) {
    return member;
  }

  let accessStarts: AccessStarts | null = null;
  try {
    accessStarts = computeAccessStarts(session);
  } catch (err) {
    // Fails closed: without access starts drip treats a real member as locked (enforce) or open (advise).
    logging.error(err);
  }

  return {
    ...member,
    products: (session.products ?? []).map((p) => ({ id: p.id, slug: p.slug })),
    ...(accessStarts ? { access_starts: accessStarts } : {}),
  };
}
