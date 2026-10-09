# Drip

Salvare fork (`fork(salvare)`): lessons that open a number of days after a
member's access to the course starts. Vocabulary is in `CONTEXT.md`.

## How it works

1. **Drip days.** An internal tag named `#drip-<n>` on a post delays it by `n`
   days. The tag **name** is parsed (`/^#drip-(\d{1,5})$/i`), not the slug, so
   renamed, imported and `-2`-suffixed tags still work. Several drip tags → the
   largest; values are clamped to 3650; `#drip-0` means no delay.
2. **Index.** `init()` (awaited at boot) loads every `(post, #drip-* tag)` pair
   into an in-memory `Map<postId, days>` with one query. It reloads on exactly
   the events in `RELOAD_EVENTS` (`index.ts`): `site.changed`;
   `post.added`/`edited`/`deleted`/`published`/`unpublished`/`tag.attached`/`tag.detached`;
   `page.added`/`edited`/`deleted`/`tag.attached`/`tag.detached`; and
   `tag.added`/`edited`/`deleted`. The publish events are redundant (the index
   ignores status, and a status change also emits `*.edited`), which is why
   pages have none. Reloads are coalesced (one
   in flight plus one queued). A new map is swapped in only after a successful
   load; a failed reload keeps the old map and logs
   `drip.index_reload_failed`.
   - **Window:** model events fire after the transaction commits, so between a
     tag edit committing and the reload finishing (one small query) readers see
     the previous index. A lesson that just gained a drip tag can be served
     open for that moment.
   - Unit tests and anything that never calls `init()` see an empty index, so
     drip does nothing.
3. **Access starts.** `computeAccessStarts(member)` is pure and memoised per
   member object. Per held tier it takes the earliest of the latest `added`
   product event for that tier and the `start_date` of an active, real Stripe
   subscription on it (synthetic Complimentary/Gift subscriptions with `id: ''`
   are skipped), falling back to signup. Purchase grants write an `added`
   event, so purchases are covered; migrated buyers need a backdated `added`
   event (Phase 4). A member that already carries `access_starts` (the trimmed
   theme-helper context) is used as is; one with neither `access_starts` nor
   `productEvents` gives null.
4. **Rules** (`drip-rules.ts`). Drip applies only to `visibility: 'tiers'`
   posts, for a member who otherwise has access:
   - The start is the earliest start over the post's tiers the member holds (a
     listed free tier counts for a free member, from signup); no candidate →
     signup.
   - Unlock = start of the start day in the site timezone
     (`settingsCache.get('timezone')`) plus `n` calendar days. `#drip-3` bought
     6 Oct 21:00 site-local opens 9 Oct 00:00 site-local, DST included.
   - `unlock <= now` → open, no `unlock_at`.
   - Otherwise `unlock_at` (ISO 8601 UTC) is set, and in `enforce` the body is
     withheld (`access: false`, `comments: false`, the `{{content}}` CTA).
   - **Fail closed:** a real member (with an `id` or `uuid`) whose starts can't
     be worked out is locked in `enforce` (no `unlock_at`) and open in `advise`.
   - Shims without id or uuid (gift links, previews) keep their access. A
     preview frame (`frame.isPreview`) gets `access: true` and
     `unlock_at = today + n days`, so staff see the drip notice.
5. **Gating hunk.** `post-gating.js` `forPost` calls `applyToPost` right after
   `checkPostAccess`. Every theme surface (entry page, `{{#get}}`,
   `{{collection}}`, prev/next, RSS, `.md`, the email web view) goes through
   it. `unlock_at` follows the same `fields` rule as `access`: it appears only
   when `fields` is not sent or lists `unlock_at`. The HTTP Content API has no
   member session, so it never carries `unlock_at`.

## Interface (`index.ts`)

```ts
export type DripMode = 'enforce' | 'advise' | 'off';
export interface AccessStarts { member: string | null; products: Record<string, string> } // ISO 8601 UTC
export function init(): Promise<void>;
export function getMode(): DripMode;
export function getDripDays(postId: string): number | null;
export function computeAccessStarts(member: any): AccessStarts | null;
export function evaluate(post, member, opts: {memberHasAccess: boolean; preview?: boolean; now?: Date}):
  {access: boolean; unlockAt: string | null};
export function applyToPost(attrs, frame, memberHasAccess: boolean): boolean;
```

`reset()` exists for tests only. `index.ts` requires config, settings, events,
logging and the database lazily; it must never require members, api or models
at the top level (post-gating.js loads it while the API layer loads).

## Configuration

- `salvare:drip:mode` (env `salvare__drip__mode`), read on every call:
  - `advise` (**default**, plan §10 "mechanism shipped, enforcement off"):
    `unlock_at` is shown, nothing is locked.
  - `enforce`: dripped lessons are locked until they open. **Production must
    set `salvare__drip__mode=enforce` to lock lessons.**
  - `off`: drip does nothing.
  - Any other value is treated as `enforce` (fail closed).
- **Cache guard.** In `enforce`, boot refuses to start when
  `cacheMembersContent:enabled` or `hostSettings:postsPublicCache:enabled` is
  on: their keys have no drip or time component. In `advise` it only warns.

## Not drip-enforced (v1)

- Newsletters: segment rendering has no per-member starts. **Don't email
  lessons.**
- Comments: reads and writes through the comments API check tiers only. The
  comments UI is hidden on a locked lesson (`comments: false`), but its thread
  is readable through the API.
- Machine-payments `.md`: a paid agent fetch bypasses tiers and drip. **Keep
  machine payments off.**
- Keep `cacheMembersContent` off (see the cache guard).
- Pages go through the same gating, so a dripped `tiers` page would drip too;
  lessons are posts.
