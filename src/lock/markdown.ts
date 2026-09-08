/**
 * Module: markdown + YAML-frontmatter serialization for lock files.
 *
 * agent-locks owns this schema entirely — calling agents never construct or
 * pass raw markdown; they pass structured tool arguments and this module is
 * the only place that turns them into (or back out of) the on-disk format.
 *
 * File shape (see README for the full spec):
 *
 *   ---
 *   id: 2026-07-17T18-45-12-hindsight-route-tests
 *   agent_id: subagent-4f2a
 *   parent_agent_id: null
 *   status: active
 *   created: 2026-07-17T18-45-12
 *   updated: 2026-07-17T18-45-12
 *   scope:
 *     - glob/pattern/**
 *   ---
 *
 *   # Title
 *
 *   - [x] done task
 *   - [ ] pending task
 *
 *   ## Notes
 *   - free text notes appended over time
 */
import matter from 'gray-matter';
import { TIMESTAMP_RE } from '../timestamp.js';
import type { LockFrontmatter, LockTask, ParsedLock } from './types.js';

const NOTES_HEADING = '## Notes';
const TASK_LINE_RE = /^- \[([ xX])\] (.*)$/;
const TITLE_LINE_RE = /^# (.*)$/;

interface Body {
  title: string;
  tasks: LockTask[];
  notes: string[];
}

function parseBody(content: string): Body {
  const lines = content.split(/\r?\n/);
  let title = '';
  const tasks: LockTask[] = [];
  const notes: string[] = [];
  let section: 'title' | 'tasks' | 'notes' = 'title';

  for (const line of lines) {
    if (section === 'title') {
      const titleMatch = TITLE_LINE_RE.exec(line);
      if (titleMatch) {
        title = titleMatch[1].trim();
        section = 'tasks';
        continue;
      }
      // Skip blank lines before the title heading appears.
      continue;
    }

    if (line.trim() === NOTES_HEADING) {
      section = 'notes';
      continue;
    }

    if (section === 'tasks') {
      const taskMatch = TASK_LINE_RE.exec(line);
      if (taskMatch) {
        tasks.push({ done: taskMatch[1].toLowerCase() === 'x', text: taskMatch[2].trim() });
      }
      // Blank lines and anything else between title and "## Notes" are ignored.
      continue;
    }

    if (section === 'notes') {
      if (line.startsWith('- ')) {
        notes.push(line.slice(2).trim());
      }
      // Blank lines after the Notes heading are ignored.
    }
  }

  return { title, tasks, notes };
}

function serializeBody(body: Body): string {
  const lines: string[] = [`# ${body.title}`, ''];
  for (const task of body.tasks) {
    lines.push(`- [${task.done ? 'x' : ' '}] ${task.text}`);
  }
  lines.push('', NOTES_HEADING);
  for (const note of body.notes) {
    lines.push(`- ${note}`);
  }
  // Trailing newline so the file ends cleanly.
  return lines.join('\n') + '\n';
}

/**
 * Passed to every matter() call to DEFEAT gray-matter's content-keyed parse
 * cache. Do not remove it as a redundant empty object.
 *
 * Called as plain `matter(raw)` with no options, gray-matter memoizes the result
 * under the input string and returns `Object.assign({}, cached)` on a hit —
 * a SHALLOW copy, so the returned `.data` is the very same frontmatter object
 * every previous caller got. Every mutation this module's callers make to
 * `record.frontmatter` (store.ts bumps `updated` on each write, flips
 * `status` on finish, appends to `scope_history` on a scope amendment) then
 * writes straight into that cache entry, and the next parse of a
 * byte-identical file hands out frontmatter already carrying another lock's
 * changes. Passing ANY options object takes gray-matter's non-caching path.
 *
 * The failure is invisible while every mutation merely overwrites a scalar
 * with a fresh value; it surfaced the moment `scope_history` started
 * ACCUMULATING, as locks inheriting amendment history they never had.
 */
const NO_CACHE: Record<string, never> = {};

