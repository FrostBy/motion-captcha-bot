import { makeDecoy, makeExpression, renderAnimation, type Motion, type Style } from './captcha.js';
import { withRetry, quietly } from './telegram.js';
import type { Messages } from './config.js';
import type { State } from './state.js';

/** The narrow Bot API slice the logic needs; mocked in tests. */
export interface ChatApi {
  sendAnimation(
    chatId: number,
    video: Uint8Array,
    caption: string,
  ): Promise<{ message_id: number }>;
  sendMessage(chatId: number, text: string): Promise<{ message_id: number }>;
  deleteMessage(chatId: number, messageId: number): Promise<unknown>;
  banChatMember(chatId: number, userId: number): Promise<unknown>;
  unbanChatMember(chatId: number, userId: number): Promise<unknown>;
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

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

export async function onJoin(deps: Deps, chatId: number, member: Member): Promise<void> {
  const { api, state } = deps;

  if (member.isBot) {
    // A bot brought in by a member stays; one that walked in alone does not.
    if (member.addedBy !== member.id) return;
    deps.log('Bot joined on its own, kicking', { chatId, botId: member.id });
    await kick(deps, chatId, member.id);
    return;
  }

  if (state.isPassed(chatId, member.id)) return;

  // A repeated join while still pending must not orphan the old captcha.
  const previous = state.getPending(chatId, member.id);
  if (previous) void quietly(() => api.deleteMessage(chatId, previous.captchaMessageId));

  const captcha = makeExpression(deps.random);
  const decoy = deps.captchaDecoy ? makeDecoy(captcha.answer, deps.random) : undefined;
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
    // Keeping someone pending with no captcha is unfair, let them in loudly.
    deps.log(`Captcha render failed, newcomer let through: ${errorText(error)}`, { chatId });
    state.markPassed(chatId, member.id);
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

/** A leave/status change proves the user was inside, a veteran. */
export function onSeenInside(deps: Deps, chatId: number, userId: number): void {
  // Updates caused by our own ban/unban are not proof of membership.
  if (deps.state.isKicking(chatId, userId, deps.now?.() ?? Date.now())) return;

  const pending = deps.state.getPending(chatId, userId);
  if (pending) {
    // A pending user left on their own: drop the captcha and forget.
    deps.state.clearPending(chatId, userId);
    void quietly(() => deps.api.deleteMessage(chatId, pending.captchaMessageId));
    return;
  }
  deps.state.markPassed(chatId, userId);
}

/** A pending user promoted to admin is obviously trusted: waive the captcha. */
export function onPromoted(deps: Deps, chatId: number, userId: number): void {
  const pending = deps.state.getPending(chatId, userId);
  if (pending) void quietly(() => deps.api.deleteMessage(chatId, pending.captchaMessageId));
  deps.state.markPassed(chatId, userId);
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
    state.markPassed(chatId, userId);
    return;
  }

  const answer = text?.trim();

  // Only the decoy layer is legible to frame analysis, so a match outs a bot.
  if (pending.decoyAnswer !== undefined && answer === String(pending.decoyAnswer)) {
    state.clearPending(chatId, userId);
    deps.log('Decoy answered, kicking instantly', { chatId, userId });
    await quietly(() => api.deleteMessage(chatId, messageId));
    await quietly(() => api.deleteMessage(chatId, pending.captchaMessageId));
    await kick(deps, chatId, userId).catch((error) =>
      deps.log(`Kick failed: ${errorText(error)}`, { chatId, userId }),
    );
    return;
  }

  if (answer === String(pending.answer)) {
    state.markPassed(chatId, userId);
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
      deps.log('Out of attempts, kicking', { chatId, userId });
      await quietly(() => api.deleteMessage(chatId, pending.captchaMessageId));
      await kick(deps, chatId, userId).catch((error) =>
        deps.log(`Kick failed: ${errorText(error)}`, { chatId, userId }),
      );
      return;
    }
    state.setPending(chatId, userId, { ...pending, attempts });
  }
}

/** Timer sweep: expired newcomers get kicked, restart survivors included. */
export async function sweepExpired(deps: Deps): Promise<void> {
  const now = deps.now?.() ?? Date.now();
  for (const { chatId, userId, pending } of deps.state.expired(now)) {
    // The batch is a snapshot: while earlier kicks were in flight this user
    // may have answered correctly (or left). Re-check before acting.
    const current = deps.state.getPending(chatId, userId);
    if (!current || current.captchaMessageId !== pending.captchaMessageId) continue;
    deps.state.clearPending(chatId, userId);
    deps.log('Captcha expired, kicking', { chatId, userId });
    await kick(deps, chatId, userId).catch((error) =>
      deps.log(`Kick failed: ${errorText(error)}`, { chatId, userId }),
    );
    await quietly(() => deps.api.deleteMessage(chatId, pending.captchaMessageId));
  }
}
