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
});