export class MalformedLockFileError extends Error {
  constructor(reason: string, filePath?: string) {
    super(
      `agent-locks: ${filePath ? `lock file "${filePath}"` : 'lock file'} is malformed and was NOT used: ${reason}. ` +
        `Refusing to treat it as a valid lock: a partially-written or hand-edited lock file parses into a SMALLER claim ` +
        `rather than an error (a truncated YAML list does not fail, it shortens), which would silently hide whatever ` +
        `the missing part claimed. Inspect or delete the file.`,
    );
    this.name = 'MalformedLockFileError';
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

/**
 * Rejects frontmatter that is not a well-formed lock.
 *
 * WHY THIS IS NOT PARANOIA, and why the `as LockFrontmatter` cast it replaces
 * was the mechanism rather than a shortcut: a damaged lock file used to parse
 * into an object with `undefined` where a required field belonged, and then
 * fail far away — "TypeError: b is not iterable" from inside a glob matcher, an
 * error naming no file, taking every lock in the repository offline for every
 * agent until a human found the bad one. Each field checked here is one whose
 * absence either changes what the lock claims or crashes a reader.
 *
 * WHAT THIS DELIBERATELY DOES NOT CATCH — do not read it as more than it is.
 * YAML truncation degrades instead of failing: a file cut mid-`scope:` list
 * yields `scope: ["legacy/**", "gr"]`, a non-empty list of strings that is
 * structurally perfect and semantically mutilated. No validator can distinguish
 * that from a lock which really claims those globs, because nothing records how
 * long the list should have been. The defence against THAT case is not here —
 * it is writeRecord's temp+rename in store.ts, which ensures a reader never
 * observes a partially-written file at all. Both are needed; neither covers the
 * other. (Pinned by a test that asserts this limit rather than hiding it.)
 */
function validateFrontmatter(data: unknown, filePath?: string): LockFrontmatter {
  if (typeof data !== 'object' || data === null) {
    throw new MalformedLockFileError('its YAML frontmatter is missing or is not a mapping', filePath);
  }
  const fm = data as Record<string, unknown>;
  if (typeof fm.id !== 'string' || fm.id === '') {
    throw new MalformedLockFileError('`id` is missing or not a non-empty string', filePath);
  }
  if (fm.status !== 'active' && fm.status !== 'done') {
    throw new MalformedLockFileError(`\`status\` is ${JSON.stringify(fm.status)}, expected "active" or "done"`, filePath);
  }
  for (const field of ['created', 'updated'] as const) {
    if (typeof fm[field] !== 'string' || !TIMESTAMP_RE.test(fm[field] as string)) {
      throw new MalformedLockFileError(`\`${field}\` is missing or not a YYYY-MM-DDTHH-MM-SS timestamp`, filePath);
    }
  }
  if (!isStringArray(fm.scope) || fm.scope.length === 0) {
    throw new MalformedLockFileError(
      '`scope` is missing, empty, or not a list of strings — this is the field a truncated write mutilates silently',
      filePath,
    );
  }
  if (fm.scope_history !== undefined) {
    const history = fm.scope_history;
    // A wrong-shaped history must be REFUSED, never coerced to []. Coercing
    // would discard a real history; and store.ts spreads this value when
    // amending, so a malformed one there is written back WORSE than it was
    // found (a string spreads into one entry per character, permanently).
    if (
      !Array.isArray(history) ||
      !history.every(
        (entry) =>
          typeof entry === 'object' &&
          entry !== null &&
          typeof (entry as Record<string, unknown>).replaced_at === 'string' &&
          isStringArray((entry as Record<string, unknown>).scope),
      )
    ) {
      throw new MalformedLockFileError(
        '`scope_history` is present but is not a list of {replaced_at, scope} entries',
        filePath,
      );
    }
  }
  return fm as unknown as LockFrontmatter;
}

/**
 * Parses a full lock file (frontmatter + body) already read from disk.
 * `filePath` is used only to name the file in an error — pass it whenever known.
 */
export function parseLockFile(raw: string, filePath?: string): ParsedLock {
  const { data, content } = matter(raw, NO_CACHE);
  const frontmatter = validateFrontmatter(data, filePath);
  const body = parseBody(content);
  return {
    frontmatter,
    title: body.title,
    tasks: body.tasks,
    notes: body.notes,
  };
}

/** Serializes a ParsedLock back into the full file contents (frontmatter + body). */
export function serializeLockFile(parsed: ParsedLock): string {
  const body = serializeBody({ title: parsed.title, tasks: parsed.tasks, notes: parsed.notes });
  // gray-matter's stringify takes the body content and the frontmatter data
  // object and re-serializes both consistently (this is also what
  // guarantees round-tripping: parseLockFile(serializeLockFile(x)) === x).
  return matter.stringify(body, parsed.frontmatter as unknown as Record<string, unknown>);
}
