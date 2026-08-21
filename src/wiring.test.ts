import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createSerialGate } from './gate.js';
import type { Deps } from './handlers.js';
import { createSweeper, registerHandlers, type Wiring } from './wiring.js';

// The wiring is judged by what it calls, so the handlers themselves are mocks.
const handlers = vi.hoisted(() => ({
  onJoin: vi.fn(async () => undefined),
  onMessage: vi.fn(async () => undefined),
  onPromoted: vi.fn(() => undefined),
  onSeenInside: vi.fn(() => undefined),
}));
vi.mock('./handlers.js', () => handlers);

const CHAT = -100500;

/** A stand-in for the grammY bot: records handlers instead of polling. */
function fakeBot() {
  const middlewares: Array<(ctx: unknown, next: () => Promise<void>) => Promise<void>> = [];
  const events = new Map<string, (ctx: unknown) => Promise<void>>();
  let errorHandler: ((error: { message: string }) => void) | undefined;
  return {
    use: (fn: (ctx: unknown, next: () => Promise<void>) => Promise<void>) => {
      middlewares.push(fn);
    },
    on: (event: string, fn: (ctx: unknown) => Promise<void>) => {
      events.set(event, fn);
    },
    catch: (fn: (error: { message: string }) => void) => {
      errorHandler = fn;
    },
    /** Push an update through the middleware chain and into its handler. */
    async deliver(event: string, ctx: unknown): Promise<void> {
      let index = 0;
      const next = async (): Promise<void> => {
        const middleware = middlewares[index++];
        if (middleware) return middleware(ctx, next);
        await events.get(event)?.(ctx);
      };
      await next();
    },
    fail: (message: string) => errorHandler?.({ message }),
  };
}

function setup(allowedChatIds: ReadonlySet<number> = new Set()): {
  bot: ReturnType<typeof fakeBot>;
  wiring: Wiring;
} {
  const bot = fakeBot();
  const wiring: Wiring = {
    allowedChatIds,
    gate: createSerialGate(),
    deps: { log: vi.fn() } as unknown as Deps,
  };
  registerHandlers(bot as never, wiring);
  return { bot, wiring };
}

function chatMember(over: Record<string, unknown> = {}) {
  return {
    chat: { id: CHAT, type: 'supergroup' },
    chatMember: {
      from: { id: 7 },
      old_chat_member: { status: 'left' },
      new_chat_member: {
        status: 'member',
        user: { id: 7, is_bot: false, first_name: 'Guest' },
      },
      ...over,
    },
  };
}

beforeEach(() => vi.clearAllMocks());

