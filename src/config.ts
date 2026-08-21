import { readFileSync } from 'node:fs';

import type { Motion, OperandDigits, Style } from './captcha.js';

/** Everything is driven by env vars: no settings DB, no admin panel. */
export interface Config {
  botToken: string;
  /** Seconds a newcomer has to answer before the kick. */
  captchaTimeoutSec: number;
  /** Noise look: 2px bands ('l', default), 1px bands ('g'), dots ('dots'). */
  captchaStyle: Style;
  /** 1 for opposing layers (default), 2 for same direction, wobbling speeds. */
  captchaMotion: Motion;
  /** Share of flickering noise re-seeded each frame, 0..1 (0 disables it). */
  captchaSprinkle: number;
  /** Bake in a faint fake expression; answering it means an instant kick. */
  captchaDecoy: boolean;
  /** Wrong numeric answers allowed before the temporary ban. */
  captchaMaxAttempts: number;
  /** Seconds a failed newcomer remains banned. */
  captchaBanSec: number;
  /**
   * What a rendering failure means: false lets the newcomer in (the default,
   * an outage should not lock people out), true bans them for `captchaBanSec`
   * so a broken renderer cannot become a way past the captcha.
   */
  captchaFailClosed: boolean;
  /** Days a passed user is remembered; 0 keeps them forever. */
  passedTtlDays: number;
  /**
   * Seconds an update may have waited in Telegram's queue before the bot
   * ignores it. A bot that was down returns to a backlog of up to a day and
   * would greet people who joined long ago, some of them already dealt with
   * by hand. 0 disables the check.
   */
  maxUpdateAgeSec: number;
  /**
   * Digits per operand. 1 keeps the glyphs large and the arithmetic instant;
   * 2 widens the answer space from nineteen sums to about a hundred and
   * eighty, at the price of a smaller glyph and more thinking.
   */
  captchaOperandDigits: OperandDigits;
  /** Bots allowed regardless of who added them. */
  allowedBotIds: ReadonlySet<number>;
  /** Chats served by the bot; an empty set allows every chat. */
  allowedChatIds: ReadonlySet<number>;
  dataFile: string;
  /** Optional JSON file with message templates, see `Messages`. */
  messagesFile: string;
  /** ffmpeg binary path; default expects it on PATH. */
  ffmpegPath: string;
  /** Talk to Telegram's test environment instead of production. */
  telegramTestMode: boolean;
  /** Optional Bot API root, used for compatible servers such as Telegym. */
  telegramApiRoot?: string;
  /** Deterministic PRNG seed for integration tests against a custom API root. */
  captchaTestSeed?: number;
}

/**
 * Chat texts. Placeholders: %username% becomes a mention of the newcomer,
 * %timer% the allowed seconds. Templates are HTML (Telegram parse mode).
 */
export interface Messages {
  captcha: string;
  welcome: string;
}

export const DEFAULT_MESSAGES: Messages = {
  captcha:
    '%username%, prove you are human: reply with the number within %timer% seconds or say goodbye.',
  welcome: '%username%, one of us. Welcome aboard.',
};

function parseAllowedBotIds(value: string | undefined): ReadonlySet<number> {
  if (!value?.trim()) return new Set();
  const ids = new Set<number>();
  for (const item of value.split(',')) {
    const raw = item.trim();
    if (!/^\d+$/.test(raw)) {
      throw new Error('ALLOWED_BOT_IDS must be a comma-separated list of positive integers');
    }
    const id = Number(raw);
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new Error('ALLOWED_BOT_IDS must be a comma-separated list of positive integers');
    }
    ids.add(id);
  }
  return ids;
}

function parseAllowedChatIds(value: string | undefined): ReadonlySet<number> {
  if (!value?.trim()) return new Set();
  const ids = new Set<number>();
  for (const item of value.split(',')) {
    const raw = item.trim();
    if (!/^-?\d+$/.test(raw)) {
      throw new Error('ALLOWED_CHAT_IDS must be a comma-separated list of nonzero integers');
    }
    const id = Number(raw);
    if (!Number.isSafeInteger(id) || id === 0) {
      throw new Error('ALLOWED_CHAT_IDS must be a comma-separated list of nonzero integers');
    }
    ids.add(id);
  }
  return ids;
}

const DEFAULT_CAPTCHA_BAN_SEC = 300;
// Stay comfortably inside Telegram's 30-second/366-day permanent-ban cutoffs.
const MIN_TEMPORARY_BAN_SEC = 60;
const MAX_TEMPORARY_BAN_SEC = 365 * 24 * 60 * 60;

