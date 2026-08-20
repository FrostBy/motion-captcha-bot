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
    state.markKicking(-100, 9, 1000, 5000);
    state.markTemporarilyBanned(-100, 9, 6000);
    await state.flush();

    const revived = new State(file);
    revived.load();
    expect(revived.isPassed(-100, 7)).toBe(true);
    expect(revived.getPending(-100, 8)).toEqual({ answer: 12, deadline: 999, captchaMessageId: 5 });
    expect(revived.isKicking(-100, 9, 2000)).toBe(true);
    expect(revived.getTemporaryBan(-100, 9)).toBe(6000);
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

  it('serializes overlapping flushes', async () => {
    const file = tempFile();
    const state = new State(file);
    state.markPassed(-1, 1);
    const first = state.flush();
    state.markPassed(-1, 2);
    const second = state.flush();

    await Promise.all([first, second]);

    const revived = new State(file);
    revived.load();
    expect(revived.isPassed(-1, 1)).toBe(true);
    expect(revived.isPassed(-1, 2)).toBe(true);
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

  it('prunes expired kick markers during the regular sweep', async () => {
    const file = tempFile();
    const state = new State(file);
    state.markKicking(-1, 1, 100, 100);

    state.expired(200);
    await state.flush();

    expect(JSON.parse(readFileSync(file, 'utf8')).kicks).toEqual({});
  });

  it('finds and clears temporary bans due for an explicit unban', () => {
    const state = new State(tempFile());
    state.markTemporarilyBanned(-1, 1, 100);
    state.markTemporarilyBanned(-1, 2, 300);

    expect(state.expiredTemporaryBans(200)).toEqual([{ chatId: -1, userId: 1, until: 100 }]);
    state.clearTemporaryBan(-1, 1);

    expect(state.hasTemporaryBan(-1, 1)).toBe(false);
    expect(state.hasTemporaryBan(-1, 2)).toBe(true);
  });
});
