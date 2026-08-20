import { Bot, InputFile } from 'grammy';

import { seededRandom } from './captcha.js';
import { loadConfig, loadMessages } from './config.js';
import {
  onJoin,
  onMessage,
  onPromoted,
  onSeenInside,
  sweepExpired,
  type ChatApi,
  type Deps,
} from './handlers.js';
import { State } from './state.js';

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
  allowedBotIds: config.allowedBotIds,
  messages: loadMessages(config.messagesFile),
  log: (message, extra) => console.log(new Date().toISOString(), message, extra ?? ''),
  random: config.captchaTestSeed === undefined ? undefined : seededRandom(config.captchaTestSeed),
};

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
  if (left && !user.is_bot) onSeenInside(deps, chatId, user.id);
  // An admin stuck behind a pending captcha would be moderated forever.
  if (promoted && !user.is_bot) onPromoted(deps, chatId, user.id);
});

bot.on('message', async (ctx) => {
  if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') return;
  if (ctx.from.is_bot) return;
  await onMessage(deps, ctx.chat.id, ctx.from.id, ctx.message.message_id, ctx.message.text);
});

// A newcomer fixing a typo by editing deserves the same evaluation.
bot.on('edited_message', async (ctx) => {
  if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') return;
  if (ctx.from.is_bot) return;
  await onMessage(deps, ctx.chat.id, ctx.from.id, ctx.editedMessage.message_id, ctx.editedMessage.text);
});

bot.catch((error) => deps.log(`Update handling failed: ${error.message}`));

const SWEEP_INTERVAL_MS = 5000;
const sweeper = setInterval(() => void sweepExpired(deps), SWEEP_INTERVAL_MS);

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
  onStart: (me) => deps.log(`Started @${me.username}`),
});