function parseCaptchaBanSec(value: string | undefined): number {
  if (value === undefined || value === '') return DEFAULT_CAPTCHA_BAN_SEC;
  if (!/^\d+$/.test(value)) {
    throw new Error('CAPTCHA_BAN_SEC must be an integer from 60 to 31536000');
  }
  const seconds = Number(value);
  if (
    !Number.isSafeInteger(seconds) ||
    seconds < MIN_TEMPORARY_BAN_SEC ||
    seconds > MAX_TEMPORARY_BAN_SEC
  ) {
    throw new Error('CAPTCHA_BAN_SEC must be an integer from 60 to 31536000');
  }
  return seconds;
}

/**
 * Long enough that a restart or a short outage still greets the newcomers it
 * missed, short enough that a day-old backlog is dropped.
 */
const DEFAULT_MAX_UPDATE_AGE_SEC = 300;

function parseMaxUpdateAgeSec(value: string | undefined): number {
  if (value === undefined || value === '') return DEFAULT_MAX_UPDATE_AGE_SEC;
  if (!/^\d+$/.test(value)) {
    throw new Error('MAX_UPDATE_AGE_SEC must be a non-negative integer');
  }
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds)) {
    throw new Error('MAX_UPDATE_AGE_SEC must be a non-negative integer');
  }
  return seconds;
}

function parsePassedTtlDays(value: string | undefined): number {
  if (value === undefined || value === '') return 0;
  if (!/^\d+$/.test(value)) {
    throw new Error('PASSED_TTL_DAYS must be a non-negative integer');
  }
  const days = Number(value);
  if (!Number.isSafeInteger(days)) {
    throw new Error('PASSED_TTL_DAYS must be a non-negative integer');
  }
  return days;
}

/** Missing file means defaults; a broken one is a loud config error. */
export function loadMessages(file: string): Messages {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return DEFAULT_MESSAGES;
  }
  const parsed = JSON.parse(raw) as Partial<Messages>;
  return {
    captcha: typeof parsed.captcha === 'string' ? parsed.captcha : DEFAULT_MESSAGES.captcha,
    welcome: typeof parsed.welcome === 'string' ? parsed.welcome : DEFAULT_MESSAGES.welcome,
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const botToken = env.BOT_TOKEN ?? '';
  if (!botToken) throw new Error('BOT_TOKEN is not set');
  const timeoutSec = Number(env.CAPTCHA_TIMEOUT_SEC);
  const telegramApiRoot = env.TELEGRAM_API_ROOT || undefined;
  let captchaTestSeed: number | undefined;
  if (env.CAPTCHA_TEST_SEED !== undefined && env.CAPTCHA_TEST_SEED !== '') {
    if (!/^\d+$/.test(env.CAPTCHA_TEST_SEED)) {
      throw new Error('CAPTCHA_TEST_SEED must be an unsigned 32-bit integer');
    }
    captchaTestSeed = Number(env.CAPTCHA_TEST_SEED);
    if (captchaTestSeed > 0xffff_ffff) {
      throw new Error('CAPTCHA_TEST_SEED must be an unsigned 32-bit integer');
    }
    if (!telegramApiRoot) {
      throw new Error('CAPTCHA_TEST_SEED requires TELEGRAM_API_ROOT');
    }
  }
  return {
    botToken,
    captchaTimeoutSec: timeoutSec > 0 ? timeoutSec : 60,
    captchaStyle:
      env.CAPTCHA_STYLE === 'g' || env.CAPTCHA_STYLE === 'dots' ? env.CAPTCHA_STYLE : 'l',
    captchaMotion: env.CAPTCHA_MOTION === '2' ? 2 : 1,
    captchaSprinkle: Math.min(1, Math.max(0, Number(env.CAPTCHA_SPRINKLE) || 0)),
    captchaDecoy: env.CAPTCHA_DECOY === 'true',
    captchaMaxAttempts:
      Number(env.CAPTCHA_MAX_ATTEMPTS) > 0 ? Math.floor(Number(env.CAPTCHA_MAX_ATTEMPTS)) : 3,
    captchaBanSec: parseCaptchaBanSec(env.CAPTCHA_BAN_SEC),
    captchaFailClosed: env.CAPTCHA_FAIL_CLOSED === 'true',
    passedTtlDays: parsePassedTtlDays(env.PASSED_TTL_DAYS),
    maxUpdateAgeSec: parseMaxUpdateAgeSec(env.MAX_UPDATE_AGE_SEC),
    captchaOperandDigits: env.CAPTCHA_OPERAND_DIGITS === '2' ? 2 : 1,
    allowedBotIds: parseAllowedBotIds(env.ALLOWED_BOT_IDS),
    allowedChatIds: parseAllowedChatIds(env.ALLOWED_CHAT_IDS),
    dataFile: env.DATA_FILE ?? 'data/state.json',
    messagesFile: env.MESSAGES_FILE ?? 'data/messages.json',
    ffmpegPath: env.FFMPEG_PATH ?? 'ffmpeg',
    telegramTestMode: env.TELEGRAM_TEST_MODE === 'true',
    telegramApiRoot,
    captchaTestSeed,
  };
}
