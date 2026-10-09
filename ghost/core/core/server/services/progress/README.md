# Progress

Salvare fork (`fork(salvare)`): a member's progress through lessons, stored in
`members_post_progress` (one row per member and post, `started` or
`completed`). The theme reads it on lesson and course pages and writes it when a
member opens a lesson or ticks "Mark lesson complete".

Knex only: no Bookshelf model. `index.ts` builds the service at boot
(`init()`, called from `core/boot.js`).

## HTTP interface (members API)

Both routes need a member session; signed out they answer 401
`You must be signed in to do this.`

```
GET /members/api/progress/?post_id=<id>    # also ?post=<id>
GET /members/api/progress/?tag=<tag slug>  # every post carrying the tag
200 {"progress": [{"post_id": "...", "status": "completed", "updated_at": "<ISO 8601 UTC>"}]}

PUT /members/api/progress/
{"progress": [{"post_id": "...", "status": "started" | "completed"}]}
200 {"progress": [...the rows as now stored...]}
```

- Posts with no row are omitted. `created_at` is stored (when the member first
  started) but not returned.
- GET needs exactly one of `post_id`/`post` and `tag`. `post_id` and `post` may
  both be sent only when they name the same post. Anything else is 422.
- `post_id`, `post` and `tag` are listed in the public query parameter policy
  (`web/query-parameter-policy/policy.json`). Without that, sites with
  `queryParameterFiltering:enabled` (the test configs, Ghost(Pro)-style hosts)
  strip them before the route runs and every GET answers 422.
- GET returns the member's own rows whatever their current access: a row only
  exists for a post that passed the write check, and losing access later does
  not erase what the member did.
- PUT accepts 1 to 100 items and no other keys (422 otherwise), in a body of at
  most 100 kB. Malformed JSON is 400, from the body parser. Ids are lowercased,
  and a post sent twice keeps its last entry.
- PUT is all or nothing. An unknown, draft, scheduled or page id refuses the
  whole batch with 404 `POST_NOT_FOUND`; a post the member cannot read refuses
  it with 403 `POST_LOCKED`. 404 wins when both apply. Nothing is written
  unless every post passes. A post deleted between the access check and the
  write fails a foreign key, which the repository also reports as 404
  `POST_NOT_FOUND` (an unpublish in that window still writes a row).
- Rows are written in post id order, whatever the request order, so two
  concurrent batches from one member take InnoDB locks in the same order and
  cannot deadlock each other.
- `tag` is trimmed and lowercased (Ghost stores slugs lowercase), so MySQL and
  SQLite match the same rows.
- `started` after `completed` (the member un-ticks a lesson) is stored.
- No rate limiter in v1. Writes are bounded by the item and size caps,
  idempotent, and scoped to the caller. Each PUT does a full member read (the
  same one a themed page view does) plus two small post queries.

## Access check

`progress-access.ts` decides whether a member may write progress on a post, the
way the comments service decides whether a member may comment:

1. Load the published posts (`type: post`, `status: published`) by id, with
   their tiers from `posts_products`, through Knex
   (`ProgressKnexRepository.getPublishedPosts`). Knex rather than the Post
   model: `checkPostAccess` only reads `visibility` and `tiers[].slug`, and
   `drip.evaluate` reads `id`, `visibility` and `tiers[].id`, so the model's
   relations and serializers add nothing but queries. For a `tiers` post the
   tiers are narrowed to paid tiers, as the Content API's posts mapper does, so
   the answer matches what the member sees on the page.
2. `membersService.contentGating.checkPostAccess(post, member)`, where `member`
   is the bread member (`memberBREADService.read`), the same shape as the
   session member a page renders with.
3. `drip.evaluate(post, member, {memberHasAccess, now})`. A drip-locked lesson
   is locked here in `enforce` mode and open in `advise` and `off` modes,
   exactly as on the page. One `now` is used for the whole batch.

Known gap: a legacy post whose `visibility` is a raw NQL filter (for example
`product:a,product:b`, which current Admin no longer writes) is gated here on
that filter, but drip skips it, because drip applies only to `tiers` posts. The
Content API mapper rewrites such a post to `tiers` first, so the page can show
it drip-locked while progress accepts writes. Lessons use `tiers`.

Every dependency is a lazy closure, because boot runs `init()` before the members
service exists, and `services/drip` sits on the post-gating import chain.

## Files

| File                          | Contents                                                                    |
| ----------------------------- | --------------------------------------------------------------------------- |
| `progress-schema.ts`          | Zod schemas for the PUT body and GET query; row types                       |
| `progress-knex-repository.ts` | Reads and upserts `members_post_progress`; loads published posts with tiers |
| `progress-access.ts`          | `ProgressAccessChecker`: per post `ok`, `not_found` or `locked`             |
| `progress-service.ts`         | Validation, deduplication, the all-or-nothing write                         |
| `index.ts`                    | Composition root (`init()`, `service`)                                      |

The controller is `api/endpoints/progress-members.ts` and the routes are
`web/members/progress/routes.ts`, mounted at `/members/api/progress` in
`web/members/app.js`.
