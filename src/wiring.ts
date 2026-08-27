import type { Bot } from 'grammy';

import {
  onJoin,
  onJoinMessage,
  onMessage,
  onPromoted,
  onSeenInside,
  type Deps,
} from './handlers.js';

/**
 * Update wiring, kept apart from process startup so it can be tested without
 * a bot token or a network: the status mapping, the chat allowlist and the
 * serial gate are exactly the places where a mistake is silent in production.
 */
export interface Wiring {
  /** Chats served by the bot; empty means every chat. */
  allowedChatIds: ReadonlySet<number>;
  /** Shared queue for updates and the expiry sweeper. */
  gate: { run<T>(task: () => Promise<T>): Promise<T> };
  /** Seconds an update may have waited before it is ignored; 0 disables it. */
  maxUpdateAgeSec?: number;
  deps: Deps;
}

/** Only these chat types can have newcomers to challenge. */
function isGroup(type: string): boolean {
  return type === 'group' || type === 'supergroup';
}

/** Fields Telegram fills in itself: nobody typed such a message. */
const SERVICE_FIELDS = [
  'new_chat_members',
  'left_chat_member',
  'new_chat_title',
  'new_chat_photo',
  'delete_chat_photo',
  'pinned_message',
  'group_chat_created',
  'supergroup_chat_created',
  'channel_chat_created',
  'message_auto_delete_timer_changed',
  'migrate_to_chat_id',
  'migrate_from_chat_id',
  'video_chat_started',
  'video_chat_ended',
  'video_chat_scheduled',
  'video_chat_participants_invited',
] as const;

function isServiceMessage(message: Record<string, unknown>): boolean {
  return SERVICE_FIELDS.some((field) => message[field] !== undefined);
}

/**
 * When the update was created, in Telegram's seconds. Every update the bot
 * subscribes to carries one; an unknown shape is treated as fresh so a future
 * update type cannot be dropped silently.
 */
function updateAgeSec(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any,
  now: number,
): number {
  const date: unknown =
    ctx.chatMember?.date ??
    ctx.editedMessage?.edit_date ??
    ctx.editedMessage?.date ??
    ctx.message?.date;
  if (typeof date !== 'number') return 0;
  return Math.max(0, Math.floor(now / 1000) - date);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerHandlers(bot: Bot<any>, wiring: Wiring): void {
  const { allowedChatIds, gate, deps } = wiring;
  const maxAgeSec = wiring.maxUpdateAgeSec ?? 0;

  // An empty allowlist preserves the default of serving every chat. Filtering
  // here prevents disallowed chats from reaching rendering or mutable state.
  bot.use(async (ctx, next) => {
    const chatId = ctx.chat?.id;
    if (chatId !== undefined && allowedChatIds.size > 0 && !allowedChatIds.has(chatId)) return;
    await next();
  });

  // Telegram keeps undelivered updates for a day. Without this a bot that was
  // down wakes up and works through the backlog: captchas for people who
  // joined hours ago and answers to captchas nobody is waiting for.
  if (maxAgeSec > 0) {
    bot.use(async (ctx, next) => {
      const age = updateAgeSec(ctx, deps.now?.() ?? Date.now());
      if (age > maxAgeSec) {
        deps.log(`Ignoring an update ${age}s old`, { chatId: ctx.chat?.id, maxAgeSec });
        return;
      }
      await next();
    });
  }

  // Updates and the expiry sweeper share one queue: otherwise the sweeper
  // reads the deadline while a correct answer still waits to be handled.
  bot.use((_ctx, next) => gate.run(next));

  // Joins and leaves: chat_member arrives only when explicitly polled for.
  bot.on('chat_member', async (ctx) => {
    const update = ctx.chatMember;
    const chatId = ctx.chat.id;
    const user = update.new_chat_member.user;
    const was = update.old_chat_member.status;
    const is = update.new_chat_member.status;

    const joined = (was === 'left' || was === 'kicked') && (is === 'member' || is === 'restricted');
    const left = is === 'left' || is === 'kicked';
    const promoted = is === 'administrator' || is === 'creator';

    if (joined) {
      await onJoin(deps, chatId, {
        id: user.id,
        isBot: user.is_bot,
        firstName: user.first_name,
        addedBy: update.from.id,
      });
      return;
    }
    if (left && !user.is_bot) {
      onSeenInside(deps, chatId, user.id, { actorId: update.from.id, previousStatus: was });
    }
    // An admin stuck behind a pending captcha would be moderated forever.
    if (promoted && !user.is_bot) onPromoted(deps, chatId, user.id);
  });

  // "X joined the group" is a line written by Telegram, not by the newcomer:
  // judging it as their message sent it to the bin along with the chat's own
  // history of who came in. Kept, and remembered in case we kick them.
  bot.on('message:new_chat_members', async (ctx) => {
    if (!isGroup(ctx.chat.type)) return;
    for (const member of ctx.message.new_chat_members) {
      // A bot is met by onJoin, which kicks it and cleans up after itself.
      if (!member.is_bot) {
        await onJoinMessage(deps, ctx.chat.id, member.id, ctx.message.message_id);
      }
    }
  });

  bot.on('message', async (ctx) => {
    if (!isGroup(ctx.chat.type)) return;
    if (ctx.from.is_bot) return;
    // Service messages (a join, a leave, a pin) belong to the chat, not to the
    // newcomer — the bin is for what they actually wrote.
    if (isServiceMessage(ctx.message)) return;
    await onMessage(deps, ctx.chat.id, ctx.from.id, ctx.message.message_id, ctx.message.text);
  });

  // A newcomer fixing a typo by editing deserves the same evaluation.
  bot.on('edited_message', async (ctx) => {
    if (!isGroup(ctx.chat.type)) return;
    if (ctx.from.is_bot) return;
    await onMessage(
      deps,
      ctx.chat.id,
      ctx.from.id,
      ctx.editedMessage.message_id,
      ctx.editedMessage.text,
    );
  });

  bot.catch((error) => deps.log(`Update handling failed: ${error.message}`));
}

/** How often expired captchas are swept. */
export const SWEEP_INTERVAL_MS = 5000;

/**
 * The sweeper as a timer callback. A pass that outlives its interval must not
 * start a second one: bans and rate-limit waits would stack on the same users.
 */
export function createSweeper(
  wiring: Pick<Wiring, 'gate' | 'deps'>,
  sweep: (deps: Deps) => Promise<void>,
): () => void {
  let sweeping = false;
  return () => {
    if (sweeping) return;
    sweeping = true;
    void wiring.gate
      .run(() => sweep(wiring.deps))
      .catch((error: Error) => wiring.deps.log(`Sweep failed: ${error.message}`))
      .finally(() => {
        sweeping = false;
      });
  };
}
