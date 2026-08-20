import { describe, expect, it } from 'vitest';

import { loadConfig } from './config.js';

describe('loadConfig', () => {
  it('leaves the Telegram API root unset by default', () => {
    expect(loadConfig({ BOT_TOKEN: '123:test' }).telegramApiRoot).toBeUndefined();
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