describe('update wiring', () => {
  it('a join reaches onJoin with the actor that added the member', async () => {
    const { bot } = setup();

    await bot.deliver('chat_member', chatMember({ from: { id: 42 } }));

    expect(handlers.onJoin).toHaveBeenCalledWith(expect.anything(), CHAT, {
      id: 7,
      isBot: false,
      firstName: 'Guest',
      addedBy: 42,
    });
  });

  it('a leave carries the actor and the previous status', async () => {
    const { bot } = setup();

    await bot.deliver(
      'chat_member',
      chatMember({
        old_chat_member: { status: 'member' },
        new_chat_member: {
          status: 'kicked',
          user: { id: 7, is_bot: false, first_name: 'Guest' },
        },
      }),
    );

    expect(handlers.onSeenInside).toHaveBeenCalledWith(expect.anything(), CHAT, 7, {
      actorId: 7,
      previousStatus: 'member',
    });
  });

  it('a promotion waives the captcha', async () => {
    const { bot } = setup();

    await bot.deliver(
      'chat_member',
      chatMember({
        old_chat_member: { status: 'member' },
        new_chat_member: {
          status: 'administrator',
          user: { id: 8, is_bot: false, first_name: 'Admin' },
        },
      }),
    );

    expect(handlers.onPromoted).toHaveBeenCalledWith(expect.anything(), CHAT, 8);
  });

  it('a bot leaving is not treated as a member', async () => {
    const { bot } = setup();

    await bot.deliver(
      'chat_member',
      chatMember({
        old_chat_member: { status: 'member' },
        new_chat_member: {
          status: 'left',
          user: { id: 900, is_bot: true, first_name: 'Bot' },
        },
      }),
    );

    expect(handlers.onSeenInside).not.toHaveBeenCalled();
  });

  it('messages and edits both reach onMessage', async () => {
    const { bot } = setup();
    const base = { chat: { id: CHAT, type: 'supergroup' }, from: { id: 7, is_bot: false } };

    await bot.deliver('message', { ...base, message: { message_id: 5, text: 'hi' } });
    await bot.deliver('edited_message', { ...base, editedMessage: { message_id: 6, text: '12' } });

    expect(handlers.onMessage).toHaveBeenNthCalledWith(1, expect.anything(), CHAT, 7, 5, 'hi');
    expect(handlers.onMessage).toHaveBeenNthCalledWith(2, expect.anything(), CHAT, 7, 6, '12');
  });

  it('private chats and bot authors are ignored', async () => {
    const { bot } = setup();

    await bot.deliver('message', {
      chat: { id: 7, type: 'private' },
      from: { id: 7, is_bot: false },
      message: { message_id: 5, text: 'hi' },
    });
    await bot.deliver('message', {
      chat: { id: CHAT, type: 'supergroup' },
      from: { id: 900, is_bot: true },
      message: { message_id: 6, text: 'hi' },
    });

    expect(handlers.onMessage).not.toHaveBeenCalled();
  });

  it('chats outside the allowlist never reach a handler', async () => {
    const { bot } = setup(new Set([-100999]));

    await bot.deliver('chat_member', chatMember());

    expect(handlers.onJoin).not.toHaveBeenCalled();
  });

  it('an empty allowlist serves every chat', async () => {
    const { bot } = setup(new Set());

    await bot.deliver('chat_member', chatMember());

    expect(handlers.onJoin).toHaveBeenCalled();
  });

  it('a handler failure is logged instead of crashing the bot', () => {
    const { bot, wiring } = setup();

    bot.fail('boom');

    expect(wiring.deps.log).toHaveBeenCalledWith(expect.stringContaining('boom'));
  });
});

describe('sweeper', () => {
  it('does not start a second pass while the first one runs', async () => {
    const { wiring } = setup();
    let release: (() => void) | undefined;
    const sweep = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const tick = createSweeper(wiring, sweep);

    // The gate hands the task over on a microtask, so the first tick needs a
    // turn of the loop before the pass is actually running.
    tick();
    await new Promise((resolve) => setImmediate(resolve));
    tick();
    expect(sweep).toHaveBeenCalledOnce();

    release?.();
    await new Promise((resolve) => setImmediate(resolve));
    tick();
    await new Promise((resolve) => setImmediate(resolve));

    expect(sweep).toHaveBeenCalledTimes(2);
  });

  it('a failed pass is logged and does not block the next one', async () => {
    const { wiring } = setup();
    const sweep = vi
      .fn()
      .mockRejectedValueOnce(new Error('sweep exploded'))
      .mockResolvedValue(undefined);
    const tick = createSweeper(wiring, sweep);

    tick();
    await new Promise((resolve) => setImmediate(resolve));
    tick();
    await new Promise((resolve) => setImmediate(resolve));

    expect(wiring.deps.log).toHaveBeenCalledWith(expect.stringContaining('sweep exploded'));
    expect(sweep).toHaveBeenCalledTimes(2);
  });

  it('the sweep waits for updates already in the queue', async () => {
    const { wiring } = setup();
    const order: string[] = [];
    void wiring.gate.run(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push('update');
    });
    const tick = createSweeper(wiring, async () => {
      order.push('sweep');
    });

    tick();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(order).toEqual(['update', 'sweep']);
  });
});
