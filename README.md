# motion-captcha-bot

Telegram anti-spam bot that greets newcomers with an animated math captcha readable only in motion. A single frame, or a per-pixel average of all frames, is statistically flat noise: OCR, screenshots and multimodal models see nothing, while humans read the digits effortlessly through motion perception.

Русская версия: [README.RU.md](README.RU.md)

## How it works

The expression `N+M` is rendered as two layers of noise moving relative to each other. The glyph region and the background share the same texture statistics, so the digits exist only as coherent motion, never as pixels:

- Still frame: flat noise, nothing to OCR.
- Frame averaging (pixel delay map): flat noise again.
- Human eye: reads the digits in a fraction of a second.

On top of the base mechanics there are optional shields against automated video analysis:

| Shield | What it does | What it defeats |
|---|---|---|
| Motion preset 2 | Both layers move in the same direction with different, sine-wobbling speeds | Shift-matching: contrasting `+shift` vs `-shift` match maps yields nothing, and no constant inter-frame offset exists |
| Sprinkle | Re-seeds a share of pixels with fresh noise every frame | Dirties optical-flow and match maps; the eye averages the flicker out |
| Decoy | Bakes a faint static fake expression into the field | Frame averaging reveals the fake instead of the answer, and replying with the fake sum gets an instant kick |

## Moderation rules

- A newcomer must reply with the correct number within the timeout (60 s by default), silence means a kick. Rejoining is allowed.
- Every message from a pending newcomer except the correct answer is deleted.
- Members seen before, and anyone who already passed, never get a captcha.
- Bots added by a member stay; bots that join on their own are kicked.
- If captcha rendering fails, the newcomer is let through with a loud log line, so nobody gets trapped by an infrastructure problem.

State is a JSON snapshot on disk: held in memory, flushed atomically every few seconds and on shutdown. Restarts lose nothing that matters.

## Quick start

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy the token.
2. Add the bot to your group as an administrator with "delete messages" and "ban users" permissions.
3. Create `.env` next to `docker-compose.yml`:

   ```env
   BOT_TOKEN=123456:ABC...
   ```

4. Run:

   ```sh
   docker compose up -d --build
   ```

## Configuration

Everything is configured through environment variables. No database, no admin panel.

| Variable | Default | Description |
|---|---|---|
| `BOT_TOKEN` | required | Telegram bot token |
| `CAPTCHA_TIMEOUT_SEC` | `60` | Seconds a newcomer has to answer |
| `CAPTCHA_STYLE` | `l` | Noise look: `l` for 2px bands, `g` for 1px bands, `dots` for sparse subpixel dots |
| `CAPTCHA_MOTION` | `1` | `1` moves the layers in opposite directions, `2` moves them in the same direction with wobbling speeds (anti shift-matching) |
| `CAPTCHA_SPRINKLE` | `0` | Share of pixels re-seeded with fresh noise each frame, `0..1` (e.g. `0.01`); raises analysis cost, costs readability and file size |
| `CAPTCHA_DECOY` | `false` | Bake in a faint fake expression; answering it kicks instantly |
| `CAPTCHA_MAX_ATTEMPTS` | `3` | Wrong numeric answers allowed before the kick (chatter is only deleted, not counted) |
| `ALLOWED_BOT_IDS` | unset | Comma-separated numeric bot IDs allowed regardless of who added them; other bots must be added by an administrator |
| `DATA_FILE` | `data/state.json` | State snapshot location |
| `MESSAGES_FILE` | `data/messages.json` | Optional message templates, see below |
| `FFMPEG_PATH` | `ffmpeg` | ffmpeg binary (bundled in the Docker image) |
| `TELEGRAM_TEST_MODE` | `false` | Talk to Telegram's test environment |
| `TELEGRAM_API_ROOT` | Telegram | Bot API root for compatible servers such as Telegym |
| `CAPTCHA_TEST_SEED` | unset | Deterministic PRNG seed for integration tests; requires `TELEGRAM_API_ROOT` |

## Custom messages

Drop a `messages.json` into the data directory to override the chat texts (any language you like). Placeholders: `%username%` becomes a clickable mention of the newcomer, `%timer%` the allowed seconds. Templates are Telegram HTML.

```json
{
  "captcha": "%username%, prove you are human: reply with the number within %timer% seconds or say goodbye.",
  "welcome": "%username%, one of us. Welcome aboard."
}
```

## Development

```sh
npm install
npm test          # unit tests, ffmpeg not required
npm run typecheck
BOT_TOKEN=... npm run dev
```

Rendering the animation locally requires ffmpeg on `PATH` (or `FFMPEG_PATH`).

## Acknowledgements

The dot-field mechanics are inspired by [Ghost Font](https://ghostfont.net), a motion-defined AI vision benchmark.

## License

[MIT](LICENSE)
