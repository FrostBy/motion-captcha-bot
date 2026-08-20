import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_MESSAGES } from './config.js';
import {
  onJoin,
  onMessage,
  onSeenInside,
  sweepExpired,
  type ChatMemberStatus,
  type Deps,
} from './handlers.js';
import { State } from './state.js';

vi.mock('./captcha.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./captcha.js')>()),
  // No ffmpeg in unit tests: this file checks the greeting logic, not rendering.
  renderAnimation: vi.fn(async () => new Uint8Array([71, 73, 70])),
  makeExpression: vi.fn(() => ({ question: '2+3', answer: 5 })),
  makeDecoy: vi.fn(() => ({ question: '4+4', answer: 8 })),
}));

const dirs: string[] = [];

function setup(now = 1_000_000): { deps: Deps; api: Record<string, ReturnType<typeof vi.fn>> } {
  const dir = mkdtempSync(join(tmpdir(), 'antispam-h-'));
  dirs.push(dir);
  const api = {
    sendAnimation: vi.fn(async () => ({ message_id: 100 })),
    sendMessage: vi.fn(async () => ({ message_id: 200 })),
    deleteMessage: vi.fn(async () => true),
    banChatMember: vi.fn(async () => true),
    unbanChatMember: vi.fn(async () => true),
    getChatMember: vi.fn(
      async (): Promise<{ status: ChatMemberStatus }> => ({ status: 'member' }),
    ),
  };
  const deps: Deps = {
    api,
    state: new State(join(dir, 's.json')),
    timeoutSec: 60,
    ffmpegPath: 'ffmpeg',
    captchaStyle: 'l',
    captchaMotion: 1,
    captchaSprinkle: 0,
    captchaDecoy: false,
    captchaMaxAttempts: 3,
    allowedBotIds: new Set(),
    messages: DEFAULT_MESSAGES,
    log: vi.fn(),
    now: () => now,
  };
  return { deps, api };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.clearAllMocks();
});

const CHAT = -100500;
const guest = { id: 7, isBot: false, firstName: 'Guest', addedBy: 7 };

describe('newcomer greeting', () => {
  it('sends the captcha and sets a deadline', async () => {
    const { deps, api } = setup();

    await onJoin(deps, CHAT, guest);

    expect(api.sendAnimation).toHaveBeenCalledOnce();
    const caption = api.sendAnimation!.mock.calls[0]![2] as string;
    expect(caption).toContain('<a href="tg://user?id=7">Guest</a>');
    expect(caption).toContain('60');
    expect(deps.state.getPending(CHAT, 7)).toMatchObject({
      answer: 5,
      deadline: 1_000_000 + 60_000,
      captchaMessageId: 100,
    });
  });

  it('lets a previously passed user in without a captcha', async () => {
    const { deps, api } = setup();
    deps.state.markPassed(CHAT, 7);

    await onJoin(deps, CHAT, guest);

    expect(api.sendAnimation).not.toHaveBeenCalled();
  });

  it('correct answer: welcome, cleanup, passed status', async () => {
    const { deps, api } = setup();
    await onJoin(deps, CHAT, guest);

    await onMessage(deps, CHAT, 7, 555, ' 5 ');

    expect(deps.state.isPassed(CHAT, 7)).toBe(true);
    expect(api.deleteMessage).toHaveBeenCalledWith(CHAT, 555);
    expect(api.deleteMessage).toHaveBeenCalledWith(CHAT, 100);
    expect(api.sendMessage).toHaveBeenCalledOnce();
  });

  it('wrong answers and newcomer chatter get deleted', async () => {
    const { deps, api } = setup();
    await onJoin(deps, CHAT, guest);

    await onMessage(deps, CHAT, 7, 556, 'hello everyone');

    expect(api.deleteMessage).toHaveBeenCalledWith(CHAT, 556);
    expect(deps.state.isPassed(CHAT, 7)).toBe(false);
  });

  it('answering the decoy kicks instantly', async () => {
    const { deps, api } = setup();
    deps.captchaDecoy = true;
    await onJoin(deps, CHAT, guest);

    await onMessage(deps, CHAT, 7, 557, '8');

    expect(api.banChatMember).toHaveBeenCalledWith(CHAT, 7);
    expect(api.deleteMessage).toHaveBeenCalledWith(CHAT, 557);
    expect(api.deleteMessage).toHaveBeenCalledWith(CHAT, 100);
    expect(deps.state.getPending(CHAT, 7)).toBeUndefined();
    expect(deps.state.isPassed(CHAT, 7)).toBe(false);
  });

  it('a message from a non-pending user marks them as passed', async () => {
    const { deps, api } = setup();

    await onMessage(deps, CHAT, 42, 600, 'just a regular day');

    expect(deps.state.isPassed(CHAT, 42)).toBe(true);
    expect(api.deleteMessage).not.toHaveBeenCalled();
  });

  it('expiration: kick and captcha cleanup', async () => {
    const { deps, api } = setup();
    await onJoin(deps, CHAT, guest);

    deps.now = () => 1_000_000 + 61_000;
    await sweepExpired(deps);

    expect(api.banChatMember).toHaveBeenCalledWith(CHAT, 7);
    expect(api.unbanChatMember).toHaveBeenCalledWith(CHAT, 7);
    expect(api.deleteMessage).toHaveBeenCalledWith(CHAT, 100);
    expect(deps.state.getPending(CHAT, 7)).toBeUndefined();
  });

  it('a pending user leaving drops the captcha without a kick', async () => {
    const { deps, api } = setup();
    await onJoin(deps, CHAT, guest);

    onSeenInside(deps, CHAT, 7);

    expect(deps.state.getPending(CHAT, 7)).toBeUndefined();
    expect(deps.state.isPassed(CHAT, 7)).toBe(false);
    expect(api.banChatMember).not.toHaveBeenCalled();
  });

  it('a veteran leaving is marked as passed', () => {
    const { deps } = setup();

    onSeenInside(deps, CHAT, 42);

    expect(deps.state.isPassed(CHAT, 42)).toBe(true);
  });
});

