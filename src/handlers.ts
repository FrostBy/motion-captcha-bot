import type { Api } from 'grammy';

import {
  makeDecoy,
  makeExpression,
  renderAnimation,
  type Motion,
  type OperandDigits,
  type Style,
} from './captcha.js';
import { withRetry, quietly } from './telegram.js';
import type { Messages } from './config.js';
import type { State } from './state.js';

export type ChatMemberStatus = Awaited<ReturnType<Api['getChatMember']>>['status'];

/** The narrow Bot API slice the logic needs; mocked in tests. */
export interface ChatApi {
  sendAnimation(
    chatId: number,
    video: Uint8Array,
    caption: string,
  ): Promise<{ message_id: number }>;
  sendMessage(chatId: number, text: string): Promise<{ message_id: number }>;
  deleteMessage(chatId: number, messageId: number): Promise<unknown>;
  banChatMember(chatId: number, userId: number, untilDate?: number): Promise<unknown>;
  unbanChatMember(chatId: number, userId: number, onlyIfBanned?: boolean): Promise<unknown>;
  getChatMember(chatId: number, userId: number): Promise<{ status: ChatMemberStatus }>;
}

export interface Member {
  id: number;
  isBot: boolean;
  firstName: string;
  /** Who produced the join event: the user themselves or whoever added them. */
  addedBy: number;
}

export interface Deps {
  api: ChatApi;
  state: State;
  timeoutSec: number;
  ffmpegPath: string;
  captchaStyle: Style;
  captchaMotion: Motion;
  captchaSprinkle: number;
  captchaDecoy: boolean;
  captchaMaxAttempts: number;
  captchaBanSec: number;
  /** A rendering failure bans instead of waving the newcomer through. */
  captchaFailClosed?: boolean;
  /** Days a veteran is remembered; 0 or undefined keeps them forever. */
  passedTtlDays?: number;
  /** Digits per operand: 1 reads easily, 2 is harder to guess. */
  captchaOperandDigits?: OperandDigits;
  allowedBotIds: ReadonlySet<number>;
  /** Chats served by the bot; empty means every chat, as in the config. */
  allowedChatIds?: ReadonlySet<number>;
  /** Own id: updates this bot itself caused are not evidence about a user. */
  botId?: number;
  messages: Messages;
  log: (message: string, extra?: unknown) => void;
  now?: () => number;
  random?: () => number;
}

function escapeHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** Clickable mention that works even for users without a public username. */
function mention(userId: number, firstName: string): string {
  return `<a href="tg://user?id=${userId}">${escapeHtml(firstName)}</a>`;
}

function fill(template: string, userId: number, firstName: string, timeoutSec: number): string {
  return template
    .replaceAll('%username%', mention(userId, firstName))
    .replaceAll('%timer%', String(timeoutSec));
}

/** How long the welcome message stays before it is cleaned up. */
const WELCOME_TTL_MS = 30_000;
/** Keep automatic-unban updates recognizable even when delivery is delayed. */
const CHAT_MEMBER_UPDATE_GRACE_MS = 60_000;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Whether Telegram already considers the user gone. Fail-open on purpose: an
 * API hiccup must not become a way past the captcha, so an unanswered check
 * is treated as "still here".
 */
async function hasLeft(deps: Deps, chatId: number, userId: number): Promise<boolean> {
  try {
    const current = await withRetry(() => deps.api.getChatMember(chatId, userId));
    return current.status === 'kicked' || current.status === 'left';
  } catch (error) {
    deps.log(`Could not read the newcomer status: ${errorText(error)}`, { chatId, userId });
    return false;
  }
}

/**
 * Kick without closing the door: the user may rejoin and try again. Marked
 * in state first, so the ban/unban updates it triggers are not mistaken for
 * proof of membership.
 */
async function kick(deps: Deps, chatId: number, userId: number): Promise<void> {
  deps.state.markKicking(chatId, userId, deps.now?.() ?? Date.now());
  await withRetry(() => deps.api.banChatMember(chatId, userId));
  await quietly(() => deps.api.unbanChatMember(chatId, userId));
}

/** Ban a failed newcomer until Telegram automatically lets them try again. */
async function banFailedNewcomer(deps: Deps, chatId: number, userId: number): Promise<void> {
  const now = deps.now?.() ?? Date.now();
  const untilDate = Math.floor(now / 1000) + deps.captchaBanSec;
  deps.state.markKicking(
    chatId,
    userId,
    now,
    deps.captchaBanSec * 1000 + CHAT_MEMBER_UPDATE_GRACE_MS,
  );
  deps.state.markTemporarilyBanned(chatId, userId, untilDate * 1000);
  // Persist the marker before Telegram can emit the matching status updates.
  // A failed write must not cancel the ban itself: the snapshot is a
  // convenience, letting the spammer stay is not.
  await deps.state.flush().catch((error) =>
    deps.log(`State snapshot before the ban failed: ${errorText(error)}`, { chatId, userId }),
  );
  await withRetry(() => deps.api.banChatMember(chatId, userId, untilDate));
}

