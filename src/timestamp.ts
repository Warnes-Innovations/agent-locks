/**
 * Canonical timestamp formatting for agent-locks.
 *
 * Design decision (documented in README "Timestamp format"): we use a single
 * format everywhere a timestamp appears — the lock filename prefix, the
 * frontmatter `id` field, and the frontmatter `created`/`updated` fields —
 * so there is never a mismatch between "what the file is called" and "what
 * the file says about itself".
 *
 * Format: `YYYY-MM-DDTHH-MM-SS` in UTC, e.g. `2026-07-17T18-45-12`.
 *
 * Why this exact shape:
 * - ISO 8601's `:` separators in the time portion are awkward or outright
 *   forbidden in filenames on some filesystems (notably Windows/NTFS), so we
 *   replace them with `-`. The date portion keeps its `-` separators (those
 *   were never a problem) purely for human readability — there is no
 *   functional reason a fully-dashed `2026-07-17T18-45-12` is worse than a
 *   fully-compact `20260717T184512`, and the dashed form is easier to read
 *   at a glance in a directory listing.
 * - Seconds precision (not just hours:minutes) keeps collisions between two
 *   locks created in quick succession rare, without needing milliseconds.
 * - UTC (not local time) means two agents on different machines in
 *   different timezones produce directly comparable, sortable timestamps.
 * - Because every field uses fixed-width, zero-padded components in the
 *   same order, plain string sorting of filenames or `id` values is
 *   equivalent to chronological sorting.
 */
export function formatTimestamp(date: Date = new Date()): string {
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
  const year = date.getUTCFullYear();
  const month = pad(date.getUTCMonth() + 1);
  const day = pad(date.getUTCDate());
  const hours = pad(date.getUTCHours());
  const minutes = pad(date.getUTCMinutes());
  const seconds = pad(date.getUTCSeconds());
  return `${year}-${month}-${day}T${hours}-${minutes}-${seconds}`;
}

const TIMESTAMP_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})$/;

/**
 * The inverse of formatTimestamp. Needed for staleness math (comparing a
 * lock's `updated` field against "now"): a plain `new Date(str)` cannot
 * parse this format reliably, since the dashed time portion isn't valid
 * ISO 8601 and carries no explicit UTC marker for the runtime to key off.
 *
 * Throws on malformed input rather than returning an Invalid Date, so a
 * corrupted or hand-edited frontmatter field fails loudly instead of
 * silently comparing as "always stale" or "never stale".
 */
export function parseTimestamp(value: string): Date {
  const match = TIMESTAMP_RE.exec(value);
  if (!match) {
    throw new Error(`agent-locks: "${value}" is not a valid agent-locks timestamp (expected YYYY-MM-DDTHH-MM-SS).`);
  }
  const [, year, month, day, hours, minutes, seconds] = match;
  return new Date(
    Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hours), Number(minutes), Number(seconds)),
  );
}

/**
 * Turns a free-text title into a filesystem- and URL-safe kebab-case slug.
 * Used to build both the lock filename and its `id` frontmatter field.
 */
export function slugify(title: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'untitled';
}
