import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_MESSAGES, loadConfig, loadMessages } from './config.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('loadConfig', () => {
  it('leaves the Telegram API root unset by default', () => {
    const config = loadConfig({ BOT_TOKEN: '123:test' });
    expect(config.telegramApiRoot).toBeUndefined();
    expect(config.captchaBanSec).toBe(300);
  });

  it('accepts a temporary captcha ban duration', () => {
    expect(loadConfig({ BOT_TOKEN: '123:test', CAPTCHA_BAN_SEC: '600' }).captchaBanSec).toBe(600);
  });

  it('rejects a ban duration too close to Telegram\'s permanent-ban cutoff', () => {
    expect(() => loadConfig({ BOT_TOKEN: '123:test', CAPTCHA_BAN_SEC: '30' })).toThrow(
      'CAPTCHA_BAN_SEC must be an integer from 60 to 31536000',
    );
  });

  it('accepts a comma-separated bot allowlist', () => {
    const config = loadConfig({
      BOT_TOKEN: '123:test',
      ALLOWED_BOT_IDS: '123, 456,123',
    });

    expect([...config.allowedBotIds]).toEqual([123, 456]);
  });

  it('rejects an invalid bot allowlist', () => {
    expect(() =>
      loadConfig({ BOT_TOKEN: '123:test', ALLOWED_BOT_IDS: '123,nope' }),
    ).toThrow('ALLOWED_BOT_IDS must be a comma-separated list of positive integers');
  });

  it('accepts a comma-separated chat allowlist', () => {
    const config = loadConfig({
      BOT_TOKEN: '123:test',
      ALLOWED_CHAT_IDS: '-100123, -456,-100123',
    });

    expect([...config.allowedChatIds]).toEqual([-100123, -456]);
  });

  it('allows every chat when the chat allowlist is unset', () => {
    expect(loadConfig({ BOT_TOKEN: '123:test' }).allowedChatIds.size).toBe(0);
  });

  it('rejects an invalid chat allowlist', () => {
    expect(() => loadConfig({ BOT_TOKEN: '123:test', ALLOWED_CHAT_IDS: '0,nope' })).toThrow(
      'ALLOWED_CHAT_IDS must be a comma-separated list of nonzero integers',
    );
  });

  it('accepts a compatible Telegram API server root', () => {
    expect(
      loadConfig({
        BOT_TOKEN: '123:test',
        TELEGRAM_API_ROOT: 'http://telegym.test:5678',
      }).telegramApiRoot,
    ).toBe('http://telegym.test:5678');
  });

  it('accepts a deterministic captcha seed with a custom API root', () => {
    expect(
      loadConfig({
        BOT_TOKEN: '123:test',
        TELEGRAM_API_ROOT: 'http://telegym.test:5678',
        CAPTCHA_TEST_SEED: '42',
      }).captchaTestSeed,
    ).toBe(42);
  });

  it('rejects a deterministic captcha seed against Telegram', () => {
    expect(() => loadConfig({ BOT_TOKEN: '123:test', CAPTCHA_TEST_SEED: '42' })).toThrow(
      'CAPTCHA_TEST_SEED requires TELEGRAM_API_ROOT',
    );
  });

  it('rejects an invalid deterministic captcha seed', () => {
    expect(() =>
      loadConfig({
        BOT_TOKEN: '123:test',
        TELEGRAM_API_ROOT: 'http://telegym.test:5678',
        CAPTCHA_TEST_SEED: '-1',
      }),
    ).toThrow('CAPTCHA_TEST_SEED must be an unsigned 32-bit integer');
  });
});

