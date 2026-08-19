import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { State } from './state.js';

const dirs: string[] = [];
function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'antispam-'));
  dirs.push(dir);
  return join(dir, 'state.json');
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('state snapshot', () => {
  it('changes reach the disk and come back', async () => {
    const file = tempFile();
    const state = new State(file);
    state.markPassed(-100, 7);
    state.setPending(-100, 8, { answer: 12, deadline: 999, captchaMessageId: 5 });
    await state.flush();

    const revived = new State(file);
    revived.load();
    expect(revived.isPassed(-100, 7)).toBe(true);
    expect(revived.getPending(-100, 8)).toEqual({ answer: 12, deadline: 999, captchaMessageId: 5 });
  });

  it('does not touch the disk when nothing changed', async () => {
    const file = tempFile();
    const state = new State(file);
    state.markPassed(-1, 1);
    await state.flush();
    const before = readFileSync(file, 'utf8');

    await state.flush();
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('a corrupt snapshot means an empty start with a warning, not a crash', () => {
    const file = tempFile();
    writeFileSync(file, '{oops');
    const warn = vi.fn();

    const state = new State(file);
    state.load(warn);

    expect(state.isPassed(-1, 1)).toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  it('finds the expired, leaves the fresh alone', () => {
    const state = new State(tempFile());
    state.setPending(-1, 1, { answer: 5, deadline: 100, captchaMessageId: 1 });
    state.setPending(-1, 2, { answer: 6, deadline: 300, captchaMessageId: 2 });

    const expired = state.expired(200);
    expect(expired.map((e) => e.userId)).toEqual([1]);
  });
});