export async function onJoin(deps: Deps, chatId: number, member: Member): Promise<void> {
  const { api, state } = deps;

  if (member.isBot) {
    if (deps.allowedBotIds.has(member.id)) return;
    let addedByAdmin = false;
    try {
      const adder = await withRetry(() => api.getChatMember(chatId, member.addedBy));
      addedByAdmin = adder.status === 'administrator' || adder.status === 'creator';
    } catch (error) {
      deps.log(`Could not verify bot adder: ${errorText(error)}`, {
        chatId,
        botId: member.id,
        addedBy: member.addedBy,
      });
    }
    if (addedByAdmin) return;
    deps.log('Bot was not added by an admin, kicking', {
      chatId,
      botId: member.id,
      addedBy: member.addedBy,
    });
    await kick(deps, chatId, member.id);
    return;
  }

  if (state.isPassed(chatId, member.id)) return;

  // The join may be stale news. While the bot was down an admin could have
  // banned the spammer by hand, and a captcha for someone already gone is
  // noise in the chat plus a pending entry nobody will ever clear.
  if (await hasLeft(deps, chatId, member.id)) {
    deps.log('Newcomer is no longer in the chat, skipping the captcha', {
      chatId,
      userId: member.id,
    });
    return;
  }

  // A repeated join while still pending must not orphan the old captcha.
  const previous = state.getPending(chatId, member.id);
  if (previous) void quietly(() => api.deleteMessage(chatId, previous.captchaMessageId));

  const digits = deps.captchaOperandDigits ?? 1;
  const captcha = makeExpression(deps.random, digits);
  const decoy = deps.captchaDecoy ? makeDecoy(captcha.answer, deps.random, digits) : undefined;
  let video: Uint8Array;
  try {
    video = await renderAnimation(captcha.question, deps.ffmpegPath, {
      style: deps.captchaStyle,
      motion: deps.captchaMotion,
      sprinkle: deps.captchaSprinkle,
      decoyQuestion: decoy?.question,
      random: deps.random,
    });
  } catch (error) {
    if (deps.captchaFailClosed) {
      // A broken renderer must not become the way past the captcha: the
      // newcomer waits out the usual ban and tries again later.
      deps.log(`Captcha render failed, banning temporarily: ${errorText(error)}`, {
        chatId,
        userId: member.id,
      });
      await banFailedNewcomer(deps, chatId, member.id).catch((banError) =>
        deps.log(`Ban failed: ${errorText(banError)}`, { chatId, userId: member.id }),
      );
      return;
    }
    // Keeping someone pending with no captcha is unfair, let them in loudly.
    deps.log(`Captcha render failed, newcomer let through: ${errorText(error)}`, { chatId });
    state.markPassed(chatId, member.id, deps.now?.() ?? Date.now());
    return;
  }

  const sent = await withRetry(() =>
    api.sendAnimation(
      chatId,
      video,
      fill(deps.messages.captcha, member.id, member.firstName, deps.timeoutSec),
    ),
  );
  state.setPending(chatId, member.id, {
    answer: captcha.answer,
    decoyAnswer: decoy?.answer,
    deadline: (deps.now?.() ?? Date.now()) + deps.timeoutSec * 1000,
    captchaMessageId: sent.message_id,
    firstName: member.firstName,
  });
}

/** Statuses that prove the user really was inside the chat. */
const MEMBER_STATUSES: ReadonlySet<ChatMemberStatus> = new Set([
  'member',
  'restricted',
  'administrator',
  'creator',
]);

/**
 * A leave event proves membership only when the previous status was a real
 * one and the change was not our own moderation. Timers alone were not
 * enough: after downtime longer than the ban, the automatic-unban update
 * (kicked -> left) arrived with every marker expired and promoted a failed
 * newcomer to veteran, so the captcha never showed up for them again.
 */
export function onSeenInside(
  deps: Deps,
  chatId: number,
  userId: number,
  event?: { actorId?: number; previousStatus?: ChatMemberStatus },
): void {
  // Our own ban and the unban that follows it say nothing about the user.
  if (event?.actorId !== undefined && event.actorId === deps.botId) return;
  if (deps.state.hasTemporaryBan(chatId, userId)) return;
  if (deps.state.isKicking(chatId, userId, deps.now?.() ?? Date.now())) return;

  const pending = deps.state.getPending(chatId, userId);
  if (pending) {
    // A pending user left on their own: drop the captcha and forget.
    deps.state.clearPending(chatId, userId);
    void quietly(() => deps.api.deleteMessage(chatId, pending.captchaMessageId));
    return;
  }
  // Leaving a ban behind (kicked -> left) is not membership.
  if (event?.previousStatus !== undefined && !MEMBER_STATUSES.has(event.previousStatus)) return;
  deps.state.markPassed(chatId, userId, deps.now?.() ?? Date.now());
}

