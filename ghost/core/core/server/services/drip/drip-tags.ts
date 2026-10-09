// fork(salvare): drip. Parses `#drip-<n>` internal tags. See README.md.

/** Longest delay a drip tag can ask for, in days (about ten years). */
export const MAX_DRIP_DAYS = 3650;

// Parsed from the tag NAME, never the slug: the slug is not regenerated when a tag
// is renamed (#drip-3 → #drip-5 keeps `hash-drip-3`), the importer skips the
// `hash-` prefix, and a duplicate name gets a `-2` suffix.
const DRIP_TAG_NAME = /^#drip-(\d{1,5})$/i;

/** Days from one tag name, or null when the name is not a drip tag. */
export function parseDripTagName(name: unknown): number | null {
  if (typeof name !== 'string') {
    return null;
  }

  const match = DRIP_TAG_NAME.exec(name.trim());
  if (!match) {
    return null;
  }

  return Math.min(Number(match[1]), MAX_DRIP_DAYS);
}

export interface DripTagRow {
  post_id: string;
  name: string;
}

/** Builds the post id → days map from `(post_id, tag name)` rows. Rows that don't parse are ignored. */
export function buildDripDaysMap(rows: readonly DripTagRow[]): Map<string, number> {
  const days = new Map<string, number>();

  for (const row of rows) {
    const parsed = parseDripTagName(row.name);
    if (parsed === null || !row.post_id) {
      continue;
    }

    const current = days.get(row.post_id);
    if (current === undefined || parsed > current) {
      days.set(row.post_id, parsed);
    }
  }

  return days;
}
