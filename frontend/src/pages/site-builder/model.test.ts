import { describe, expect, it } from 'vitest';
import {
  addReport,
  applyEvent,
  changeSummary,
  clampSplit,
  fixPrompt,
  fromStored,
  readReport,
  startTurn,
  tileHue,
  versionLabel,
} from './model';

describe('turns', () => {
  it('rebuilds saved turns, with restore notes and what each changed', () => {
    const turns = fromStored([
      {
        prompt: 'A page',
        reply: 'Built it.',
        model: 'claude-haiku-5-5',
        time: 1,
        changed: [{ path: 'index.html', change: 'added' }],
        version: 1,
        cost: 0.01,
      },
      { kind: 'restore', prompt: '', reply: 'Restored version 1.', model: '', time: 2, version: 3 },
      { prompt: 'An old turn', reply: 'Done.', model: 'claude-haiku-5-5', time: 3 }, // saved before changes were recorded
    ]);
    expect(turns.map((t) => t.kind)).toEqual(['message', 'restore', 'message']);
    expect(turns[0].changed).toHaveLength(1);
    expect(turns[1].version).toBe(3);
    expect(turns[2].changed).toEqual([]);
    expect(turns[2].version).toBeNull();
    expect(new Set(turns.map((t) => t.id)).size).toBe(3);
  });

  it('streams the reply, then takes the changes and the version from the end of the turn', () => {
    let t = startTurn('Make it teal', 'claude-haiku-5-5');
    t = applyEvent(t, { type: 'text', text: 'Changing ' }, 'Haiku');
    t = applyEvent(t, { type: 'text', text: 'the colour.' }, 'Haiku');
    expect(t.draft).toBe('Changing the colour.');
    t = applyEvent(
      t,
      {
        type: 'tool',
        id: 'x',
        tool: 'edit_file',
        path: 'css/site.css',
        ok: true,
        detail: 'Edited css/site.css',
        files: [],
      },
      'Haiku',
    );
    t = applyEvent(
      t,
      {
        type: 'files',
        files: [],
        cost: 0.002,
        spent_usd: 0.1,
        changed: [{ path: 'css/site.css', change: 'changed' }],
        version: 4,
      },
      'Haiku',
    );
    expect(t.reply).toBe('Changing the colour.');
    expect(t.draft).toBe('');
    expect(t.version).toBe(4);
    expect(t.changed[0].path).toBe('css/site.css');
    expect(t.steps.map((s) => s.kind)).toEqual(['write']);
  });

  it('marks a failed tool call and an error event', () => {
    let t = startTurn('x', 'm');
    t = applyEvent(
      t,
      { type: 'tool', id: 'x', tool: 'write_file', path: '../a.html', ok: false, detail: 'not inside the site' },
      'M',
    );
    expect(t.steps[0]).toMatchObject({ kind: 'error', detail: 'not inside the site' });
    t = applyEvent(t, { type: 'error', message: 'Claude declined this request.' }, 'M');
    expect(t.state).toBe('error');
  });

  it('summarises changes briefly', () => {
    expect(changeSummary([])).toBe('No files changed');
    expect(changeSummary([{ path: 'a.html', change: 'added' }])).toBe('1 file: a.html');
    expect(
      changeSummary([
        { path: 'a', change: 'added' },
        { path: 'b', change: 'changed' },
        { path: 'c', change: 'deleted' },
        { path: 'd', change: 'added' },
      ]),
    ).toBe('4 files: a, b and 2 more');
  });
});

describe('errors from the running app', () => {
  it('accepts only the reporter’s shape, and cuts long text', () => {
    expect(readReport({ labSiteError: 1, kind: 'error', message: 'x is not defined', where: 'app.js:3' })).toEqual({
      kind: 'error',
      message: 'x is not defined',
      where: 'app.js:3',
    });
    expect(readReport({ labSiteError: 1, kind: 'console', message: 'a'.repeat(900) })?.message).toHaveLength(500);
    for (const bad of [
      null,
      'text',
      { kind: 'error', message: 'no marker' },
      { labSiteError: 1, kind: 'script', message: 'x' },
      { labSiteError: 1, kind: 'error', message: '  ' },
      { labSiteError: 1, kind: 'error', message: 5 },
    ]) {
      expect(readReport(bad)).toBeNull();
    }
  });

  it('counts repeats and keeps at most twenty', () => {
    let list = addReport([], { kind: 'error', message: 'boom', where: 'a.js:1' });
    list = addReport(list, { kind: 'error', message: 'boom', where: 'a.js:1' });
    expect(list).toHaveLength(1);
    expect(list[0].count).toBe(2);
    for (let i = 0; i < 30; i++) list = addReport(list, { kind: 'console', message: `m${i}`, where: '' });
    expect(list).toHaveLength(20);
  });

  it('writes a fix request that lists the errors', () => {
    const text = fixPrompt([{ kind: 'error', message: 'tides is not defined', where: 'app.js:12', count: 3 }]);
    expect(text).toContain('- tides is not defined (app.js:12) ×3');
    expect(text).toMatch(/fix it\.$/);
  });
});

describe('layout helpers', () => {
  it('keeps both panes usable when the divider is dragged', () => {
    expect(clampSplit(100, 1400)).toBe(300);
    expect(clampSplit(1300, 1400)).toBe(1040);
    expect(clampSplit(500, 1400)).toBe(500);
    expect(clampSplit(500, 500)).toBe(300); // a narrow window: the chat keeps its minimum
  });

  it('labels versions and colours tiles the same way every time', () => {
    const v = { n: 3, label: 'Make the header sticky', time: 1_795_000_000, files: 4 };
    expect(versionLabel(v, 3)).toMatch(/^v3 \(current\) · Make the header sticky · \d\d:\d\d$/);
    expect(versionLabel(v, 5)).toMatch(/^v3 · /);
    expect(tileHue('abc123def456')).toBe(tileHue('abc123def456'));
    expect(tileHue('abc123def456')).toBeGreaterThanOrEqual(0);
  });
});

describe('a turn whose files were not kept as a version', () => {
  it('carries the reason from the stream and from the stored turn', () => {
    const t = applyEvent(
      startTurn('x', 'm'),
      { type: 'files', files: [], cost: 0, spent_usd: 0, version: null, snapshot_error: 'not kept: disk full' },
      'M',
    );
    expect(t.snapshotError).toBe('not kept: disk full');
    expect(
      fromStored([{ prompt: 'x', reply: 'y', model: 'm', time: 1, snapshot_error: 'not kept' }])[0].snapshotError,
    ).toBe('not kept');
  });
});
