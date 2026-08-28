import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_MESSAGES } from './config.js';
import {
  onJoin,
  onJoinMessage,
  onMessage,
  onPromoted,
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
    captchaBanSec: 300,
    allowedBotIds: new Set(),
    botId: 1,
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

  // A join that waited in the queue while the bot was down: by now an admin
  // may well have banned the spammer by hand.
  it('skips someone Telegram already reports as gone', async () => {
    for (const status of ['kicked', 'left'] as const) {
      const { deps, api } = setup();
      api.getChatMember!.mockResolvedValueOnce({ status });

      await onJoin(deps, CHAT, guest);

      expect(api.sendAnimation).not.toHaveBeenCalled();
      expect(deps.state.getPending(CHAT, 7)).toBeUndefined();
    }
  });

  it('an unanswered status check still greets: an outage is not a way in', async () => {
    const { deps, api } = setup();
    api.getChatMember!.mockRejectedValue(new Error('Telegram unavailable'));

    await onJoin(deps, CHAT, guest);

    expect(api.sendAnimation).toHaveBeenCalledOnce();
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

  it('answering the decoy triggers a temporary ban', async () => {
    const { deps, api } = setup();
    deps.captchaDecoy = true;
    await onJoin(deps, CHAT, guest);

    await onMessage(deps, CHAT, 7, 557, '8');

    expect(api.banChatMember).toHaveBeenCalledWith(CHAT, 7, 1300);
    expect(api.unbanChatMember).not.toHaveBeenCalled();
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

  it('expiration: temporary ban and captcha cleanup', async () => {
    const { deps, api } = setup();
    await onJoin(deps, CHAT, guest);

    deps.now = () => 1_000_000 + 61_000;
    await sweepExpired(deps);

    expect(api.banChatMember).toHaveBeenCalledWith(CHAT, 7, 1361);
    expect(api.unbanChatMember).not.toHaveBeenCalled();
    expect(api.deleteMessage).toHaveBeenCalledWith(CHAT, 100);
    expect(deps.state.getPending(CHAT, 7)).toBeUndefined();
  });

  it('explicitly lifts an expired temporary ban', async () => {
    const { deps, api } = setup();
    deps.state.markTemporarilyBanned(CHAT, 7, 1_001_000);
    deps.now = () => 1_001_000;

    await sweepExpired(deps);

    expect(api.unbanChatMember).toHaveBeenCalledWith(CHAT, 7, true);
    expect(deps.state.hasTemporaryBan(CHAT, 7)).toBe(false);
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

    onSeenInside(deps, CHAT, 42, { actorId: 42, previousStatus: 'member' });

    expect(deps.state.isPassed(CHAT, 42)).toBe(true);
  });

  it('a ban lifted long after the bot went down does not create a veteran', async () => {
    const { deps } = setup();
    await onJoin(deps, CHAT, guest);

    // The captcha deadline passes and the newcomer is banned for a while.
    deps.now = () => 1_000_000 + 61_000;
    await sweepExpired(deps);
    expect(deps.state.hasTemporaryBan(CHAT, 7)).toBe(true);

    // The bot is down longer than the ban plus every marker grace period.
    deps.now = () => 1_000_000 + 61_000 + 300_000 + 61_000 + 10_000;
    await sweepExpired(deps);

    // Telegram delivers the queued automatic unban: kicked -> left, by us.
    onSeenInside(deps, CHAT, 7, { actorId: 1, previousStatus: 'kicked' });

    expect(deps.state.isPassed(CHAT, 7)).toBe(false);
  });

  it('an unban by an admin is not proof of membership either', () => {
    const { deps } = setup();

    onSeenInside(deps, CHAT, 42, { actorId: 500, previousStatus: 'kicked' });

    expect(deps.state.isPassed(CHAT, 42)).toBe(false);
  });

  it('a member kicked by an admin stays a veteran', () => {
    const { deps } = setup();

    onSeenInside(deps, CHAT, 42, { actorId: 500, previousStatus: 'member' });

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

  it('a failed snapshot write does not cancel the ban', async () => {
    const { deps, api } = setup();
    await onJoin(deps, CHAT, guest);
    // Read-only volume, full disk: the ban matters more than the snapshot.
    vi.spyOn(deps.state, 'flush').mockRejectedValue(new Error('disk is full'));

    for (const messageId of [555, 556, 557]) {
      await onMessage(deps, CHAT, 7, messageId, '11');
    }

    expect(api.banChatMember).toHaveBeenCalledWith(CHAT, 7, expect.any(Number));
    expect(deps.log).toHaveBeenCalledWith(
      expect.stringContaining('snapshot'),
      expect.anything(),
    );
  });

  it('the sweep leaves chats outside the allowlist alone', async () => {
    const { deps, api } = setup();
    await onJoin(deps, CHAT, guest);
    // The chat was dropped from the allowlist while the captcha was pending.
    deps.allowedChatIds = new Set([-100999]);

    deps.now = () => 1_000_000 + 61_000;
    await sweepExpired(deps);

    expect(api.banChatMember).not.toHaveBeenCalled();
    expect(deps.state.getPending(CHAT, 7)).toBeDefined();
  });

  it('a promoted pending user keeps no captcha behind', async () => {
    const { deps, api } = setup();
    await onJoin(deps, CHAT, guest);

    onPromoted(deps, CHAT, 7);

    expect(deps.state.isPassed(CHAT, 7)).toBe(true);
    expect(deps.state.getPending(CHAT, 7)).toBeUndefined();
    expect(api.deleteMessage).toHaveBeenCalledWith(CHAT, 100);
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

describe('failure policy and retention', () => {
  it('a rendering failure bans instead of whitelisting when told to fail closed', async () => {
    const { deps, api } = setup();
    deps.captchaFailClosed = true;
    const { renderAnimation } = await import('./captcha.js');
    vi.mocked(renderAnimation).mockRejectedValueOnce(new Error('no ffmpeg'));

    await onJoin(deps, CHAT, guest);

    expect(deps.state.isPassed(CHAT, 7)).toBe(false);
    expect(api.banChatMember).toHaveBeenCalledWith(CHAT, 7, expect.any(Number));
  });

  it('the sweep forgets veterans past the retention window', async () => {
    const { deps } = setup();
    deps.passedTtlDays = 30;
    deps.state.markPassed(CHAT, 42, 1_000_000);

    deps.now = () => 1_000_000 + 31 * 24 * 60 * 60 * 1000;
    await sweepExpired(deps);

    expect(deps.state.isPassed(CHAT, 42)).toBe(false);
  });

  it('without a retention window veterans stay forever', async () => {
    const { deps } = setup();
    deps.state.markPassed(CHAT, 42, 1_000_000);

    deps.now = () => 1_000_000 + 3650 * 24 * 60 * 60 * 1000;
    await sweepExpired(deps);

    expect(deps.state.isPassed(CHAT, 42)).toBe(true);
  });
});

describe('races and refusals', () => {
  it('the sweep skips a newcomer who answered while earlier bans were in flight', async () => {
    const { deps, api } = setup();
    // Another chat comes first in the batch: its ban is the in-flight one.
    await onJoin(deps, -100501, { ...guest, id: 8 });
    await onJoin(deps, CHAT, guest);
    // The batch is read before the first ban; the answer lands in between.
    api.banChatMember!.mockImplementationOnce(async () => {
      deps.state.markPassed(CHAT, 7, 1_000_000);
      return true;
    });

    deps.now = () => 1_000_000 + 61_000;
    await sweepExpired(deps);

    const banned = api.banChatMember!.mock.calls.map((call) => call[1]);
    expect(banned).not.toContain(7);
    expect(deps.state.isPassed(CHAT, 7)).toBe(true);
  });

  it('a ban refused by Telegram is logged, and the newcomer stays out of the veterans', async () => {
    const { deps, api } = setup();
    await onJoin(deps, CHAT, guest);
    api.banChatMember!.mockRejectedValue(new Error('CHAT_ADMIN_REQUIRED'));

    deps.now = () => 1_000_000 + 61_000;
    await sweepExpired(deps);

    expect(deps.log).toHaveBeenCalledWith(
      expect.stringContaining('CHAT_ADMIN_REQUIRED'),
      expect.anything(),
    );
    expect(deps.state.isPassed(CHAT, 7)).toBe(false);
  });

  it('a refused ban after the attempt limit does not whitelist the spammer', async () => {
    const { deps, api } = setup();
    await onJoin(deps, CHAT, guest);
    api.banChatMember!.mockRejectedValue(new Error('CHAT_ADMIN_REQUIRED'));

    for (const messageId of [1, 2, 3]) {
      await onMessage(deps, CHAT, 7, messageId, '11');
    }
    await onMessage(deps, CHAT, 7, 4, 'spam link');

    expect(deps.state.isPassed(CHAT, 7)).toBe(false);
    expect(api.deleteMessage).toHaveBeenCalledWith(CHAT, 4);
  });

  it('a refused ban on the decoy is logged too', async () => {
    const { deps, api } = setup();
    deps.captchaDecoy = true;
    await onJoin(deps, CHAT, guest);
    api.banChatMember!.mockRejectedValue(new Error('rate limited'));

    await onMessage(deps, CHAT, 7, 555, '8');

    expect(deps.log).toHaveBeenCalledWith(
      expect.stringContaining('rate limited'),
      expect.anything(),
    );
  });

  it('a refused automatic unban keeps the marker for the next sweep', async () => {
    const { deps, api } = setup();
    await onJoin(deps, CHAT, guest);
    deps.now = () => 1_000_000 + 61_000;
    await sweepExpired(deps);

    api.unbanChatMember!.mockRejectedValue(new Error('CHAT_ADMIN_REQUIRED'));
    deps.now = () => 1_000_000 + 61_000 + 300_000 + 1_000;
    await sweepExpired(deps);

    expect(deps.state.hasTemporaryBan(CHAT, 7)).toBe(true);
    expect(deps.log).toHaveBeenCalledWith(
      expect.stringContaining('Automatic unban failed'),
      expect.anything(),
    );
  });

  it('a message sent during our own ban is deleted, not taken as membership', async () => {
    const { deps, api } = setup();
    await onJoin(deps, CHAT, guest);
    deps.now = () => 1_000_000 + 61_000;
    await sweepExpired(deps);

    // Telegram delivers a message the user sent just before the ban landed.
    await onMessage(deps, CHAT, 7, 900, 'spam link');

    expect(api.deleteMessage).toHaveBeenCalledWith(CHAT, 900);
    expect(deps.state.isPassed(CHAT, 7)).toBe(false);
  });
});

/**
 * "X joined the group" is a line written by Telegram, not by the newcomer.
 * It used to die as newcomer spam: no text, no captcha match, straight to the
 * bin — taking the chat's own record of who came in with it.
 */
describe('join service message', () => {
  it('is kept on arrival and remembered', async () => {
    const { deps, api } = setup();
    await onJoin(deps, CHAT, guest);
    api.deleteMessage?.mockClear();

    await onJoinMessage(deps, CHAT, guest.id, 55);

    expect(api.deleteMessage).not.toHaveBeenCalled();
    expect(deps.state.getPending(CHAT, guest.id)?.joinMessageId).toBe(55);
  });

  it('survives arriving before the pending record', async () => {
    // Telegram promises no order between the service message and the status
    // update: the early one waits in the park for its record.
    const { deps } = setup();
    await onJoinMessage(deps, CHAT, guest.id, 55);
    await onJoin(deps, CHAT, guest);

    expect(deps.state.getPending(CHAT, guest.id)?.joinMessageId).toBe(55);
  });

  it('goes away with the kick: a spammer leaves no trace', async () => {
    const { deps, api } = setup();
    await onJoin(deps, CHAT, guest);
    await onJoinMessage(deps, CHAT, guest.id, 55);

    for (let attempt = 0; attempt < deps.captchaMaxAttempts; attempt += 1) {
      await onMessage(deps, CHAT, guest.id, 300, '1');
    }

    expect(api.deleteMessage).toHaveBeenCalledWith(CHAT, 55);
  });

  it('stays for whoever passed the captcha', async () => {
    const { deps, api } = setup();
    await onJoin(deps, CHAT, guest);
    await onJoinMessage(deps, CHAT, guest.id, 55);

    await onMessage(deps, CHAT, guest.id, 300, '5');

    expect(api.deleteMessage).not.toHaveBeenCalledWith(CHAT, 55);
  });

  it('an expired captcha takes the join line along', async () => {
    const { deps, api } = setup();
    await onJoin(deps, CHAT, guest);
    await onJoinMessage(deps, CHAT, guest.id, 55);

    deps.now = () => 1_000_000 + deps.timeoutSec * 1000 + 1;
    await sweepExpired(deps);

    expect(api.deleteMessage).toHaveBeenCalledWith(CHAT, 55);
  });

  it('a bot kicked on arrival takes its own join line', async () => {
    const { deps, api } = setup();
    const robot = { id: 9, isBot: true, firstName: 'Bot', addedBy: 7 };
    // The same route as in production: the line arrives as its own update and
    // a bot gets no pending record, so the id waits in the park.
    await onJoinMessage(deps, CHAT, robot.id, 77);

    await onJoin(deps, CHAT, robot);

    expect(api.deleteMessage).toHaveBeenCalledWith(CHAT, 77);
  });

  it('answering the decoy takes the line along too', async () => {
    const { deps, api } = setup();
    deps.captchaDecoy = true;
    await onJoin(deps, CHAT, guest);
    await onJoinMessage(deps, CHAT, guest.id, 55);

    // 8 is the fake expression's answer: only a bot reads that layer.
    await onMessage(deps, CHAT, guest.id, 300, '8');

    expect(api.deleteMessage).toHaveBeenCalledWith(CHAT, 55);
  });

  it('a repeated join keeps the line from the first one', async () => {
    // The leave update may never arrive: the record is alive, the new line is
    // not there yet, and forgetting the old one leaves the kick with nothing.
    const { deps, api } = setup();
    await onJoin(deps, CHAT, guest);
    await onJoinMessage(deps, CHAT, guest.id, 55);

    await onJoin(deps, CHAT, guest);
    expect(deps.state.getPending(CHAT, guest.id)?.joinMessageId).toBe(55);

    for (let attempt = 0; attempt < deps.captchaMaxAttempts; attempt += 1) {
      await onMessage(deps, CHAT, guest.id, 300, '1');
    }
    expect(api.deleteMessage).toHaveBeenCalledWith(CHAT, 55);
  });

  it('a broken renderer that bans still takes the line', async () => {
    const { deps, api } = setup();
    deps.captchaFailClosed = true;
    const { renderAnimation } = await import('./captcha.js');
    vi.mocked(renderAnimation).mockRejectedValueOnce(new Error('no ffmpeg'));
    await onJoinMessage(deps, CHAT, guest.id, 55);

    await onJoin(deps, CHAT, guest);

    expect(api.banChatMember).toHaveBeenCalled();
    expect(api.deleteMessage).toHaveBeenCalledWith(CHAT, 55);
  });

  it('the scheduled pass leaves a fresh park alone', async () => {
    const { deps } = setup();
    await onJoinMessage(deps, CHAT, 42, 55);

    deps.now = () => 1_000_000 + 60_000;
    await sweepExpired(deps);

    expect(deps.state.takeJoinMessage(CHAT, 42, deps.now())).toBe(55);
  });

  it('an expired park is neither served nor kept', async () => {
    const { deps } = setup();
    await onJoinMessage(deps, CHAT, 42, 55);

    deps.now = () => 1_000_000 + 6 * 60_000;
    await sweepExpired(deps);

    expect(deps.state.takeJoinMessage(CHAT, 42, deps.now())).toBeUndefined();
  });
});