/** A pending user promoted to admin is obviously trusted: waive the captcha. */
export function onPromoted(deps: Deps, chatId: number, userId: number): void {
  const pending = deps.state.getPending(chatId, userId);
  if (pending) void quietly(() => deps.api.deleteMessage(chatId, pending.captchaMessageId));
  deps.state.markPassed(chatId, userId, deps.now?.() ?? Date.now());
}

export async function onMessage(
  deps: Deps,
  chatId: number,
  userId: number,
  messageId: number,
  text: string | undefined,
): Promise<void> {
  const { api, state } = deps;
  const now = deps.now?.() ?? Date.now();
  const pending = state.getPending(chatId, userId);

  if (!pending) {
    // Messages racing our own in-flight kick must not whitelist the sender.
    if (state.isKicking(chatId, userId, now)) {
      await quietly(() => api.deleteMessage(chatId, messageId));
      return;
    }
    // They write, so they are inside; not pending, so they predate the bot.
    state.markPassed(chatId, userId, now);
    return;
  }

  const answer = text?.trim();

  // Only the decoy layer is legible to frame analysis, so a match outs a bot.
  if (pending.decoyAnswer !== undefined && answer === String(pending.decoyAnswer)) {
    state.clearPending(chatId, userId);
    deps.log('Decoy answered, banning temporarily', { chatId, userId });
    await quietly(() => api.deleteMessage(chatId, messageId));
    await quietly(() => api.deleteMessage(chatId, pending.captchaMessageId));
    await banFailedNewcomer(deps, chatId, userId).catch((error) =>
      deps.log(`Ban failed: ${errorText(error)}`, { chatId, userId }),
    );
    return;
  }

  if (answer === String(pending.answer)) {
    state.markPassed(chatId, userId, now);
    await quietly(() => api.deleteMessage(chatId, messageId));
    await quietly(() => api.deleteMessage(chatId, pending.captchaMessageId));
    const hello = await withRetry(() =>
      api.sendMessage(
        chatId,
        fill(deps.messages.welcome, userId, pending.firstName ?? '', deps.timeoutSec),
      ),
    );
    setTimeout(() => void quietly(() => api.deleteMessage(chatId, hello.message_id)), WELCOME_TTL_MS);
    return;
  }

  // Anything else from a newcomer goes to the bin, no room for spam.
  await quietly(() => api.deleteMessage(chatId, messageId));

  // The sum is 0..18: without an attempt cap the captcha is guessable for free.
  if (answer !== undefined && /^\d+$/.test(answer)) {
    const attempts = (pending.attempts ?? 0) + 1;
    if (attempts >= deps.captchaMaxAttempts) {
      state.clearPending(chatId, userId);
      deps.log('Out of attempts, banning temporarily', { chatId, userId });
      await quietly(() => api.deleteMessage(chatId, pending.captchaMessageId));
      await banFailedNewcomer(deps, chatId, userId).catch((error) =>
        deps.log(`Ban failed: ${errorText(error)}`, { chatId, userId }),
      );
      return;
    }
    state.setPending(chatId, userId, { ...pending, attempts });
  }
}

/** Timer sweep: expired newcomers get temporarily banned, restart survivors included. */
export async function sweepExpired(deps: Deps): Promise<void> {
  const now = deps.now?.() ?? Date.now();
  // Updates from unserved chats never reach the handlers; entries left over
  // from an earlier allowlist must not be moderated behind their backs.
  const served = (chatId: number): boolean =>
    deps.allowedChatIds === undefined ||
    deps.allowedChatIds.size === 0 ||
    deps.allowedChatIds.has(chatId);

  // Veterans are the only part of the snapshot that never shrinks on its own.
  if (deps.passedTtlDays) {
    const removed = deps.state.prunePassed(now - deps.passedTtlDays * 24 * 60 * 60 * 1000);
    if (removed > 0) deps.log('Forgot veterans past the retention window', { removed });
  }

  for (const { chatId, userId, until } of deps.state.expiredTemporaryBans(now)) {
    if (!served(chatId)) continue;
    if (deps.state.getTemporaryBan(chatId, userId) !== until) continue;
    try {
      await withRetry(() => deps.api.unbanChatMember(chatId, userId, true));
      deps.state.clearTemporaryBan(chatId, userId);
    } catch (error) {
      deps.log(`Automatic unban failed: ${errorText(error)}`, { chatId, userId });
    }
  }
  for (const { chatId, userId, pending } of deps.state.expired(now)) {
    if (!served(chatId)) continue;
    // The batch is a snapshot: while earlier kicks were in flight this user
    // may have answered correctly (or left). Re-check before acting.
    const current = deps.state.getPending(chatId, userId);
    if (!current || current.captchaMessageId !== pending.captchaMessageId) continue;
    deps.state.clearPending(chatId, userId);
    deps.log('Captcha expired, banning temporarily', { chatId, userId });
    await banFailedNewcomer(deps, chatId, userId).catch((error) =>
      deps.log(`Ban failed: ${errorText(error)}`, { chatId, userId }),
    );
    await quietly(() => deps.api.deleteMessage(chatId, pending.captchaMessageId));
  }
}
