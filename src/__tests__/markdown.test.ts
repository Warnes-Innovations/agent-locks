import { describe, expect, it } from 'vitest';
import { parseLockFile, serializeLockFile } from '../lock/markdown.js';
import type { ParsedLock } from '../lock/types.js';

const SAMPLE: ParsedLock = {
  frontmatter: {
    id: '2026-07-17T18-45-12-hindsight-route-tests',
    agent_id: 'subagent-4f2a',
    parent_agent_id: 'session-abc123',
    status: 'active',
    created: '2026-07-17T18-45-12',
    updated: '2026-07-17T18-45-12',
    scope: ['backend/src/hindsight/**', 'apps/web/app/hindsight/**'],
    repository: '/home/user/projects/my-app',
  },
  title: 'Add hindsight route tests',
  tasks: [
    { text: 'Write route unit tests', done: true },
    { text: 'Write integration test', done: false },
  ],
  notes: ['Started after checking for conflicts with lock X', 'Blocked briefly on a flaky fixture'],
};

describe('lock markdown round-tripping', () => {
  it('parseLockFile(serializeLockFile(x)) reproduces the same structured data', () => {
    const serialized = serializeLockFile(SAMPLE);
    const reparsed = parseLockFile(serialized);
    expect(reparsed).toEqual(SAMPLE);
  });

  it('serializes frontmatter with null agent_id/parent_agent_id and an unchecked task list', () => {
    const lock: ParsedLock = {
      frontmatter: {
        id: '2026-07-17T18-45-12-anonymous-lock',
        agent_id: null,
        parent_agent_id: null,
        status: 'active',
        created: '2026-07-17T18-45-12',
        updated: '2026-07-17T18-45-12',
        scope: ['**/*.ts'],
        repository: '/home/user/projects/my-app',
      },
      title: 'Anonymous work claim',
      tasks: [{ text: 'do the thing', done: false }],
      notes: [],
    };
    const serialized = serializeLockFile(lock);
    expect(serialized).toContain('agent_id: null');
    expect(serialized).toContain('parent_agent_id: null');
    expect(serialized).toContain('- [ ] do the thing');

    const reparsed = parseLockFile(serialized);
    expect(reparsed).toEqual(lock);
  });

  it('produces the exact documented file shape', () => {
    const serialized = serializeLockFile(SAMPLE);
    expect(serialized).toMatch(/^---\n/);
    expect(serialized).toContain('# Add hindsight route tests');
    expect(serialized).toContain('- [x] Write route unit tests');
    expect(serialized).toContain('- [ ] Write integration test');
    expect(serialized).toContain('## Notes');
    expect(serialized).toContain('- Started after checking for conflicts with lock X');
  });

  it('parses a hand-written file matching the README spec exactly (without repository field, for backward compat)', () => {
    const raw = `---
id: 2026-07-17T09-45-00-example-lock
agent_id: null
parent_agent_id: null
status: active
created: 2026-07-17T09-45-00
updated: 2026-07-17T09-45-00
scope:
  - glob/pattern/**
---

# Title

- [x] done task
- [ ] pending task

## Notes
- free text notes appended over time
`;
    const parsed = parseLockFile(raw);
    expect(parsed.title).toBe('Title');
    expect(parsed.tasks).toEqual([
      { text: 'done task', done: true },
      { text: 'pending task', done: false },
    ]);
    expect(parsed.notes).toEqual(['free text notes appended over time']);
    expect(parsed.frontmatter.scope).toEqual(['glob/pattern/**']);
  });
});

describe('parser aliasing', () => {
  it('returns an INDEPENDENT frontmatter object for identical raw text', () => {
    // gray-matter caches by raw string and hands back the cached object, so without
    // an explicit options argument two locks with identical text share one
    // frontmatter — and store.ts mutates frontmatter in place before writing. The
    // observable failure is a lock reporting a scope that was only ever set on a
    // different lock. Identical text is reachable in normal use: lock ids are
    // second-resolution, so same second + same title + same scope collide exactly.
    const raw = [
      '---',
      'id: 2026-09-04T02-07-17-some-work',
      'agent_id: null',
      'parent_agent_id: null',
      'status: active',
      'created: 2026-09-04T02-07-17',
      'updated: 2026-09-04T02-07-17',
      'scope:',
      '  - src/a/**',
      'repository: /tmp/fake-repo',
      '---',
      '',
      '# some work',
      '',
      '- [ ] first',
      '',
      '## Notes',
      '',
    ].join('\n');

    const first = parseLockFile(raw);
    const second = parseLockFile(raw);

    expect(first.frontmatter).not.toBe(second.frontmatter);
    first.frontmatter.scope = ['MUTATED/**'];
    expect(second.frontmatter.scope).toEqual(['src/a/**']);
  });
});
