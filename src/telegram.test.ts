import { afterEach, describe, expect, it, vi } from 'vitest';

import { MAX_RETRY_WAIT_MS, quietly, withRetry } from './telegram.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** 429 waits the announced pause, so the clock is faked to keep tests fast. */
async function withFakeTimers<T>(run: () => Promise<T>): Promise<T> {
  vi.useFakeTimers();
  const promise = run();
  // The assertion attaches its handler only after the timers run, so the
  // rejection is parked here first: otherwise it counts as unhandled.
  const parked = promise.then(
    (value) => () => value,
    (error: unknown) => () => {
      throw error;
    },
  );
  await vi.runAllTimersAsync();
  return (await parked)();
}

describe('withRetry', () => {
  it('returns the first successful result without retrying', async () => {
    const call = vi.fn(async () => 'ok');

    await expect(withRetry(call)).resolves.toBe('ok');
    expect(call).toHaveBeenCalledOnce();
  });

  it('waits out a 429 and retries', async () => {
    const call = vi
      .fn()
      .mockRejectedValueOnce({ error_code: 429, parameters: { retry_after: 2 } })
      .mockResolvedValue('sent');

    await expect(withFakeTimers(() => withRetry(call))).resolves.toBe('sent');
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('gives up after the attempt limit and rethrows the last 429', async () => {
    const tooMany = { error_code: 429, parameters: { retry_after: 1 } };
    const call = vi.fn().mockRejectedValue(tooMany);

    await expect(withFakeTimers(() => withRetry(call, 2))).rejects.toBe(tooMany);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('rethrows anything that is not a rate limit at once', async () => {
    const call = vi.fn().mockRejectedValue({ error_code: 400, description: 'Bad Request' });

    await expect(withRetry(call)).rejects.toMatchObject({ error_code: 400 });
    expect(call).toHaveBeenCalledOnce();
  });

  it('survives a rejection with a primitive reason', async () => {
    const call = vi.fn().mockRejectedValue('boom');

    await expect(withRetry(call)).rejects.toBe('boom');
    expect(call).toHaveBeenCalledOnce();
  });
});

describe('quietly', () => {
  it('swallows failures: cosmetic calls must not crash the bot', async () => {
    const call = vi.fn().mockRejectedValue(new Error('message is already gone'));

    await expect(quietly(call)).resolves.toBeUndefined();
  });

  it('still performs the call', async () => {
    const call = vi.fn(async () => 'done');

    await quietly(call);

    expect(call).toHaveBeenCalledOnce();
  });
});

describe('retry ceiling', () => {
  it('caps a huge retry_after at the ceiling', async () => {
    vi.useFakeTimers();
    const call = vi
      .fn()
      .mockRejectedValueOnce({ error_code: 429, parameters: { retry_after: 3600 } })
      .mockResolvedValue('sent');
    const promise = withRetry(call);
    const parked = promise.then(
      () => undefined,
      () => undefined,
    );

    await vi.advanceTimersByTimeAsync(MAX_RETRY_WAIT_MS);
    await parked;

    expect(call).toHaveBeenCalledTimes(2);
    await expect(promise).resolves.toBe('sent');
  });
});
