/**
 * Telegram call wrappers: a 429 waits the announced retry_after and retries,
 * while "cosmetics" (deleting messages, lifting bans) never crash the
 * process: the message may have been removed by hand before us.
 */

interface TooMany {
  parameters?: { retry_after?: number };
  error_code?: number;
}

export async function withRetry<T>(call: () => Promise<T>, attempts = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await call();
    } catch (error) {
      last = error;
      const shaped = typeof error === 'object' && error !== null ? (error as TooMany) : undefined;
      const retryAfter = shaped?.parameters?.retry_after;
      if (shaped?.error_code !== 429 || retryAfter === undefined) throw error;
      await new Promise((resolve) => setTimeout(resolve, (retryAfter + 1) * 1000));
    }
  }
  throw last;
}

export async function quietly(call: () => Promise<unknown>): Promise<void> {
  await withRetry(call).catch(() => undefined);
}