describe('bots', () => {
  it('an explicitly allowed bot stays without checking its adder', async () => {
    const { deps, api } = setup();
    deps.allowedBotIds = new Set([899]);

    await onJoin(deps, CHAT, { id: 899, isBot: true, firstName: 'Bot', addedBy: 7 });

    expect(api.getChatMember).not.toHaveBeenCalled();
    expect(api.banChatMember).not.toHaveBeenCalled();
  });

  it('a bot added by an admin stays', async () => {
    const { deps, api } = setup();
    api.getChatMember!.mockResolvedValueOnce({ status: 'administrator' });

    await onJoin(deps, CHAT, { id: 900, isBot: true, firstName: 'Bot', addedBy: 7 });

    expect(api.getChatMember).toHaveBeenCalledWith(CHAT, 7);
    expect(api.banChatMember).not.toHaveBeenCalled();
    expect(api.sendAnimation).not.toHaveBeenCalled();
  });

  it('a bot added by a regular member gets kicked', async () => {
    const { deps, api } = setup();

    await onJoin(deps, CHAT, { id: 901, isBot: true, firstName: 'Bot', addedBy: 8 });
    expect(api.banChatMember).toHaveBeenCalledWith(CHAT, 901);
  });

  it('a bot gets kicked when its adder cannot be verified', async () => {
    const { deps, api } = setup();
    api.getChatMember!.mockRejectedValueOnce(new Error('Telegram unavailable'));

    await onJoin(deps, CHAT, { id: 902, isBot: true, firstName: 'Bot', addedBy: 9 });

    expect(api.banChatMember).toHaveBeenCalledWith(CHAT, 902);
    expect(deps.log).toHaveBeenCalledWith(
      expect.stringContaining('Could not verify bot adder'),
      expect.anything(),
    );
  });

  it('ffmpeg failure lets the newcomer through loudly instead of trapping them', async () => {
    const { deps, api } = setup();
    const { renderAnimation } = await import('./captcha.js');
    vi.mocked(renderAnimation).mockRejectedValueOnce(new Error('no ffmpeg'));

    await onJoin(deps, CHAT, guest);

    expect(api.sendAnimation).not.toHaveBeenCalled();
    expect(deps.state.isPassed(CHAT, 7)).toBe(true);
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('let through'), expect.anything());
  });
});
