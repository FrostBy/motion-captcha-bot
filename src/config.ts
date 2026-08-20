import { readFileSync } from 'node:fs';

import type { Motion, Style } from './captcha.js';

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
  /** Wrong numeric answers allowed before the kick. */
  captchaMaxAttempts: number;
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
    dataFile: env.DATA_FILE ?? 'data/state.json',
    messagesFile: env.MESSAGES_FILE ?? 'data/messages.json',
    ffmpegPath: env.FFMPEG_PATH ?? 'ffmpeg',
    telegramTestMode: env.TELEGRAM_TEST_MODE === 'true',
    telegramApiRoot,
    captchaTestSeed,
  };
}
