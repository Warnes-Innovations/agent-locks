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
 * Parses a full lock file (frontmatter + body) already read from disk.
 *
 * THE `{}` PASSED TO `matter` IS LOAD-BEARING — do not "simplify" it away.
 *
 * gray-matter keeps a process-wide cache keyed on the raw input string, and it
 * returns the CACHED OBJECT rather than a copy. It consults that cache only when
 * called with no options, so passing any options object bypasses it.
 *
 * Without the bypass, two lock files whose raw text happens to be identical share
 * one frontmatter object — and store.ts mutates `record.frontmatter` in place
 * before writing. So a mutation to one lock silently appears on the other, and a
 * re-read returns the mutated object instead of what is actually on disk. Identical
 * text is not exotic: ids are second-resolution, so two locks created in the same
 * second with the same title and scope collide exactly.
 *
 * Found 2026-09-04 by the scope-mutation tests, which reported a lock's scope as a
 * value that only ever existed in a different test's lock.
 */
export function parseLockFile(raw: string): ParsedLock {
  const { data, content } = matter(raw, {});
  const frontmatter = data as LockFrontmatter;
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
