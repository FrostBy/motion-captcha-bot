import { Bot, InputFile } from 'grammy';

import { seededRandom } from './captcha.js';
import { loadConfig, loadMessages } from './config.js';
import { createSerialGate } from './gate.js';
import { sweepExpired, type ChatApi, type Deps } from './handlers.js';
import { State } from './state.js';
import { createSweeper, registerHandlers, SWEEP_INTERVAL_MS } from './wiring.js';

const config = loadConfig();
const state = new State(config.dataFile);
state.load();
state.startFlusher();

const bot = new Bot(config.botToken, {
  client: {
    environment: config.telegramTestMode ? 'test' : 'prod',
    ...(config.telegramApiRoot ? { apiRoot: config.telegramApiRoot } : {}),
  },
});

const api: ChatApi = {
  // HTML mode: the %username% placeholder expands to a tg://user mention.
  sendAnimation: (chatId, video, caption) =>
    bot.api.sendAnimation(chatId, new InputFile(video, 'captcha.mp4'), {
      caption,
      parse_mode: 'HTML',
    }),
  sendMessage: (chatId, text) => bot.api.sendMessage(chatId, text, { parse_mode: 'HTML' }),
  deleteMessage: (chatId, messageId) => bot.api.deleteMessage(chatId, messageId),
  banChatMember: (chatId, userId, untilDate) =>
    bot.api.banChatMember(chatId, userId, untilDate === undefined ? {} : { until_date: untilDate }),
  unbanChatMember: (chatId, userId, onlyIfBanned) =>
    bot.api.unbanChatMember(
      chatId,
      userId,
      onlyIfBanned === undefined ? {} : { only_if_banned: onlyIfBanned },
    ),
  getChatMember: (chatId, userId) => bot.api.getChatMember(chatId, userId),
};

const deps: Deps = {
  api,
  state,
  timeoutSec: config.captchaTimeoutSec,
  ffmpegPath: config.ffmpegPath,
  captchaStyle: config.captchaStyle,
  captchaMotion: config.captchaMotion,
  captchaSprinkle: config.captchaSprinkle,
  captchaDecoy: config.captchaDecoy,
  captchaMaxAttempts: config.captchaMaxAttempts,
  captchaBanSec: config.captchaBanSec,
  captchaFailClosed: config.captchaFailClosed,
  passedTtlDays: config.passedTtlDays,
  captchaOperandDigits: config.captchaOperandDigits,
  allowedBotIds: config.allowedBotIds,
  allowedChatIds: config.allowedChatIds,
  messages: loadMessages(config.messagesFile),
  log: (message, extra) => console.log(new Date().toISOString(), message, extra ?? ''),
  random: config.captchaTestSeed === undefined ? undefined : seededRandom(config.captchaTestSeed),
};

const gate = createSerialGate();
registerHandlers(bot, {
  allowedChatIds: config.allowedChatIds,
  maxUpdateAgeSec: config.maxUpdateAgeSec,
  gate,
  deps,
});

const sweeper = setInterval(
  createSweeper({ gate, deps }, sweepExpired),
  SWEEP_INTERVAL_MS,
);

async function shutdown(): Promise<void> {
  clearInterval(sweeper);
  await bot.stop();
  await state.stop();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());

// Plain bot.start() handles updates strictly one at a time: captcha renders
// (25-165ms of CPU each) never overlap, and a join flood queues up instead of
// spawning parallel ffmpeg processes. The 60s answer window absorbs the lag.
void bot.start({
  // Telegram omits chat_member unless explicitly listed, no joins otherwise.
  allowed_updates: ['chat_member', 'message', 'edited_message'],
  onStart: (me) => {
    // Own id: moderation this bot performs must not read as user activity.
    deps.botId = me.id;
    deps.log(`Started @${me.username}`);
  },
});