describe('message templates', () => {
  it('falls back to the defaults when the file is missing', () => {
    expect(loadMessages(join(tmpdir(), 'motion-captcha-no-such-file.json'))).toEqual(
      DEFAULT_MESSAGES,
    );
  });

  it('takes only the string fields, keeping defaults for the rest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'motion-captcha-messages-'));
    dirs.push(dir);
    const file = join(dir, 'messages.json');
    writeFileSync(file, JSON.stringify({ captcha: 'Solve %timer%', welcome: 42 }));

    expect(loadMessages(file)).toEqual({
      captcha: 'Solve %timer%',
      welcome: DEFAULT_MESSAGES.welcome,
    });
  });

  it('a broken file is a loud config error, not a silent default', () => {
    const dir = mkdtempSync(join(tmpdir(), 'motion-captcha-messages-'));
    dirs.push(dir);
    const file = join(dir, 'messages.json');
    writeFileSync(file, '{oops');

    expect(() => loadMessages(file)).toThrow();
  });
});

describe('failure policy and retention knobs', () => {
  it('keeps the fail-open default and no retention window', () => {
    const config = loadConfig({ BOT_TOKEN: '123:test' });

    expect(config.captchaFailClosed).toBe(false);
    expect(config.passedTtlDays).toBe(0);
  });

  it('accepts a retention window in days', () => {
    const config = loadConfig({ BOT_TOKEN: '123:test', PASSED_TTL_DAYS: '90' });

    expect(config.passedTtlDays).toBe(90);
  });

  it('rejects a retention window that is not a whole number of days', () => {
    expect(() => loadConfig({ BOT_TOKEN: '123:test', PASSED_TTL_DAYS: '7.5' })).toThrow(
      'PASSED_TTL_DAYS',
    );
  });

  it('turns the captcha into a closed door on request', () => {
    const config = loadConfig({ BOT_TOKEN: '123:test', CAPTCHA_FAIL_CLOSED: 'true' });

    expect(config.captchaFailClosed).toBe(true);
  });
});

describe('allowlist and range guards', () => {
  const cases: Array<[string, Record<string, string>, string]> = [
    ['a bot id past the safe integer range', { ALLOWED_BOT_IDS: '99999999999999999999' }, 'ALLOWED_BOT_IDS'],
    ['a zero bot id', { ALLOWED_BOT_IDS: '0' }, 'ALLOWED_BOT_IDS'],
    ['a chat id past the safe integer range', { ALLOWED_CHAT_IDS: '-99999999999999999999' }, 'ALLOWED_CHAT_IDS'],
    ['a zero chat id', { ALLOWED_CHAT_IDS: '0' }, 'ALLOWED_CHAT_IDS'],
    ['a ban shorter than the platform cutoff', { CAPTCHA_BAN_SEC: '30' }, 'CAPTCHA_BAN_SEC'],
    ['a ban longer than a year', { CAPTCHA_BAN_SEC: '40000000' }, 'CAPTCHA_BAN_SEC'],
    ['a ban that is not a number', { CAPTCHA_BAN_SEC: 'soon' }, 'CAPTCHA_BAN_SEC'],
    ['a retention window past the safe integer range', { PASSED_TTL_DAYS: '99999999999999999999' }, 'PASSED_TTL_DAYS'],
    ['a seed past 32 bits', { CAPTCHA_TEST_SEED: '4294967296', TELEGRAM_API_ROOT: 'http://127.0.0.1:5678' }, 'CAPTCHA_TEST_SEED'],
  ];

  it.each(cases)('rejects %s', (_name, env, expected) => {
    expect(() => loadConfig({ BOT_TOKEN: '123:test', ...env })).toThrow(expected);
  });

  it('an empty allowlist string still means every chat', () => {
    const config = loadConfig({ BOT_TOKEN: '123:test', ALLOWED_CHAT_IDS: '   ' });

    expect(config.allowedChatIds.size).toBe(0);
  });

  it('a missing token is refused outright', () => {
    expect(() => loadConfig({})).toThrow('BOT_TOKEN');
  });

  it('two-digit operands are opt-in', () => {
    expect(loadConfig({ BOT_TOKEN: '123:test' }).captchaOperandDigits).toBe(1);
    expect(
      loadConfig({ BOT_TOKEN: '123:test', CAPTCHA_OPERAND_DIGITS: '2' }).captchaOperandDigits,
    ).toBe(2);
  });
});
