/**
 * Telegram call wrappers: a 429 waits the announced retry_after and retries,
 * while "cosmetics" (deleting messages, lifting bans) never crash the
 * process: the message may have been removed by hand before us.
 */

interface TooMany {
  parameters?: { retry_after?: number };
  error_code?: number;
}

/**
 * Upper bound for a single 429 pause. Telegram can ask for hours after a
 * flood; blocking the only update queue for that long is worse than losing
 * one call, and the sweeper would keep piling work behind it.
 */
export const MAX_RETRY_WAIT_MS = 60_000;

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
      const waitMs = Math.min((retryAfter + 1) * 1000, MAX_RETRY_WAIT_MS);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
  throw last;
}

export async function quietly(call: () => Promise<unknown>): Promise<void> {
  await withRetry(call).catch(() => undefined);
}
